import { appendFile, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"

export type AutonomyLevel = "L0" | "L1" | "L2" | "L3"

export const AUTONOMY_LEVELS: AutonomyLevel[] = ["L0", "L1", "L2", "L3"]

export interface Watch {
  id: string
  goal: string
  check: string
  autonomy: AutonomyLevel
  status: "active" | "done"
  expiresAt: number | null
  createdAt: number
  lastCheckedAt: number | null
  lastOutput: string | null
}

export interface ActiveHours {
  start: string
  end: string
}

export interface HeartbeatBudget {
  dailyPulses: number
  usedPulses: number
  day: string
}

export interface HeartbeatState {
  version: number
  enabled: boolean
  interval: string
  offUntil: number | null
  lastFired: number | null
  nextWake: number | null
  force: boolean
  pulseCount: number
  budget: HeartbeatBudget
  activeHours: ActiveHours | null
  watches: Watch[]
}

export const TICK_MS = 15_000
export const COOLDOWN_MS = 90_000
export const INTERVAL_MIN_MS = 2 * 60_000
export const INTERVAL_MAX_MS = 60 * 60_000
export const DIGEST_MAX_CHARS = 8_000

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

export function parseDuration(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?\s*$/i.exec(
    value,
  )
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * UNIT_MS[(m[2] ?? "m").toLowerCase()])
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`
  return `${Math.round(ms / 86_400_000)}d`
}

export function clampInterval(value: string): string | null {
  const ms = parseDuration(value)
  if (ms === null) return null
  return formatDuration(Math.min(Math.max(ms, INTERVAL_MIN_MS), INTERVAL_MAX_MS))
}

export function parseHHMM(s: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null
  if (h < 0 || h > 24 || min < 0 || min > 59) return null
  if (h === 24 && min !== 0) return null
  return { h, m: min }
}

export function inActiveHours(now: Date, ah: ActiveHours | null | undefined): boolean {
  if (!ah) return true
  const s = parseHHMM(ah.start)
  const e = parseHHMM(ah.end)
  if (!s || !e) return true
  if (s.h === e.h && s.m === e.m) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const start = s.h * 60 + s.m
  const end = e.h === 24 ? 24 * 60 : e.h * 60 + e.m
  if (start <= end) return cur >= start && cur < end
  return cur >= start || cur < end
}

export function nextWindowStart(now: Date, ah: ActiveHours): number {
  const s = parseHHMM(ah.start)
  if (!s) return now.getTime()
  const cand = new Date(now)
  cand.setHours(s.h, s.m, 0, 0)
  if (cand.getTime() <= now.getTime()) cand.setDate(cand.getDate() + 1)
  return cand.getTime()
}

export function dayKey(d: Date): string {
  const mo = String(d.getMonth() + 1).padStart(2, "0")
  const da = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mo}-${da}`
}

export function defaultState(now = new Date()): HeartbeatState {
  return {
    version: 1,
    enabled: true,
    interval: "10m",
    offUntil: null,
    lastFired: null,
    nextWake: null,
    force: false,
    pulseCount: 0,
    budget: { dailyPulses: 48, usedPulses: 0, day: dayKey(now) },
    activeHours: null,
    watches: [],
  }
}

export function dueAt(state: HeartbeatState, nowMs: number, now: Date): number | null {
  if (state.offUntil && nowMs < state.offUntil) return state.offUntil
  if (!state.enabled) return null
  const intervalMs = parseDuration(state.interval) ?? 10 * 60_000
  const base = state.nextWake ?? (state.lastFired === null ? 0 : state.lastFired + intervalMs)
  if (state.force) return Math.min(base, nowMs)
  const ah = state.activeHours
  if (ah && !inActiveHours(now, ah)) {
    const windowStart = nextWindowStart(now, ah)
    return Math.max(base, windowStart)
  }
  return base
}

export function buildPulsePrompt(trigger: string, digest: string, scratchPath: string): string {
  return [
    "[🫀 pulse] Checagem automática (trigger: " + trigger + ").",
    "",
    "Contexto do pulso:",
    digest.trim() || "— (sem contexto adicional)",
    "",
    "Protocolo:",
    "- Se NADA precisa de atenção, responda apenas: HEARTBEAT_OK",
    "- Se vale falar comigo, comece a resposta com: NOTIFY:",
    "- Se for urgência, comece com: ALERT:",
    "- Este pulso é observador: não execute ações que exijam aprovação.",
    "- Checklist e watches vivem em " + scratchPath + ".",
  ].join("\n")
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

export function relTime(ts: number | null, now: number): string {
  if (!ts) return "—"
  const d = now - ts
  if (d < 0) return "em " + formatDuration(-d)
  if (d < 60_000) return `${Math.round(d / 1_000)}s atrás`
  if (d < 3_600_000) return `${Math.round(d / 60_000)}min atrás`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h atrás`
  return `${Math.round(d / 86_400_000)}d atrás`
}

export async function acquireLock(file: string, ttlMs: number, now: number): Promise<boolean> {
  let expired = true
  try {
    const raw = await readFile(file, "utf8")
    const parsed = JSON.parse(raw) as { ts?: number; expiresAt?: number }
    if (parsed && typeof parsed.expiresAt === "number") expired = now >= parsed.expiresAt
  } catch {
    expired = true
  }
  if (!expired) return false
  await unlink(file).catch(() => {})
  const tmp = file + "." + randomBytes(4).toString("hex") + ".tmp"
  try {
    await writeFile(tmp, JSON.stringify({ ts: now, expiresAt: now + ttlMs }))
    await link(tmp, file)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    await unlink(tmp).catch(() => {})
    if (code === "EEXIST") return false
    throw e
  }
  await unlink(tmp).catch(() => {})
  return true
}

export async function releaseLock(file: string): Promise<void> {
  await unlink(file).catch(() => {})
}

export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

export function fileExists(p: string): boolean {
  return existsSync(p)
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, "utf8")
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  const tmp = file + "." + randomBytes(4).toString("hex") + ".tmp"
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n")
  await rename(tmp, file)
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file))
  await appendFile(file, JSON.stringify(value) + "\n")
}

export async function readTailLines(file: string, n: number): Promise<string[]> {
  try {
    const raw = await readFile(file, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    return lines.slice(-n)
  } catch {
    return []
  }
}

export function scratchTemplate(): string {
  return [
    "# Heartbeat — checklist",
    "",
    "Use este arquivo como checklist viva do pulso. Mantenha curto.",
    "",
    "## Checklist",
    "- (exemplo) conferir que a suíte está verde antes de encerrar o dia",
    "",
    "## Notas",
    "- Watches registrados ficam em heartbeat.json e entram no digest automaticamente.",
  ].join("\n")
}
