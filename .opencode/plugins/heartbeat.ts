import { tool } from "@opencode-ai/plugin"
import path from "node:path"
import * as core from "../lib/core"
import * as bb from "../lib/blackboard"
import * as pb from "../lib/postbox"
import * as wv from "../lib/wave"
import * as mg from "../lib/merge"
import * as ev from "../lib/eval"
import { gatherDigestData } from "../lib/digest"

const SERVICE = "heartbeat"
const AUTONOMY_SET = new Set<string>(core.AUTONOMY_LEVELS)

interface SessionRef {
  id: string
  updated: number
}

export const HeartbeatPlugin: any = async (ctx: any) => {
  const directory: string = ctx.directory ?? ctx.worktree ?? process.cwd()
  const client = ctx.client
  const $ = ctx.$

  const loadedKey = (globalThis as any).__heartbeat_loaded ?? new Set<string>()
  ;(globalThis as any).__heartbeat_loaded = loadedKey
  if (loadedKey.has(directory)) return {}
  loadedKey.add(directory)

  const stateDir = path.join(directory, ".opencode", "state")
  const journalFile = path.join(stateDir, "journal", "pulses.jsonl")
  const bbRoot = path.join(stateDir, "blackboard")
  const stateFile = path.join(stateDir, "heartbeat.json")
  const scratchFile = path.join(stateDir, "heartbeat.md")
  const killFile = path.join(stateDir, "kill.switch")
  const pulseLock = path.join(stateDir, "pulse.lock")
  const constitutionFile = path.join(stateDir, "constitution.json")

  const log = async (level: string, message: string, extra?: Record<string, unknown>) => {
    try {
      await client?.app?.log?.({ body: { service: SERVICE, level, message, extra } })
    } catch {}
  }

  try {
    await core.ensureDir(stateDir)
    await core.ensureDir(path.dirname(journalFile))
    await bb.ensure(bbRoot)
    if (!core.fileExists(killFile)) await writeRaw(killFile, "armed\n")
    if (!core.fileExists(stateFile)) await core.writeJsonAtomic(stateFile, core.defaultState())
    if (!core.fileExists(scratchFile)) await writeRaw(scratchFile, core.scratchTemplate())
    if (!core.fileExists(constitutionFile)) {
      await core.writeJsonAtomic(constitutionFile, {
        version: 1,
        mergeGate: { requireGreenSuite: true, requireJudgeScore: 75 },
        autonomyDefault: 1,
        pulse: { maxIntervalMin: 60, maxPulsesPerHour: 6 },
      })
    }
    const st0 = await core.readJson<core.HeartbeatState>(stateFile, core.defaultState())
    await log("info", "heartbeat armed", {
      interval: st0.interval,
      enabled: st0.enabled,
      killswitch: core.fileExists(killFile),
      state: stateFile,
    })
  } catch (e) {
    await log("error", "init failed — heartbeat disabled", { error: String(e) })
    return {}
  }

  async function writeRaw(file: string, content: string) {
    const { writeFile } = await import("node:fs/promises")
    await writeFile(file, content)
  }

  const readState = () => core.readJson<core.HeartbeatState>(stateFile, core.defaultState())
  const writeState = (s: core.HeartbeatState) => core.writeJsonAtomic(stateFile, s)

  async function currentSession(): Promise<SessionRef | null> {
    try {
      const res: any = await client.session.list()
      const sessions: any[] = res?.data ?? res ?? []
      if (!Array.isArray(sessions) || sessions.length === 0) return null
      const updatedOf = (s: any): number =>
        Number(s?.time?.updated ?? s?.updatedAt ?? s?.time?.created ?? 0) || 0
      const topLevel = sessions.filter((s) => !s?.parentID)
      const pool = topLevel.length > 0 ? topLevel : sessions
      const best = pool.reduce((a, b) => (updatedOf(b) > updatedOf(a) ? b : a))
      return best?.id ? { id: String(best.id), updated: updatedOf(best) } : null
    } catch {
      return null
    }
  }

  async function isIdle(sessionId: string): Promise<boolean> {
    try {
      const res: any = await client.session.status()
      const map = res?.data ?? res ?? {}
      const st = map[sessionId]
      if (!st) return true
      return st?.type === "idle"
    } catch {
      return true
    }
  }

  async function inject(sessionId: string, prompt: string): Promise<"tui" | "async" | null> {
    try {
      await client.tui.appendPrompt({ body: { text: "\n" + prompt } })
      await client.tui.submitPrompt()
      return "tui"
    } catch {
      const anyClient = client as any
      if (typeof anyClient?.session?.promptAsync === "function") {
        try {
          await anyClient.session.promptAsync({
            path: { id: sessionId },
            body: { parts: [{ type: "text", text: prompt }] },
          })
          return "async"
        } catch (e) {
          await log("warn", "promptAsync failed", { error: String(e) })
          return null
        }
      }
      return null
    }
  }

  function nextDueLabel(st: core.HeartbeatState): string {
    const now = Date.now()
    const due = core.dueAt(st, now, new Date(now))
    if (due === null) return "desligado"
    if (due <= now) return "no próximo tick livre"
    return core.relTime(due, now)
  }

  async function step(): Promise<void> {
    const now = Date.now()
    const nowD = new Date(now)
    if (!core.fileExists(killFile)) return

    let st = await readState()
    const today = core.dayKey(nowD)
    if (st.budget.day !== today) {
      st = { ...st, budget: { dailyPulses: st.budget.dailyPulses, usedPulses: 0, day: today } }
    }
    if (!st.enabled && st.offUntil && now >= st.offUntil) {
      st = { ...st, enabled: true, offUntil: null }
      await writeState(st)
    }

    const unseen = await pb.unseenAsks(bbRoot)
    const wakeKind: "timer" | "manual" | "worker-ask" = st.force ? "manual" : unseen.length > 0 ? "worker-ask" : "timer"
    const due = wakeKind === "timer" ? core.dueAt(st, now, nowD) : 0
    if (due === null || now < due) return

    const session = await currentSession()
    if (!session) return await log("debug", "tick skip: no-session")
    if (!(await isIdle(session.id))) return await log("debug", "tick skip: busy")
    if (session.updated && now - session.updated < core.COOLDOWN_MS) return await log("debug", "tick skip: cooldown")
    if (st.budget.usedPulses >= st.budget.dailyPulses) return await log("debug", "tick skip: budget")
    if (!(await core.acquireLock(pulseLock, 120_000, now))) return await log("debug", "tick skip: locked")

    try {
      const gathered = await gatherDigestData({
        client,
        $,
        directory,
        sessionId: session.id,
        watches: st.watches,
        scratchPath: scratchFile,
        bbRoot,
        lastFired: st.lastFired,
      })
      for (const wr of gathered.watchResults) {
        const w = st.watches.find((x) => x.id === wr.id)
        if (w) {
          w.lastCheckedAt = now
          w.lastOutput = wr.output
        }
      }
      await writeState(st)

      const prompt = core.buildPulsePrompt(wakeKind, gathered.digest, scratchFile)
      const via = await inject(session.id, prompt)
      if (!via) return

      if (wakeKind === "worker-ask" && gathered.asks.length > 0) {
        await pb.markAsksSeen(
          bbRoot,
          gathered.asks.filter((a) => !a.seen).map((a) => a.id),
        )
      }

      st = await readState()
      st.pulseCount += 1
      st.budget.usedPulses += 1
      st.lastFired = now
      st.nextWake = null
      st.force = false
      await writeState(st)

      const pulseId = core.newId("pulse")
      await core.appendJsonl(journalFile, {
        id: pulseId,
        ts: new Date(now).toISOString(),
        trigger: wakeKind,
        via,
        session: session.id,
        digestChars: gathered.digest.length,
        asks: gathered.asks.length,
      })
      lastPulseBySession.set(session.id, { pulseId, ts: now })
      if (lastPulseBySession.size > 50) {
        for (const k of Array.from(lastPulseBySession.keys()).slice(0, lastPulseBySession.size - 50)) lastPulseBySession.delete(k)
      }
      await log("info", "pulse fired", { via, session: session.id, pulseId })
    } finally {
      await core.releaseLock(pulseLock)
    }
  }

  const timer = setInterval(() => {
    void (async () => {
      try {
        await step()
      } catch (e) {
        await log("warn", "tick error", { error: String(e) })
      }
    })()
  }, core.TICK_MS)
  timer.unref?.()

    const alerted = new Set<string>()
    const lastPulseBySession = new Map<string, { pulseId: string; ts: number }>()

    function detectMarker(text: string): "OK" | "NOTIFY" | "ALERT" | null {
      const t = text.trimStart()
      if (t.startsWith("ALERT:")) return "ALERT"
      if (t.startsWith("NOTIFY:")) return "NOTIFY"
      if (t.trim() === "HEARTBEAT_OK" || t.startsWith("HEARTBEAT_OK")) return "OK"
      return null
    }

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout após ${Math.round(ms / 1000)}s`)), ms)
      t.unref?.()
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        },
      )
    })
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  async function createWorkerSession(spec: bb.Spec, bossSession: string | null): Promise<string> {
    const body: any = { title: `god:${spec.id}` }
    if (bossSession) body.parentID = bossSession
    const res: any = await client.session.create({ body })
    const id = res?.data?.id ?? res?.id
    if (!id) throw new Error("não foi possível criar sessão do worker")
    return String(id)
  }

  async function runWorker(spec: bb.Spec, bossSession: string | null, context: string): Promise<wv.WaveResultRow> {
    let session = ""
    try {
      session = await createWorkerSession(spec, bossSession)
      await bb.claimSpec(bbRoot, spec.id, session, "local", spec.timeoutSec + 60)
      await pb.addProgress(bbRoot, spec.id, session, "worker despachado", "dispatch")
      const prompt = wv.buildWorkerPrompt(spec, context)
      const res: any = await withTimeout(
        client.session.prompt({
          path: { id: session },
          body: { parts: [{ type: "text", text: prompt }], format: { type: "json_schema", schema: wv.WORKER_SCHEMA } },
        }),
        spec.timeoutSec * 1000,
      )
      const out = wv.extractStructured(res)
      if (!out) {
        const r = await bb.completeSpec(bbRoot, spec.id, {
          session,
          branch: null,
          status: "failed",
          checks: [],
          confidence: 0,
          notes: "worker terminou sem structured output",
        })
        return { spec, result: r }
      }
      const checks = out.status === "done" ? await runAcceptance(spec) : []
      const cost = await sessionCost(session)
      const r = await bb.completeSpec(bbRoot, spec.id, {
        session,
        branch: null,
        status: out.status,
        checks,
        confidence: out.confidence,
        notes: out.notes,
        cost: cost.cost,
        tokensIn: cost.tokensIn,
        tokensOut: cost.tokensOut,
      })
      return { spec, result: r }
    } catch (e) {
      if (session) await client.session.abort({ path: { id: session } }).catch(() => {})
      const msg = String((e as Error)?.message ?? e)
      const r = await bb.completeSpec(bbRoot, spec.id, {
        session,
        branch: null,
        status: msg.includes("timeout") ? "timeout" : "failed",
        checks: [],
        confidence: 0,
        notes: msg,
      })
      return { spec, result: r }
    }
  }

  async function runWave(waveId: string): Promise<string> {
    const wave = await bb.getWave(bbRoot, waveId)
    if (!wave) return `onda não encontrada: ${waveId}`
    const specs = (await bb.listSpecs(bbRoot)).filter((s) => s.wave === waveId && s.status === "open")
    if (specs.length === 0) return `sem specs abertos na onda ${waveId}`
    await bb.saveWave(bbRoot, { ...wave, status: "running" })
    await log("info", "wave dispatch", { wave: waveId, specs: specs.length })
    const session = await currentSession()
    const learnings = (await bb.listLearnings(bbRoot))
      .slice(0, 8)
      .map((l) => `- [${l.kind}] ${l.text}`)
      .join("\n")
    const rows = await Promise.all(specs.map((sp) => runWorker(sp, session?.id ?? null, learnings)))
    const w = await bb.getWave(bbRoot, waveId)
    if (w) await bb.saveWave(bbRoot, { ...w, status: "closed" })
    await pb.gcAsks(bbRoot, 30 * 60_000)
    return wv.buildWaveSummary(rows)
  }

  async function latestOpenWave(): Promise<string | null> {
    const p = bb.paths(bbRoot).waves
    const { readdir } = await import("node:fs/promises")
    const files = (await readdir(p).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))
    let latest: bb.Wave | null = null
    for (const f of files) {
      const w = await bb.getWave(bbRoot, f.replace(".json", ""))
      if (w && w.status === "open" && (!latest || w.createdAt > latest.createdAt)) latest = w
    }
    return latest?.id ?? null
  }

  async function runShellCmd(cmd: string, timeoutMs = 120_000): Promise<{ passed: boolean; output: string }> {
    try {
      const proc: any = await withTimeout($`sh -c ${cmd}`.cwd(directory).quiet() as any, timeoutMs)
      const out = `${(proc?.stdout ?? "").toString().trim()}\n${(proc?.stderr ?? "").toString().trim()}`.trim()
      return { passed: (proc?.exitCode ?? 1) === 0, output: out }
    } catch (e) {
      const msg = String((e as Error)?.message ?? e)
      return { passed: false, output: msg.includes("timeout") ? `timeout após ${Math.round(timeoutMs / 1000)}s` : msg }
    }
  }

  async function runAcceptance(spec: bb.Spec): Promise<bb.CheckOutcome[]> {
    const out: bb.CheckOutcome[] = []
    for (const cmd of spec.acceptance) {
      const r = await runShellCmd(cmd)
      out.push({ cmd, passed: r.passed, output: r.output })
    }
    return out
  }

  async function sessionCost(sessionId: string): Promise<{ cost: number; tokensIn: number; tokensOut: number }> {
    try {
      const res: any = await client.session.get({ path: { id: sessionId } })
      const info = res?.data?.info ?? res?.info ?? res?.data ?? {}
      return {
        cost: Number(info?.cost ?? 0) || 0,
        tokensIn: Number(info?.tokens?.input ?? 0) || 0,
        tokensOut: Number(info?.tokens?.output ?? 0) || 0,
      }
    } catch {
      return { cost: 0, tokensIn: 0, tokensOut: 0 }
    }
  }

  async function runJudge(spec: bb.Spec, result: bb.Result, judgeIndex: number, totalJudges: number): Promise<ev.JudgeVerdict | null> {
    let session = ""
    try {
      const judgeSpec: bb.Spec = { ...spec, id: spec.id, role: "judge", title: `god:judge-${judgeIndex + 1}:${spec.id}` }
      session = await createWorkerSession(judgeSpec, (await currentSession())?.id ?? null)
      const prompt = ev.buildJudgePrompt(spec, result, judgeIndex, totalJudges)
      const res: any = await withTimeout(
        client.session.prompt({
          path: { id: session },
          body: { parts: [{ type: "text", text: prompt }], format: { type: "json_schema", schema: ev.JUDGE_SCHEMA } },
        }),
        180_000,
      )
      return ev.extractVerdict(res)
    } catch (e) {
      if (session) await client.session.abort({ path: { id: session } }).catch(() => {})
      await log("warn", "judge failed", { spec: spec.id, judge: judgeIndex + 1, error: String(e) })
      return null
    }
  }

  async function buildWaveStats(): Promise<ev.WaveStat[]> {
    const waves = await (async () => {
      const p = bb.paths(bbRoot).waves
      const { readdir } = await import("node:fs/promises")
      const files = (await readdir(p).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))
      return (await Promise.all(files.map((f) => bb.getWave(bbRoot, f.replace(".json", ""))))).filter(Boolean) as bb.Wave[]
    })()
    const specs = await bb.listSpecs(bbRoot)
    const stats: ev.WaveStat[] = []
    for (const w of waves) {
      const waveSpecs = specs.filter((s) => s.wave === w.id)
      let done = 0
      let failed = 0
      let confSum = 0
      let confN = 0
      let cost = 0
      for (const s of waveSpecs) {
        const r = await bb.getResult(bbRoot, s.id)
        if (r?.status === "done") {
          done++
          confSum += r.confidence
          confN++
        } else if (r) failed++
        cost += r?.cost ?? 0
      }
      stats.push({
        id: w.id,
        objective: w.objective,
        status: w.status,
        specs: waveSpecs.length,
        done,
        failed,
        avgConfidence: confN > 0 ? confSum / confN : 0,
        cost,
      })
    }
    return stats.sort((a, b) => b.id.localeCompare(a.id)).slice(0, 10)
  }

  return {
    tool: {
      heartbeat_on: tool({
        description:
          "Liga o heartbeat (pulso automático periódico nesta sessão). Intervalo opcional no formato 5m, 10m, 1h (mínimo 2m, máximo 1h).",
        args: { interval: tool.schema.string().optional() },
        async execute(args: any) {
          const st = await readState()
          if (args.interval) {
            const clamped = core.clampInterval(String(args.interval))
            if (!clamped) return `Intervalo inválido: ${args.interval}. Use ex: 2m, 10m, 1h.`
            st.interval = clamped
          }
          st.enabled = true
          st.offUntil = null
          await writeState(st)
          return `Heartbeat LIGADO. Intervalo: ${st.interval}. Próximo pulso: ${nextDueLabel(st)}.`
        },
      }),
      heartbeat_off: tool({
        description:
          "Desliga o heartbeat. Com duração (ex: 30m, 2h) vira pausa temporária que volta sozinha; sem duração fica desligado até heartbeat_on.",
        args: { duration: tool.schema.string().optional() },
        async execute(args: any) {
          const st = await readState()
          const ms = core.parseDuration(args.duration ? String(args.duration) : null)
          if (args.duration && ms === null) return `Duração inválida: ${args.duration}. Use ex: 30m, 2h.`
          if (ms !== null) {
            st.enabled = false
            st.offUntil = Date.now() + ms
          } else {
            st.enabled = false
            st.offUntil = null
          }
          await writeState(st)
          return ms !== null
            ? `Heartbeat PAUSADO por ${core.formatDuration(ms)} (retoma automaticamente).`
            : "Heartbeat DESLIGADO (sem retomada automática)."
        },
      }),
      heartbeat_status: tool({
        description: "Mostra o estado atual do heartbeat: ligado/desligado, intervalo, pausas, watches e últimos pulsos.",
        args: {},
        async execute() {
          const st = await readState()
          const tail = await core.readTailLines(journalFile, 5)
          const pulses = tail
            .map((l) => {
              try {
                return JSON.parse(l) as any
              } catch {
                return null
              }
            })
            .filter(Boolean)
          const activeWatches = st.watches.filter((w) => w.status === "active")
          const lines = [
            `enabled: ${st.enabled ? "SIM" : "NÃO"}`,
            `interval: ${st.interval}`,
            `offUntil: ${st.offUntil ? new Date(st.offUntil).toLocaleTimeString() : "—"}`,
            `lastFired: ${core.relTime(st.lastFired, Date.now())}`,
            `próximo: ${nextDueLabel(st)}`,
            `pulsos hoje: ${st.budget.usedPulses}/${st.budget.dailyPulses} (total ${st.pulseCount})`,
            `activeHours: ${st.activeHours ? `${st.activeHours.start}–${st.activeHours.end}` : "sempre"}`,
            `watches ativos: ${activeWatches.length}`,
            `kill.switch: ${core.fileExists(killFile) ? "armado" : "REMOVIDO (tudo parado)"}`,
          ]
          for (const w of activeWatches) {
            lines.push(
              `  - [${w.id}] ${w.goal} (${w.autonomy}, check: ${w.check}) — última checagem ${core.relTime(w.lastCheckedAt, Date.now())}`,
            )
          }
          if (pulses.length > 0) {
            lines.push("últimos pulsos:")
            for (const p of pulses.slice(-5)) {
              lines.push(`  - ${p.ts} via ${p.via}`)
            }
          }
          return lines.join("\n")
        },
      }),
      heartbeat_now: tool({
        description: "Enfileira um pulso imediato do heartbeat (dispara no próximo tick em que a sessão estiver livre).",
        args: { reason: tool.schema.string().optional() },
        async execute(args: any) {
          const st = await readState()
          st.force = true
          await writeState(st)
          return `Pulso enfileirado (motivo: ${args.reason ?? "solicitado"}). Dispara assim que a sessão estiver livre.`
        },
      }),
      heartbeat_interval: tool({
        description: "Muda a cadência do heartbeat (2m–1h). Ex: 5m para monitorar de perto, 30m para pouso.",
        args: { value: tool.schema.string() },
        async execute(args: any) {
          const clamped = core.clampInterval(String(args.value))
          if (!clamped) return `Intervalo inválido: ${args.value}. Use ex: 2m, 10m, 1h.`
          const st = await readState()
          st.interval = clamped
          await writeState(st)
          return `Intervalo alterado para ${clamped}. Próximo pulso: ${nextDueLabel(st)}.`
        },
      }),
      heartbeat_watch: tool({
        description:
          "Registra um watch (objetivo monitorado pelo pulso). 'check' é um comando shell cuja saída entra no digest a cada pulso. Autonomia L0 (observar) a L3 (agir sozinho).",
        args: {
          goal: tool.schema.string(),
          check: tool.schema.string(),
          autonomy: tool.schema.string().optional(),
          expires_in: tool.schema.string().optional(),
        },
        async execute(args: any) {
          const autonomy = (AUTONOMY_SET.has(String(args.autonomy)) ? String(args.autonomy) : "L0") as core.AutonomyLevel
          const ttlMs = args.expires_in ? core.parseDuration(String(args.expires_in)) : null
          const st = await readState()
          const watch: core.Watch = {
            id: core.newId("w"),
            goal: String(args.goal),
            check: String(args.check),
            autonomy,
            status: "active",
            expiresAt: ttlMs ? Date.now() + ttlMs : null,
            createdAt: Date.now(),
            lastCheckedAt: null,
            lastOutput: null,
          }
          st.watches.push(watch)
          await writeState(st)
          return `Watch ${watch.id} registrado: "${watch.goal}" (check: \`${watch.check}\`, autonomia ${watch.autonomy}). Entra no digest no próximo pulso.`
        },
      }),
      heartbeat_unwatch: tool({
        description: "Encerra um watch pelo id (ex: w-abc123).",
        args: { id: tool.schema.string() },
        async execute(args: any) {
          const st = await readState()
          const w = st.watches.find((x) => x.id === String(args.id))
          if (!w) return `Watch não encontrado: ${args.id}.`
          w.status = "done"
          await writeState(st)
          return `Watch ${w.id} encerrado.`
        },
      }),
      god_board: tool({
        description: "Inspeciona o blackboard da frota (specs, ondas, learnings). Escopo: specs|waves|learnings|all.",
        args: { scope: tool.schema.string().optional() },
        async execute(args: any) {
          const scope = String(args.scope ?? "all").toLowerCase()
          const lines: string[] = []
          if (scope === "all" || scope === "specs") {
            const specs = await bb.listSpecs(bbRoot)
            const open = specs.filter((s) => s.status === "open")
            lines.push(`specs: ${specs.length} (${open.length} abertos)`)
            for (const s of open.slice(0, 10)) lines.push(`  - [${s.id}] (${s.role}) ${s.title}`)
          }
          if (scope === "all" || scope === "waves") {
            let waves: bb.Wave[] = []
            try {
              const p = bb.paths(bbRoot).waves
              const { readdir } = await import("node:fs/promises")
              const files = (await readdir(p).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))
              waves = (await Promise.all(files.map((f) => bb.getWave(bbRoot, f.replace(".json", ""))))).filter(
                Boolean,
              ) as bb.Wave[]
            } catch {}
            lines.push(`waves: ${waves.length}`)
            for (const w of waves.slice(0, 10)) lines.push(`  - [${w.id}] ${w.objective} (${w.status})`)
          }
          if (scope === "all" || scope === "learnings") {
            const learns = await bb.listLearnings(bbRoot)
            lines.push(`learnings: ${learns.length}`)
            for (const l of learns.slice(0, 10)) lines.push(`  - [${l.kind}] ${l.text}`)
          }
          return lines.length > 0 ? lines.join("\n") : "blackboard vazio (populate em F2 com o wave runner)."
        },
      }),
      god_learn: tool({
        description:
          "Registra um learning persistente (regra/estratégia que muda pulsos e ondas futuras). kind: strategy|ignore|prompt.",
        args: { text: tool.schema.string(), kind: tool.schema.string().optional() },
        async execute(args: any) {
          const kind = (["strategy", "ignore", "prompt"].includes(String(args.kind))
            ? String(args.kind)
            : "strategy") as bb.LearningKind
          const l = await bb.addLearning(bbRoot, { kind, text: String(args.text), source: "user", weight: 1 })
          return `Learning registrado: [${l.kind}] ${l.text}`
        },
      }),
      god_wave_create: tool({
        description:
          "Cria uma onda (wave) de trabalho paralelo. 'specs' é um JSON array: [{\"title\":\"...\",\"role\":\"implementer\",\"files\":[\"src/a.ts\"],\"acceptance\":[\"bun test\"]}]. Crie specs disjuntas (arquivos que não se sobrepõem).",
        args: {
          objective: tool.schema.string(),
          specs: tool.schema.string(),
          burst_window_sec: tool.schema.number().optional(),
          timebox_min: tool.schema.number().optional(),
        },
        async execute(args: any) {
          let parsed: any[] = []
          try {
            parsed = JSON.parse(String(args.specs))
          } catch {
            return "specs inválidas: passe um JSON array. Ex: [{\"title\":\"...\",\"acceptance\":[\"bun test\"]}]"
          }
          if (!Array.isArray(parsed) || parsed.length === 0) return "specs vazio ou não é array"
          const wave = await bb.createWave(bbRoot, {
            objective: String(args.objective),
            composition: { implementer: parsed.length },
            burstWindowSec: Number(args.burst_window_sec ?? 120),
            budgetTokens: parsed.length * 300_000,
            timeboxMin: Number(args.timebox_min ?? 30),
            gate: "merge-queue",
          })
          const created: bb.Spec[] = []
          for (const s of parsed) {
            created.push(
              await bb.createSpec(bbRoot, {
                title: String(s.title ?? "sem título"),
                wave: wave.id,
                role: String(s.role ?? "implementer"),
                files: Array.isArray(s.files) ? s.files.map(String) : [],
                acceptance: Array.isArray(s.acceptance) ? s.acceptance.map(String) : [],
              }),
            )
          }
          return [
            `Onda ${wave.id} criada (${created.length} specs): ${args.objective}`,
            ...created.map((c) => `- [${c.id}] ${c.title}`),
            "Despache com god_wave_run.",
          ].join("\n")
        },
      }),
      god_wave_run: tool({
        description:
          "Despacha e executa a onda: cria sessões workers filhas, roda em paralelo (rajada), coleta resultados estruturados no blackboard. Bloqueia até a onda terminar ou dar timeout.",
        args: { wave_id: tool.schema.string().optional() },
        async execute(args: any) {
          const waveId = args.wave_id ? String(args.wave_id) : await latestOpenWave()
          if (!waveId) return "nenhuma onda aberta. Crie uma com god_wave_create."
          return await runWave(waveId)
        },
      }),
      god_merge: tool({
        description:
          "Portão de merge: decide merge/retry/escalate para um spec concluído conforme a constituição (suíte verde, verdicts). Sem spec_id, usa o primeiro 'done' com resultado.",
        args: { spec_id: tool.schema.string().optional() },
        async execute(args: any) {
          const cons = await core.readJson<any>(constitutionFile, {})
          const gate = mg.gateFromConstitution(cons)
          let specId = args.spec_id ? String(args.spec_id) : null
          if (!specId) {
            const done = await bb.listSpecs(bbRoot, "done")
            for (const s of done) {
              if (await bb.getResult(bbRoot, s.id)) {
                specId = s.id
                break
              }
            }
          }
          if (!specId) return "nenhum spec 'done' com resultado para o portão"
          const spec = await bb.getSpec(bbRoot, specId)
          const result = await bb.getResult(bbRoot, specId)
          if (!spec) return `spec não encontrada: ${specId}`
          const verdicts = await bb.listVerdicts(bbRoot, specId)
          const d = mg.decideMerge(spec, result, verdicts, gate)
          return `PORTÃO [${specId}]: ${d.decision.toUpperCase()} — ${d.reason}\n${mg.gitlessNotice()}`
        },
      }),
      god_answer: tool({
        description: "Responde uma ask de worker (desbloqueia a tool ask_boss dele imediatamente). Veja os asks no digest/pulso.",
        args: { ask_id: tool.schema.string(), answer: tool.schema.string() },
        async execute(args: any) {
          const a = await pb.answerAsk(bbRoot, String(args.ask_id), String(args.answer))
          return a ? `resposta entregue em ${a.id}` : `ask não encontrada: ${args.ask_id}`
        },
      }),
      god_steer: tool({
        description:
          "Envia instrução ao worker de um spec: entra na fila da sessão do worker e é processada no próximo turno dele. Use quando o worker divergir ou precisar de correção de rota.",
        args: { spec_id: tool.schema.string(), instruction: tool.schema.string() },
        async execute(args: any) {
          const specId = String(args.spec_id)
          let session: string | null = (await bb.getClaim(bbRoot, specId))?.session ?? null
          if (!session) session = (await bb.getResult(bbRoot, specId))?.session ?? null
          if (!session) return `worker não encontrado para spec ${specId}`
          const rec = await pb.recordSteer(bbRoot, {
            spec: specId,
            session,
            instruction: String(args.instruction),
            status: "queued",
            deliveredAt: null,
            error: null,
          })
          try {
            await (client.session as any).promptAsync({
              path: { id: session },
              body: { parts: [{ type: "text", text: `STEER (boss): ${args.instruction}` }] },
            })
            await pb.updateSteer(bbRoot, { ...rec, status: "delivered", deliveredAt: Date.now() })
            return `steer ${rec.id} entregue ao worker (${session}) — processa no próximo turno dele`
          } catch (e) {
            await pb.updateSteer(bbRoot, { ...rec, status: "failed", error: String(e) })
            return `falha ao entregar steer: ${String(e)}`
          }
        },
      }),
      god_eval: tool({
        description:
          "Roda (ou re-roda) os critérios de aceitação executáveis de um spec e grava os checks no result. O runner é neutro: quem decide que terminou é a suíte, não o worker.",
        args: { spec_id: tool.schema.string() },
        async execute(args: any) {
          const specId = String(args.spec_id)
          const spec = await bb.getSpec(bbRoot, specId)
          const result = await bb.getResult(bbRoot, specId)
          if (!spec || !result) return `spec/result não encontrados: ${specId}`
          if (spec.acceptance.length === 0) return "spec sem critérios de aceitação executáveis"
          const checks = await runAcceptance(spec)
          const p = bb.paths(bbRoot).results
          await core.writeJsonAtomic(path.join(p, specId + ".json"), { ...result, checks })
          return `checks de ${specId}:\n  ${ev.formatChecks(checks)}`
        },
      }),
      god_judge: tool({
        description:
          "Convoca k judges (sessões filhas) para VERIFICAR o resultado de um spec (rodando os critérios eles mesmos), grava verdicts e retorna a decisão do portão.",
        args: { spec_id: tool.schema.string(), judges: tool.schema.number().optional() },
        async execute(args: any) {
          const specId = String(args.spec_id)
          const spec = await bb.getSpec(bbRoot, specId)
          const result = await bb.getResult(bbRoot, specId)
          if (!spec || !result) return `spec/result não encontrados: ${specId}`
          const k = Math.min(Math.max(Number(args.judges ?? 2) || 2, 1), 5)
          const outcomes = await Promise.all(Array.from({ length: k }, (_, i) => runJudge(spec, result, i, k)))
          const lines: string[] = []
          for (let i = 0; i < outcomes.length; i++) {
            const v = outcomes[i]
            if (v) {
              await bb.addVerdict(bbRoot, {
                spec: specId,
                judge: `j${i + 1}`,
                verdict: v.verdict,
                score: v.score,
                reasons: v.reasons,
                createdAt: Date.now(),
              })
              lines.push(`judge ${i + 1}/${k}: ${v.verdict.toUpperCase()} (${v.score}) — ${core.truncate(v.reasons.join("; "), 120)}`)
            } else {
              lines.push(`judge ${i + 1}/${k}: FALHOU (sem verdict)`)
            }
          }
          const verdicts = await bb.listVerdicts(bbRoot, specId)
          const cons = await core.readJson<any>(constitutionFile, {})
          const gate = mg.gateFromConstitution(cons)
          const decision = mg.decideMerge(spec, result, verdicts, gate)
          return `${lines.join("\n")}\nPORTÃO [${specId}]: ${decision.decision.toUpperCase()} — ${decision.reason}`
        },
      }),
      god_report: tool({
        description:
          "Relatório meta-eval completo: ondas (done rate, confiança média, custo), pulsos (triggers e utilidade OK/NOTIFY/ALERT), asks, steers e learnings.",
        args: {},
        async execute() {
          const journal = (await core.readTailLines(journalFile, 500)).map((l) => {
            try {
              return JSON.parse(l)
            } catch {
              return null
            }
          })
          const waves = await buildWaveStats()
          const specs = await bb.listSpecs(bbRoot)
          const asks = await pb.listAsks(bbRoot)
          const steers = await pb.listSteers(bbRoot)
          const learnings = await bb.listLearnings(bbRoot)
          const board: ev.BoardStats = {
            specs: {
              open: specs.filter((s) => s.status === "open").length,
              claimed: specs.filter((s) => s.status === "claimed").length,
              done: specs.filter((s) => s.status === "done").length,
              failed: specs.filter((s) => s.status === "failed").length,
            },
            asks: {
              pending: asks.filter((a) => a.status === "pending").length,
              answered: asks.filter((a) => a.status === "answered").length,
              expired: asks.filter((a) => a.status === "expired").length,
            },
            learnings: learnings.length,
            steers: {
              delivered: steers.filter((s) => s.status === "delivered").length,
              failed: steers.filter((s) => s.status === "failed").length,
            },
          }
          return ev.formatReport(waves, ev.pulseStats(journal), board)
        },
      }),
      report_progress: tool({
        description: "Reporta progresso desta spec ao boss (fica no blackboard e entra no digest do próximo pulso).",
        args: { text: tool.schema.string(), status: tool.schema.string().optional() },
        async execute(args: any, tctx: any) {
          const sessionId = String(tctx?.sessionID ?? "unknown")
          const specId = (await pb.findSpecBySession(bbRoot, sessionId)) ?? sessionId
          await pb.addProgress(bbRoot, specId, sessionId, String(args.text), args.status ? String(args.status) : undefined)
          return "progresso registrado."
        },
      }),
      ask_boss: tool({
        description:
          "Faz uma pergunta ao boss e ESPERA (bloqueia até god_answer ou timeout). 'options' separadas por '|'. No timeout: siga com melhor julgamento no nível L0 e registre com report_progress.",
        args: {
          question: tool.schema.string(),
          options: tool.schema.string().optional(),
          timeout_sec: tool.schema.number().optional(),
        },
        async execute(args: any, tctx: any) {
          const sessionId = String(tctx?.sessionID ?? "unknown")
          const specId = (await pb.findSpecBySession(bbRoot, sessionId)) ?? null
          const options = String(args.options ?? "")
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean)
          const ask = await pb.createAsk(bbRoot, {
            spec: specId,
            session: sessionId,
            question: String(args.question),
            options,
          })
          const timeoutSec = Number(args.timeout_sec ?? 120) || 120
          const deadline = Date.now() + timeoutSec * 1000
          while (Date.now() < deadline) {
            const cur = await pb.getAsk(bbRoot, ask.id)
            if (cur?.status === "answered") return `BOSS respondeu: ${cur.answer}`
            await sleep(3000)
          }
          await pb.expireAsk(bbRoot, ask.id)
          return "BOSS indisponível (timeout). Fallback: siga com seu melhor julgamento no nível L0 e registre a decisão com report_progress."
        },
      }),
    },
    event: async ({ event }: any) => {
      try {
        const e = event ?? {}
        if (typeof e.type !== "string" || !e.type.startsWith("message.")) return
        const p = e.properties ?? {}
        const part = p?.part ?? p?.parts?.[0]
        if (!part || part.type !== "text" || typeof part.text !== "string") return
        const role = p?.info?.role ?? p?.message?.info?.role
        if (role && role !== "assistant") return
        const sessionId = String(p?.sessionID ?? p?.info?.sessionID ?? p?.message?.info?.sessionID ?? "")
        const marker = detectMarker(part.text)
        if (!marker) return
        const mid = String(p?.messageID ?? p?.message?.info?.id ?? part.text.slice(0, 32))
        if (alerted.has(mid)) return
        alerted.add(mid)
        if (alerted.size > 500) alerted.clear()
        const pulse = sessionId ? lastPulseBySession.get(sessionId) : undefined
        if (pulse && Date.now() - pulse.ts < 30 * 60_000) {
          await core.appendJsonl(journalFile, {
            ts: new Date().toISOString(),
            type: "pulse.outcome",
            pulseId: pulse.pulseId,
            session: sessionId,
            marker,
          })
          lastPulseBySession.delete(sessionId)
        }
        if (marker === "ALERT") {
          await client.tui.showToast({
            body: { title: "🫀 ALERT heartbeat", message: part.text.trim().slice(0, 140), variant: "warning" },
          })
        }
      } catch {}
    },
  }
}
