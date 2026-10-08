import { describe, expect, test } from "bun:test"
import * as ev from "../.opencode/lib/eval"
import type { Result, Spec } from "../.opencode/lib/blackboard"

const spec: Spec = {
  id: "spec-1",
  wave: "w1",
  role: "implementer",
  title: "Teste",
  files: ["src/a.ts"],
  acceptance: ["bun test", "bun run lint"],
  digest: null,
  budgetTokens: 1,
  timeoutSec: 1,
  autonomy: 1,
  status: "done",
  createdAt: 0,
  updatedAt: 0,
}

const result: Result = {
  spec: "spec-1",
  session: "s1",
  branch: null,
  status: "done",
  checks: [
    { cmd: "bun test", passed: true, output: "42 pass" },
    { cmd: "bun run lint", passed: false, output: "2 errors" },
  ],
  confidence: 0.9,
  notes: "feito",
  createdAt: 0,
}

const fired = (id: string, trigger: string): ev.PulseFiredEntry => ({ id, ts: new Date().toISOString(), trigger, via: "tui", session: "s" })
const outcome = (pulseId: string, marker: "OK" | "NOTIFY" | "ALERT"): ev.PulseOutcomeEntry => ({
  type: "pulse.outcome",
  ts: new Date().toISOString(),
  pulseId,
  session: "s",
  marker,
})

describe("buildJudgePrompt", () => {
  test("contém spec, result e regras de verificação", () => {
    const p = ev.buildJudgePrompt(spec, result, 0, 2)
    expect(p).toContain("judge 1/2")
    expect(p).toContain("bun test")
    expect(p).toContain("2 errors")
    expect(p).toContain("StructuredOutput")
    expect(p).toContain("VERIFICAR")
  })
})

describe("extractVerdict", () => {
  test("caminho direto info.structured", () => {
    const res = { data: { info: { structured: { verdict: "accept", score: 88, reasons: ["verde"], checks: [{ cmd: "bun test", passed: true }] } } } }
    const v = ev.extractVerdict(res)
    expect(v?.verdict).toBe("accept")
    expect(v?.score).toBe(88)
  })
  test("fallback tool part", () => {
    const res = { data: { parts: [{ type: "tool", tool: "StructuredOutput", state: { input: { verdict: "reject", score: 30, reasons: ["ruim"] } } }] } }
    expect(ev.extractVerdict(res)?.verdict).toBe("reject")
  })
  test("normaliza score fora de faixa e verdict inválido", () => {
    const v = ev.extractVerdict({ data: { info: { structured: { verdict: "ok", score: 150 } } } })
    expect(v?.verdict).toBe("revise")
    expect(v?.score).toBe(100)
  })
  test("null quando nada serve", () => {
    expect(ev.extractVerdict({})).toBe(null)
  })
})

describe("formatChecks", () => {
  test("marca ✓/✗ com saída truncada", () => {
    const s = ev.formatChecks(result.checks)
    expect(s).toContain("✓ bun test")
    expect(s).toContain("✗ bun run lint")
    expect(s).toContain("2 errors")
  })
  test("vazio", () => {
    expect(ev.formatChecks([])).toContain("vazio")
  })
})

describe("pulseStats", () => {
  test("conta triggers e desfechos", () => {
    const entries: unknown[] = [
      fired("p1", "timer"),
      fired("p2", "worker-ask"),
      fired("p3", "timer"),
      fired("p4", "timer"),
      outcome("p1", "OK"),
      outcome("p2", "NOTIFY"),
      outcome("p3", "ALERT"),
      { ts: new Date().toISOString(), trigger: "garbage" },
    ]
    const s = ev.pulseStats(entries)
    expect(s.fired).toBe(4)
    expect(s.byTrigger["timer"]).toBe(3)
    expect(s.byTrigger["worker-ask"]).toBe(1)
    expect(s.outcomes.ok).toBe(1)
    expect(s.outcomes.notify).toBe(1)
    expect(s.outcomes.alert).toBe(1)
    expect(s.outcomes.unanswered).toBe(1)
  })
  test("vazio", () => {
    const s = ev.pulseStats([])
    expect(s.fired).toBe(0)
    expect(s.outcomes.unanswered).toBe(0)
  })
  test("pulso antigo sem id conta como sem resposta", () => {
    const s = ev.pulseStats([{ ts: new Date().toISOString(), trigger: "timer", via: "tui", session: "s" }])
    expect(s.fired).toBe(1)
    expect(s.outcomes.unanswered).toBe(1)
  })
})

describe("formatReport", () => {
  test("monta relatório legível", () => {
    const waves: ev.WaveStat[] = [
      { id: "w1", objective: "consertar suite", status: "closed", specs: 2, done: 1, failed: 1, avgConfidence: 0.85, cost: 0.012 },
    ]
    const pulses = ev.pulseStats([fired("p1", "timer"), outcome("p1", "NOTIFY")])
    const board: ev.BoardStats = {
      specs: { open: 1, claimed: 0, done: 2, failed: 1 },
      asks: { pending: 1, answered: 2, expired: 1 },
      learnings: 3,
      steers: { delivered: 1, failed: 0 },
    }
    const r = ev.formatReport(waves, pulses, board)
    expect(r).toContain("w1")
    expect(r).toContain("50%")
    expect(r).toContain("NOTIFY")
    expect(r).toContain("learnings: 3")
    expect(r).toContain("100%")
  })
})
