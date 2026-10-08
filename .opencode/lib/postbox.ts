import { appendFile, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { link } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

export type AskStatus = "pending" | "answered" | "expired"

export interface Ask {
  id: string
  spec: string | null
  session: string
  question: string
  options: string[]
  status: AskStatus
  seenAt: number | null
  createdAt: number
  answeredAt: number | null
  answer: string | null
}

export interface SteerRecord {
  id: string
  spec: string
  session: string
  instruction: string
  status: "queued" | "delivered" | "failed"
  createdAt: number
  deliveredAt: number | null
  error: string | null
}

export interface ProgressEntry {
  ts: string
  spec: string
  session: string
  status: string | null
  text: string
}

export interface PostboxPaths {
  root: string
  progress: string
  asks: string
  steers: string
}

export function paths(root: string): PostboxPaths {
  return {
    root,
    progress: path.join(root, "progress"),
    asks: path.join(root, "asks"),
    steers: path.join(root, "steers"),
  }
}

export async function ensure(root: string): Promise<void> {
  const p = paths(root)
  await Promise.all([
    mkdir(p.progress, { recursive: true }),
    mkdir(p.asks, { recursive: true }),
    mkdir(p.steers, { recursive: true }),
  ])
}

function stamp(): string {
  return `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, JSON.stringify(value, null, 2) + "\n")
}

async function createExclusive(file: string, value: unknown): Promise<boolean> {
  const tmp = file + "." + randomBytes(4).toString("hex") + ".tmp"
  await writeJson(tmp, value)
  try {
    await link(tmp, file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === "EEXIST") {
      await unlink(tmp).catch(() => {})
      return false
    }
    throw e
  } finally {
    await unlink(tmp).catch(() => {})
  }
  return true
}

async function readOptional<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch {
    return null
  }
}

export async function createAsk(
  root: string,
  input: { spec: string | null; session: string; question: string; options: string[] },
): Promise<Ask> {
  await ensure(root)
  const ask: Ask = {
    id: `ask-${stamp()}`,
    spec: input.spec,
    session: input.session,
    question: input.question,
    options: input.options,
    status: "pending",
    seenAt: null,
    createdAt: Date.now(),
    answeredAt: null,
    answer: null,
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await createExclusive(path.join(paths(root).asks, ask.id + ".json"), ask)) return ask
    ask.id = `ask-${stamp()}`
  }
  throw new Error("não foi possível criar ask")
}

export async function getAsk(root: string, id: string): Promise<Ask | null> {
  return readOptional<Ask>(path.join(paths(root).asks, id + ".json"))
}

export async function listAsks(root: string, status?: AskStatus): Promise<Ask[]> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.asks)
  } catch {
    return []
  }
  const out: Ask[] = []
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const a = await readOptional<Ask>(path.join(p.asks, f))
    if (a && (!status || a.status === status)) out.push(a)
  }
  return out.sort((a, b) => a.createdAt - b.createdAt)
}

export async function unseenAsks(root: string): Promise<Ask[]> {
  const pending = await listAsks(root, "pending")
  return pending.filter((a) => a.seenAt === null)
}

export async function markAsksSeen(root: string, ids: string[]): Promise<void> {
  const p = paths(root)
  for (const id of ids) {
    const ask = await getAsk(root, id)
    if (ask && ask.status === "pending" && ask.seenAt === null) {
      await writeJson(path.join(p.asks, id + ".json"), { ...ask, seenAt: Date.now() })
    }
  }
}

export async function answerAsk(root: string, id: string, answer: string): Promise<Ask | null> {
  const ask = await getAsk(root, id)
  if (!ask) return null
  const updated: Ask = { ...ask, status: "answered", answer, answeredAt: Date.now() }
  await writeJson(path.join(paths(root).asks, id + ".json"), updated)
  return updated
}

export async function expireAsk(root: string, id: string): Promise<void> {
  const ask = await getAsk(root, id)
  if (ask && ask.status === "pending") {
    await writeJson(path.join(paths(root).asks, id + ".json"), { ...ask, status: "expired" })
  }
}

export async function gcAsks(root: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  const pending = await listAsks(root, "pending")
  let expired = 0
  for (const a of pending) {
    if (now - a.createdAt > maxAgeMs) {
      await expireAsk(root, a.id)
      expired++
    }
  }
  return expired
}

export async function addProgress(
  root: string,
  spec: string,
  session: string,
  text: string,
  status?: string,
): Promise<ProgressEntry> {
  await ensure(root)
  const entry: ProgressEntry = {
    ts: new Date().toISOString(),
    spec,
    session,
    status: status ?? null,
    text,
  }
  await appendFile(path.join(paths(root).progress, `${spec}.jsonl`), JSON.stringify(entry) + "\n")
  return entry
}

export async function listProgressSince(root: string, sinceMs: number, limit = 20): Promise<ProgressEntry[]> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.progress)
  } catch {
    return []
  }
  const out: ProgressEntry[] = []
  const since = new Date(sinceMs).toISOString()
  for (const f of files.filter((f) => f.endsWith(".jsonl")).sort()) {
    try {
      const raw = await readFile(path.join(p.progress, f), "utf8")
      for (const line of raw.split("\n").filter(Boolean)) {
        try {
          const e = JSON.parse(line) as ProgressEntry
          if (e.ts >= since) out.push(e)
        } catch {}
      }
    } catch {}
  }
  return out.sort((a, b) => (a.ts < b.ts ? -1 : 1)).slice(-limit)
}

export async function recordSteer(root: string, rec: Omit<SteerRecord, "id" | "createdAt">): Promise<SteerRecord> {
  await ensure(root)
  const full: SteerRecord = { ...rec, id: `steer-${stamp()}`, createdAt: Date.now() }
  await writeJson(path.join(paths(root).steers, full.id + ".json"), full)
  return full
}

export async function updateSteer(root: string, steer: SteerRecord): Promise<void> {
  await writeJson(path.join(paths(root).steers, steer.id + ".json"), steer)
}

export async function listSteers(root: string, spec?: string): Promise<SteerRecord[]> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.steers)
  } catch {
    return []
  }
  const out: SteerRecord[] = []
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const s = await readOptional<SteerRecord>(path.join(p.steers, f))
    if (s && (!spec || s.spec === spec)) out.push(s)
  }
  return out
}

export async function findSpecBySession(root: string, sessionId: string): Promise<string | null> {
  const claimsDir = path.join(root, "claims")
  let files: string[] = []
  try {
    files = await readdir(claimsDir)
  } catch {
    return null
  }
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const claim = await readOptional<{ spec: string; session: string }>(path.join(claimsDir, f))
    if (claim?.session === sessionId) return claim.spec
  }
  return null
}
