import { link, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"

export type SpecStatus = "open" | "claimed" | "done" | "failed" | "cancelled"
export type ResultStatus = "done" | "failed" | "timeout" | "cancelled"
export type VerdictKind = "accept" | "revise" | "reject"
export type LearningKind = "strategy" | "ignore" | "prompt"
export type LearningSource = "user" | "judge" | "stats"
export type WaveStatus = "open" | "running" | "closed" | "aborted"

export interface Spec {
  id: string
  wave: string | null
  role: string
  title: string
  files: string[]
  acceptance: string[]
  digest: string | null
  budgetTokens: number
  timeoutSec: number
  autonomy: number
  status: SpecStatus
  createdAt: number
  updatedAt: number
}

export interface Claim {
  spec: string
  session: string
  node: string
  claimedAt: number
  expiresAt: number
}

export interface CheckOutcome {
  cmd: string
  passed: boolean
  output?: string
}

export interface Result {
  spec: string
  session: string
  branch: string | null
  status: ResultStatus
  checks: CheckOutcome[]
  confidence: number
  notes: string
  createdAt: number
  cost?: number
  tokensIn?: number
  tokensOut?: number
}

export interface Verdict {
  spec: string
  judge: string
  verdict: VerdictKind
  score: number
  reasons: string[]
  createdAt: number
}

export interface Learning {
  id: string
  kind: LearningKind
  text: string
  source: LearningSource
  weight: number
  createdAt: number
}

export interface Wave {
  id: string
  objective: string
  composition: Record<string, number>
  burstWindowSec: number
  budgetTokens: number
  timeboxMin: number
  gate: string
  status: WaveStatus
  createdAt: number
}

export interface BlackboardPaths {
  root: string
  specs: string
  claims: string
  results: string
  verdicts: string
  learnings: string
  waves: string
}

export function paths(root: string): BlackboardPaths {
  return {
    root,
    specs: path.join(root, "specs"),
    claims: path.join(root, "claims"),
    results: path.join(root, "results"),
    verdicts: path.join(root, "verdicts"),
    learnings: path.join(root, "learnings"),
    waves: path.join(root, "waves"),
  }
}

export async function ensure(root: string): Promise<void> {
  const p = paths(root)
  await Promise.all([
    mkdir(p.specs, { recursive: true }),
    mkdir(p.claims, { recursive: true }),
    mkdir(p.results, { recursive: true }),
    mkdir(p.verdicts, { recursive: true }),
    mkdir(p.learnings, { recursive: true }),
    mkdir(p.waves, { recursive: true }),
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

export async function createSpec(root: string, input: Partial<Spec> & { title: string }): Promise<Spec> {
  await ensure(root)
  const p = paths(root)
  const now = Date.now()
  const spec: Spec = {
    id: `spec-${stamp()}`,
    wave: input.wave ?? null,
    role: input.role ?? "implementer",
    title: input.title,
    files: input.files ?? [],
    acceptance: input.acceptance ?? [],
    digest: input.digest ?? null,
    budgetTokens: input.budgetTokens ?? 300_000,
    timeoutSec: input.timeoutSec ?? 1_800,
    autonomy: input.autonomy ?? 1,
    status: "open",
    createdAt: now,
    updatedAt: now,
  }
  await writeJson(path.join(p.specs, spec.id + ".json"), spec)
  return spec
}

export async function getSpec(root: string, id: string): Promise<Spec | null> {
  return readOptional<Spec>(path.join(paths(root).specs, id + ".json"))
}

export async function saveSpec(root: string, spec: Spec): Promise<Spec> {
  spec.updatedAt = Date.now()
  await writeJson(path.join(paths(root).specs, spec.id + ".json"), spec)
  return spec
}

export async function listSpecs(root: string, status?: SpecStatus): Promise<Spec[]> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.specs)
  } catch {
    return []
  }
  const out: Spec[] = []
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const spec = await readOptional<Spec>(path.join(p.specs, f))
    if (spec && (!status || spec.status === status)) out.push(spec)
  }
  return out
}

export async function claimSpec(
  root: string,
  specId: string,
  session: string,
  node: string,
  ttlSec: number,
): Promise<Claim | null> {
  const now = Date.now()
  const claim: Claim = {
    spec: specId,
    session,
    node,
    claimedAt: now,
    expiresAt: now + ttlSec * 1_000,
  }
  const ok = await createExclusive(path.join(paths(root).claims, specId + ".json"), claim)
  if (!ok) return null
  const spec = await getSpec(root, specId)
  if (spec) await saveSpec(root, { ...spec, status: "claimed" })
  return claim
}

export async function getClaim(root: string, specId: string): Promise<Claim | null> {
  return readOptional<Claim>(path.join(paths(root).claims, specId + ".json"))
}

export async function releaseClaim(root: string, specId: string): Promise<void> {
  await unlink(path.join(paths(root).claims, specId + ".json")).catch(() => {})
}

export async function completeSpec(root: string, specId: string, result: Omit<Result, "spec" | "createdAt">): Promise<Result | null> {
  const p = paths(root)
  const spec = await getSpec(root, specId)
  if (!spec) return null
  const full: Result = { ...result, spec: specId, createdAt: Date.now() }
  await writeJson(path.join(p.results, specId + ".json"), full)
  await saveSpec(root, { ...spec, status: result.status === "done" ? "done" : "failed" })
  await releaseClaim(root, specId)
  return full
}

export async function getResult(root: string, specId: string): Promise<Result | null> {
  return readOptional<Result>(path.join(paths(root).results, specId + ".json"))
}

export async function addVerdict(root: string, verdict: Verdict): Promise<Verdict> {
  await ensure(root)
  const p = paths(root)
  await writeJson(path.join(p.verdicts, `${verdict.spec}-${verdict.judge}.json`), verdict)
  return verdict
}

export async function listVerdicts(root: string, specId: string): Promise<Verdict[]> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.verdicts)
  } catch {
    return []
  }
  const out: Verdict[] = []
  for (const f of files.filter((f) => f.startsWith(specId + "-") && f.endsWith(".json"))) {
    const v = await readOptional<Verdict>(path.join(p.verdicts, f))
    if (v) out.push(v)
  }
  return out
}

export async function addLearning(root: string, input: { kind: LearningKind; text: string; source: LearningSource; weight?: number }): Promise<Learning> {
  await ensure(root)
  const p = paths(root)
  const learning: Learning = {
    id: `learn-${stamp()}`,
    kind: input.kind,
    text: input.text,
    source: input.source,
    weight: input.weight ?? 1,
    createdAt: Date.now(),
  }
  await writeJson(path.join(p.learnings, learning.id + ".json"), learning)
  return learning
}

export async function listLearnings(root: string, minWeight = 0): Promise<Learning[]> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.learnings)
  } catch {
    return []
  }
  const out: Learning[] = []
  for (const f of files.filter((f) => f.endsWith(".json")).sort()) {
    const l = await readOptional<Learning>(path.join(p.learnings, f))
    if (l && l.weight >= minWeight) out.push(l)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export async function createWave(root: string, input: Omit<Wave, "id" | "status" | "createdAt"> & { id?: string }): Promise<Wave> {
  await ensure(root)
  const p = paths(root)
  const wave: Wave = {
    id: input.id ?? `wave-${stamp()}`,
    objective: input.objective,
    composition: input.composition,
    burstWindowSec: input.burstWindowSec,
    budgetTokens: input.budgetTokens,
    timeboxMin: input.timeboxMin,
    gate: input.gate,
    status: "open",
    createdAt: Date.now(),
  }
  await writeJson(path.join(p.waves, wave.id + ".json"), wave)
  return wave
}

export async function getWave(root: string, id: string): Promise<Wave | null> {
  return readOptional<Wave>(path.join(paths(root).waves, id + ".json"))
}

export async function saveWave(root: string, wave: Wave): Promise<Wave> {
  await writeJson(path.join(paths(root).waves, wave.id + ".json"), wave)
  return wave
}

export interface GcReport {
  expiredClaims: number
}

export async function gc(root: string, now = Date.now()): Promise<GcReport> {
  const p = paths(root)
  let files: string[] = []
  try {
    files = await readdir(p.claims)
  } catch {
    return { expiredClaims: 0 }
  }
  let expired = 0
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    const claim = await readOptional<Claim>(path.join(p.claims, f))
    if (!claim || claim.expiresAt >= now) continue
    const spec = await getSpec(root, claim.spec)
    if (spec && spec.status === "claimed") await saveSpec(root, { ...spec, status: "open" })
    await unlink(path.join(p.claims, f)).catch(() => {})
    expired++
  }
  return { expiredClaims: expired }
}
