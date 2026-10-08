import { describe, expect, test } from "bun:test"
import * as core from "../.opencode/lib/core"

describe("parseDuration", () => {
  test("unidades comuns", () => {
    expect(core.parseDuration("5m")).toBe(300_000)
    expect(core.parseDuration("90s")).toBe(90_000)
    expect(core.parseDuration("2h")).toBe(7_200_000)
    expect(core.parseDuration("1d")).toBe(86_400_000)
    expect(core.parseDuration("30")).toBe(1_800_000)
    expect(core.parseDuration("45min")).toBe(2_700_000)
    expect(core.parseDuration("10 MINS")).toBe(600_000)
  })
  test("inválidos", () => {
    expect(core.parseDuration("abc")).toBe(null)
    expect(core.parseDuration("")).toBe(null)
    expect(core.parseDuration("-5m")).toBe(null)
    expect(core.parseDuration("0m")).toBe(null)
  })
})

describe("clampInterval", () => {
  test("limites 2m–1h", () => {
    expect(core.clampInterval("30s")).toBe("2m")
    expect(core.clampInterval("10m")).toBe("10m")
    expect(core.clampInterval("5h")).toBe("1h")
    expect(core.clampInterval("x")).toBe(null)
  })
})

describe("inActiveHours", () => {
  const at = (h: number, m: number) => {
    const d = new Date()
    d.setHours(h, m, 0, 0)
    return d
  }
  test("null = sempre", () => {
    expect(core.inActiveHours(at(3, 0), null)).toBe(true)
  })
  test("janela normal", () => {
    const ah = { start: "08:00", end: "23:00" }
    expect(core.inActiveHours(at(12, 0), ah)).toBe(true)
    expect(core.inActiveHours(at(7, 59), ah)).toBe(false)
    expect(core.inActiveHours(at(23, 0), ah)).toBe(false)
  })
  test("janela overnight", () => {
    const ah = { start: "22:00", end: "06:00" }
    expect(core.inActiveHours(at(23, 30), ah)).toBe(true)
    expect(core.inActiveHours(at(3, 0), ah)).toBe(true)
    expect(core.inActiveHours(at(12, 0), ah)).toBe(false)
  })
  test("janela de largura zero", () => {
    expect(core.inActiveHours(at(12, 0), { start: "08:00", end: "08:00" })).toBe(false)
  })
  test("janela dia inteiro", () => {
    const ah = { start: "00:00", end: "24:00" }
    expect(core.inActiveHours(at(0, 0), ah)).toBe(true)
    expect(core.inActiveHours(at(23, 59), ah)).toBe(true)
  })
})

describe("dueAt", () => {
  const base = (over: Partial<core.HeartbeatState>): core.HeartbeatState => ({
    ...core.defaultState(),
    ...over,
  })
  test("nunca disparou = due agora", () => {
    const now = Date.now()
    expect(core.dueAt(base({}), now, new Date(now))).toBe(0)
  })
  test("respeita intervalo", () => {
    const now = Date.now()
    const lastFired = now - 60_000
    const st = base({ lastFired, interval: "10m" })
    expect(core.dueAt(st, now, new Date(now))).toBe(lastFired + 600_000)
  })
  test("desligado = null", () => {
    const now = Date.now()
    expect(core.dueAt(base({ enabled: false }), now, new Date(now))).toBe(null)
  })
  test("pausado = offUntil", () => {
    const now = Date.now()
    expect(core.dueAt(base({ enabled: false, offUntil: now + 5_000 }), now, new Date(now))).toBe(now + 5_000)
  })
  test("nextWake sobrepõe intervalo", () => {
    const now = Date.now()
    const wake = now + 120_000
    const st = base({ lastFired: now - 5_000, nextWake: wake })
    expect(core.dueAt(st, now, new Date(now))).toBe(wake)
  })
  test("force dispara imediatamente", () => {
    const now = Date.now()
    const st = base({ lastFired: now - 5_000, force: true })
    expect(core.dueAt(st, now, new Date(now))).toBe(now)
  })
})

describe("buildPulsePrompt", () => {
  test("contém marcador e contrato", () => {
    const p = core.buildPulsePrompt("timer", "ctx aqui", "/x/heartbeat.md")
    expect(p.startsWith("[🫀 pulse]")).toBe(true)
    expect(p).toContain("HEARTBEAT_OK")
    expect(p).toContain("NOTIFY:")
    expect(p).toContain("ALERT:")
    expect(p).toContain("/x/heartbeat.md")
  })
})

describe("locks", () => {
  test("acquireLock exclusivo e release", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${import.meta.dir}/tmp-`))
    const file = dir + "/pulse.lock"
    const now = Date.now()
    expect(await core.acquireLock(file, 60_000, now)).toBe(true)
    expect(await core.acquireLock(file, 60_000, now + 1_000)).toBe(false)
    await core.releaseLock(file)
    expect(await core.acquireLock(file, 60_000, now + 2_000)).toBe(true)
    await import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
  })
  test("acquireLock rouba lock expirado", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${import.meta.dir}/tmp-`))
    const file = dir + "/pulse.lock"
    const now = Date.now()
    expect(await core.acquireLock(file, 60_000, now)).toBe(true)
    expect(await core.acquireLock(file, 120_000, now + 61_000)).toBe(true)
    await import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
  })
})

describe("fs helpers", () => {
  test("writeJsonAtomic + readJson roundtrip", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${import.meta.dir}/tmp-`))
    const file = dir + "/state.json"
    await core.writeJsonAtomic(file, { a: 1 })
    expect(await core.readJson(file, { a: 0 })).toEqual({ a: 1 })
    await import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
  })
  test("appendJsonl e readTailLines", async () => {
    const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp(`${import.meta.dir}/tmp-`))
    const file = dir + "/j.jsonl"
    await core.appendJsonl(file, { n: 1 })
    await core.appendJsonl(file, { n: 2 })
    await core.appendJsonl(file, { n: 3 })
    expect(await core.readTailLines(file, 2)).toEqual(['{"n":2}', '{"n":3}'])
    await import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }))
  })
  test("newId tem prefixo", () => {
    expect(core.newId("w").startsWith("w-")).toBe(true)
  })
  test("truncate", () => {
    expect(core.truncate("abcdef", 3)).toBe("ab…")
    expect(core.truncate("abc", 10)).toBe("abc")
  })
})
