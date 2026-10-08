import * as core from "./core"
import * as pb from "./postbox"

export interface DigestInput {
  now: Date
  todos: { content: string; status: string }[]
  gitBranch: string | null
  gitChanges: string | null
  gitRecent: string | null
  watchResults: { id: string; goal: string; autonomy: string; output: string; error?: string }[]
  scratch: string | null
  asks: { id: string; spec: string | null; session: string; question: string; options: string[]; seen: boolean }[]
  progress: { spec: string; session: string; status: string | null; text: string }[]
}

const WATCH_OUTPUT_MAX = 300
const SCRATCH_MAX_LINES = 15
const TODOS_MAX = 8

export function formatDigest(d: DigestInput): string {
  const lines: string[] = []
  lines.push(`# Pulso — ${d.now.toISOString()}`)
  if (d.gitBranch) lines.push(`- git: ${d.gitBranch}`)
  if (d.gitChanges) lines.push("- status:\n" + core.truncate(d.gitChanges, 1_200))
  if (d.gitRecent) lines.push("- commits recentes:\n" + d.gitRecent)
  if (d.todos.length > 0) {
    lines.push("- todos abertos:")
    for (const t of d.todos.slice(0, TODOS_MAX)) lines.push(`  - [${t.status}] ${t.content}`)
    if (d.todos.length > TODOS_MAX) lines.push(`  - (+${d.todos.length - TODOS_MAX} outros)`)
  }
  if (d.watchResults.length > 0) {
    lines.push(`- watches (${d.watchResults.length}):`)
    for (const w of d.watchResults) {
      const out = w.error ? `ERRO: ${w.error}` : w.output || "(sem saída)"
      lines.push(`  - [${w.id}] ${w.goal} (${w.autonomy}): ${core.truncate(out, WATCH_OUTPUT_MAX)}`)
    }
  }
  if (d.asks.length > 0) {
    lines.push(`- INBOX (asks de workers — responda com god_answer): ${d.asks.length}`)
    for (const a of d.asks) {
      lines.push(`  - [${a.id}] (${a.spec ?? "sem-spec"}, ${a.session}) ${core.truncate(a.question, 160)}`)
      if (a.options.length > 0) lines.push(`    opções: ${a.options.join(" | ")}`)
      if (!a.seen) lines.push(`    (NOVA — acorda o boss)`)
    }
  }
  if (d.progress.length > 0) {
    lines.push(`- progresso dos workers (desde o último pulso): ${d.progress.length}`)
    for (const p of d.progress) {
      lines.push(`  - [${p.spec}] (${p.session}) ${core.truncate((p.status ? `[${p.status}] ` : "") + p.text, 160)}`)
    }
  }
  if (d.scratch) {
    const scratchLines = d.scratch
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, SCRATCH_MAX_LINES)
    lines.push("- scratch:\n" + scratchLines.map((l) => "  " + l).join("\n"))
  }
  return core.truncate(lines.join("\n"), core.DIGEST_MAX_CHARS)
}

export interface DigestContext {
  client: any
  $: any
  directory: string
  sessionId: string
  watches: core.Watch[]
  scratchPath: string
  bbRoot: string
  lastFired: number | null
}

export interface GatherOutput {
  digest: string
  watchResults: { id: string; output: string }[]
  asks: DigestInput["asks"]
}

async function tryAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

async function shell($: any, directory: string, cmd: string): Promise<string | null> {
  try {
    const proc = await $`sh -c ${cmd}`.cwd(directory).quiet()
    const out = (proc?.stdout ?? "").toString().trim()
    return out || null
  } catch {
    return null
  }
}

export async function gatherDigestData(ctx: DigestContext): Promise<GatherOutput> {
  const now = new Date()

  const todosRaw = await tryAsync(async () => {
    const res = await ctx.client.session.todo({ path: { id: ctx.sessionId } })
    const arr = res?.data ?? res ?? []
    return Array.isArray(arr) ? arr : []
  }, [] as any[])

  const todos = todosRaw
    .filter((t: any) => t?.content && t?.status !== "completed" && t?.status !== "cancelled")
    .map((t: any) => ({ content: String(t.content), status: String(t.status ?? "?") }))

  const gitBranch = await shell(ctx.$, ctx.directory, "git rev-parse --abbrev-ref HEAD")
  const gitChanges = await shell(ctx.$, ctx.directory, "git status --short --branch")
  const gitRecent = await shell(ctx.$, ctx.directory, "git log --oneline -3")

  const watchResults: { id: string; output: string }[] = []
  const digestWatches: DigestInput["watchResults"] = []
  const nowMs = now.getTime()
  for (const w of ctx.watches) {
    if (w.status !== "active") continue
    if (w.expiresAt && w.expiresAt < nowMs) continue
    const output = await shell(ctx.$, ctx.directory, w.check)
    const recorded = output ?? "ERRO: falha ao executar o check"
    watchResults.push({ id: w.id, output: recorded })
    digestWatches.push({ id: w.id, goal: w.goal, autonomy: w.autonomy, output: recorded })
  }

  const scratch = await tryAsync(async () => {
    const { readFile } = await import("node:fs/promises")
    return await readFile(ctx.scratchPath, "utf8")
  }, null as string | null)

  const asksRaw = await tryAsync(async () => await pb.listAsks(ctx.bbRoot, "pending"), [] as pb.Ask[])
  const asks = asksRaw.map((a) => ({
    id: a.id,
    spec: a.spec,
    session: a.session,
    question: a.question,
    options: a.options,
    seen: a.seenAt !== null,
  }))
  const progress = await tryAsync(
    async () => await pb.listProgressSince(ctx.bbRoot, ctx.lastFired ?? 0),
    [] as pb.ProgressEntry[],
  )

  const digest = formatDigest({
    now,
    todos,
    gitBranch,
    gitChanges,
    gitRecent,
    watchResults: digestWatches,
    scratch,
    asks,
    progress,
  })

  return { digest, watchResults, asks }
}
