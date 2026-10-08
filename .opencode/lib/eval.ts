import type { CheckOutcome, Result, Spec } from "./blackboard"

export const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["accept", "revise", "reject"] },
    score: { type: "number", description: "0-100" },
    reasons: { type: "array", items: { type: "string" } },
    checks: {
      type: "array",
      items: {
        type: "object",
        properties: { cmd: { type: "string" }, passed: { type: "boolean" } },
        required: ["cmd", "passed"],
      },
    },
  },
  required: ["verdict", "score", "reasons"],
} as const

export interface JudgeVerdict {
  verdict: "accept" | "revise" | "reject"
  score: number
  reasons: string[]
  checks: { cmd: string; passed: boolean }[]
}

export function buildJudgePrompt(spec: Spec, result: Result, judgeIndex: number, totalJudges: number): string {
  const checks = result.checks.length > 0 ? formatChecks(result.checks) : "(nenhum check registrado pelo runner)"
  return [
    `Você é o judge ${judgeIndex + 1}/${totalJudges} da frota god-mode. Sua função é VERIFICAR, não confiar.`,
    "",
    "## Spec",
    `id: ${spec.id} | título: ${spec.title}`,
    spec.files.length > 0 ? `Arquivos: ${spec.files.join(", ")}` : "Arquivos: livre",
    spec.acceptance.length > 0 ? ["Critérios de aceite executáveis:", ...spec.acceptance.map((a) => `- ${a}`)].join("\n") : "Critérios de aceite: (nenhum)",
    "",
    "## Result do worker",
    `status: ${result.status} | confiança: ${(result.confidence * 100).toFixed(0)}%`,
    `checks do runner: ${checks}`,
    `notas do worker: ${result.notes || "(vazio)"}`,
    "",
    "## Regras do judge",
    "- Rode VOCÊ MESMO os critérios de aceitação executáveis (bash) e confirme cada um.",
    "- Desconfie do notes do worker: verifique o que for verificável.",
    "- Se não houver critérios executáveis, julgue pela evidência disponível com score conservador.",
    "- Beleza não aceita: um worker que 'achou que terminou' é revise, não accept.",
    "- Score 0-100: 100 = verificado e impecável; 60-79 = precisa de ajuste; <60 = rejeite.",
    "- Retorne via StructuredOutput: verdict, score, reasons (array), checks (o que você rodou).",
  ].join("\n")
}

export function extractVerdict(res: any): JudgeVerdict | null {
  const direct =
    res?.data?.info?.structured ?? res?.info?.structured ?? res?.data?.info?.structured_output ?? res?.info?.structured_output
  if (direct && typeof direct === "object") return normalizeVerdict(direct)
  const parts: any[] = res?.data?.parts ?? res?.parts ?? []
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p?.type === "tool" && p?.tool === "StructuredOutput") {
      const inp = p?.state?.input ?? p?.state?.output
      if (inp && typeof inp === "object") return normalizeVerdict(inp)
    }
    if (p?.type === "text" && typeof p.text === "string") {
      const text = p.text.trim()
      if (!text.startsWith("{")) continue
      try {
        return normalizeVerdict(JSON.parse(text))
      } catch {
        continue
      }
    }
  }
  return null
}

function normalizeVerdict(raw: any): JudgeVerdict | null {
  if (!raw || typeof raw !== "object") return null
  const verdict = raw.verdict === "accept" || raw.verdict === "revise" || raw.verdict === "reject" ? raw.verdict : "revise"
  const score = Math.min(Math.max(Number.isFinite(Number(raw.score)) ? Number(raw.score) : 0, 0), 100)
  return {
    verdict,
    score,
    reasons: Array.isArray(raw.reasons) ? raw.reasons.map(String) : [],
    checks: Array.isArray(raw.checks)
      ? raw.checks.filter((c: any) => c && typeof c.cmd === "string" && typeof c.passed === "boolean").map((c: any) => ({ cmd: c.cmd, passed: c.passed }))
      : [],
  }
}

export function formatChecks(checks: CheckOutcome[]): string {
  if (checks.length === 0) return "(vazio)"
  return checks
    .map((c) => `${c.passed ? "✓" : "✗"} ${c.cmd}${c.output ? ` — ${c.output.replace(/\n+/g, " | ").slice(0, 120)}` : ""}`)
    .join("\n  ")
}

export interface PulseFiredEntry {
  id?: string
  ts: string
  trigger: string
  via: string
  session: string
}

export interface PulseOutcomeEntry {
  type: "pulse.outcome"
  ts: string
  pulseId: string
  session: string
  marker: "OK" | "NOTIFY" | "ALERT"
}

export interface PulseStats {
  fired: number
  byTrigger: Record<string, number>
  outcomes: { ok: number; notify: number; alert: number; unanswered: number }
}

export function pulseStats(entries: unknown[]): PulseStats {
  const stats: PulseStats = {
    fired: 0,
    byTrigger: {},
    outcomes: { ok: 0, notify: 0, alert: 0, unanswered: 0 },
  }
  const outcomesByPulse = new Map<string, PulseOutcomeEntry["marker"]>()
  const firedPulses = new Map<string, PulseFiredEntry>()
  for (const raw of entries) {
    const e = raw as any
    if (!e || typeof e !== "object") continue
    if (e?.type === "pulse.outcome" && e.pulseId) {
      outcomesByPulse.set(String(e.pulseId), e.marker)
      continue
    }
    if (e?.trigger && e?.session) {
      stats.fired++
      stats.byTrigger[e.trigger] = (stats.byTrigger[e.trigger] ?? 0) + 1
      firedPulses.set(String(e.id ?? `${e.ts}-${e.session}-${stats.fired}`), e as PulseFiredEntry)
    }
  }
  for (const pulseId of firedPulses.keys()) {
    const marker = outcomesByPulse.get(pulseId)
    if (marker === "OK") stats.outcomes.ok++
    else if (marker === "NOTIFY") stats.outcomes.notify++
    else if (marker === "ALERT") stats.outcomes.alert++
    else stats.outcomes.unanswered++
  }
  return stats
}

export interface WaveStat {
  id: string
  objective: string
  status: string
  specs: number
  done: number
  failed: number
  avgConfidence: number
  cost: number
}

export interface BoardStats {
  specs: { open: number; claimed: number; done: number; failed: number }
  asks: { pending: number; answered: number; expired: number }
  learnings: number
  steers: { delivered: number; failed: number }
}

export function formatReport(waves: WaveStat[], pulses: PulseStats, board: BoardStats): string {
  const lines: string[] = []
  lines.push("# Relatório meta-eval do god mode")
  lines.push("")
  lines.push("## Ondas")
  if (waves.length === 0) lines.push("(nenhuma onda)")
  for (const w of waves) {
    const rate = w.specs > 0 ? Math.round((w.done / w.specs) * 100) : 0
    lines.push(`- [${w.id}] ${w.objective} (${w.status}) — ${w.done}/${w.specs} done (${rate}%), conf média ${(w.avgConfidence * 100).toFixed(0)}%, custo ~$${w.cost.toFixed(4)}`)
  }
  lines.push("")
  lines.push(`## Pulsos: ${pulses.fired} disparados`)
  const triggers = Object.entries(pulses.byTrigger)
    .map(([t, n]) => `${t}: ${n}`)
    .join(", ")
  lines.push(`- por trigger: ${triggers || "—"}`)
  lines.push(
    `- resultados: OK silencioso ${pulses.outcomes.ok} · NOTIFY ${pulses.outcomes.notify} · ALERT ${pulses.outcomes.alert} · sem resposta registrada ${pulses.outcomes.unanswered}`,
  )
  const useful = pulses.outcomes.notify + pulses.outcomes.alert
  const total = Math.max(pulses.outcomes.ok + useful, 1)
  lines.push(`- taxa de utilidade: ${Math.round((useful / total) * 100)}% (${useful} pulsos que valeram a pena)`)
  lines.push("")
  lines.push(`## Blackboard: specs ${board.specs.open} abertos / ${board.specs.claimed} em execução / ${board.specs.done} done / ${board.specs.failed} failed`)
  lines.push(`- asks: ${board.asks.pending} pendentes, ${board.asks.answered} respondidas, ${board.asks.expired} expiradas`)
  lines.push(`- steers: ${board.steers.delivered} entregues, ${board.steers.failed} falhados`)
  lines.push(`- learnings: ${board.learnings}`)
  return lines.join("\n")
}
