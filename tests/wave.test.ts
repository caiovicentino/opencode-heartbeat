import { describe, expect, test } from "bun:test"
import * as wv from "../.opencode/lib/wave"
import type { Spec } from "../.opencode/lib/blackboard"

function fakeSpec(over: Partial<Spec> = {}): Spec {
  return {
    id: "spec-1",
    wave: "w1",
    role: "implementer",
    title: "Teste",
    files: ["src/a.ts"],
    acceptance: ["bun test"],
    digest: null,
    budgetTokens: 1000,
    timeoutSec: 60,
    autonomy: 1,
    status: "open",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe("buildWorkerPrompt", () => {
  test("contém spec, regras e tools de comunicação", () => {
    const p = wv.buildWorkerPrompt(fakeSpec(), "contexto aqui")
    expect(p).toContain("spec-1")
    expect(p).toContain("src/a.ts")
    expect(p).toContain("bun test")
    expect(p).toContain("report_progress")
    expect(p).toContain("ask_boss")
    expect(p).toContain("contexto aqui")
    expect(p).toContain("Não faça commit")
  })
})

describe("extractStructured", () => {
  test("resposta com structured direto (info.structured)", () => {
    const res = { data: { info: { structured: { status: "done", confidence: 0.9, notes: "ok", files: ["a"] } } } }
    const out = wv.extractStructured(res)
    expect(out?.status).toBe("done")
    expect(out?.confidence).toBe(0.9)
  })
  test("fallback: tool part StructuredOutput", () => {
    const res = {
      data: {
        info: {},
        parts: [{ type: "text", text: "bleh" }, { type: "tool", tool: "StructuredOutput", state: { input: { status: "done", confidence: 0.7, notes: "n", files: [] } } }],
      },
    }
    expect(wv.extractStructured(res)?.confidence).toBe(0.7)
  })
  test("fallback: JSON no último text part", () => {
    const res = { data: { parts: [{ type: "text", text: "bleh" }, { type: "text", text: '{"status":"done","confidence":0.5,"notes":"n"}' }] } }
    expect(wv.extractStructured(res)?.confidence).toBe(0.5)
  })
  test("clamps e defaults", () => {
    const out = wv.extractStructured({ data: { info: { structured_output: { status: "x", confidence: 5 } } } })
    expect(out?.status).toBe("failed")
    expect(out?.confidence).toBe(1)
    expect(out?.files).toEqual([])
  })
  test("null quando nada serve", () => {
    expect(wv.extractStructured({ data: { parts: [{ type: "text", text: "sem json" }] } })).toBe(null)
    expect(wv.extractStructured({})).toBe(null)
  })
})

describe("buildWaveSummary", () => {
  test("resume done/failed/erro", () => {
    const s = fakeSpec()
    const rows = [
      { spec: s, result: { spec: s.id, session: "s", branch: null, status: "done" as const, checks: [], confidence: 0.9, notes: "beleza", createdAt: 0 } },
      { spec: fakeSpec({ id: "spec-2", title: "Falha" }), result: { spec: "spec-2", session: "s", branch: null, status: "failed" as const, checks: [], confidence: 0.2, notes: "quebrou", createdAt: 0 } },
      { spec: fakeSpec({ id: "spec-3", title: "Boom" }), result: null, error: "crash" },
    ]
    const text = wv.buildWaveSummary(rows)
    expect(text).toContain("1/3 done")
    expect(text).toContain("1 failed")
    expect(text).toContain("1 erro")
    expect(text).toContain("spec-3")
    expect(text).toContain("crash")
  })
})

describe("aggregateVerdicts", () => {
  test("sem verdicts = revise", () => {
    expect(wv.aggregateVerdicts([], 75).verdict).toBe("revise")
  })
  test("aceita quando todos accept e score ok", () => {
    const vs = [
      { spec: "s", judge: "1", verdict: "accept" as const, score: 90, reasons: [], createdAt: 0 },
      { spec: "s", judge: "2", verdict: "accept" as const, score: 80, reasons: [], createdAt: 0 },
    ]
    expect(wv.aggregateVerdicts(vs, 75).verdict).toBe("accept")
  })
  test("reject domina; score baixo vira revise", () => {
    const vs = [
      { spec: "s", judge: "1", verdict: "reject" as const, score: 90, reasons: [], createdAt: 0 },
      { spec: "s", judge: "2", verdict: "accept" as const, score: 90, reasons: [], createdAt: 0 },
    ]
    expect(wv.aggregateVerdicts(vs, 75).verdict).toBe("reject")
    const low = vs.map((v, i) => ({ ...v, judge: String(i), verdict: "accept" as const, score: 60 }))
    expect(wv.aggregateVerdicts(low, 75).verdict).toBe("revise")
  })
})
