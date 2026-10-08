import { describe, expect, test } from "bun:test"
import * as mg from "../.opencode/lib/merge"
import type { Result, Spec, Verdict } from "../.opencode/lib/blackboard"

const spec: Spec = {
  id: "spec-1",
  wave: "w1",
  role: "implementer",
  title: "A",
  files: ["src/a.ts"],
  acceptance: ["bun test"],
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
  session: "s",
  branch: null,
  status: "done",
  checks: [{ cmd: "bun test", passed: true }],
  confidence: 0.9,
  notes: "ok",
  createdAt: 0,
}

const verdict: Verdict = { spec: "spec-1", judge: "j1", verdict: "accept", score: 90, reasons: [], createdAt: 0 }

describe("decideMerge", () => {
  test("sem resultado = retry", () => {
    expect(mg.decideMerge(spec, null, [], mg.DEFAULT_GATE).decision).toBe("retry")
  })
  test("timeout = retry; falha = escalate", () => {
    expect(mg.decideMerge(spec, { ...result, status: "timeout" }, [], mg.DEFAULT_GATE).decision).toBe("retry")
    expect(mg.decideMerge(spec, { ...result, status: "failed", notes: "quebrou" }, [], mg.DEFAULT_GATE).decision).toBe("escalate")
  })
  test("suíte verde obrigatória", () => {
    expect(mg.decideMerge(spec, result, [], mg.DEFAULT_GATE).decision).toBe("merge")
    expect(mg.decideMerge(spec, { ...result, checks: [] }, [], mg.DEFAULT_GATE).decision).toBe("retry")
    expect(mg.decideMerge(spec, { ...result, checks: [{ cmd: "x", passed: false }] }, [], mg.DEFAULT_GATE).decision).toBe("retry")
    expect(mg.decideMerge(spec, { ...result, checks: [] }, [], { requireGreenSuite: false, requireJudgeScore: 0 }).decision).toBe("merge")
  })
  test("gate de judge", () => {
    const strict = { requireGreenSuite: true, requireJudgeScore: 75 }
    expect(mg.decideMerge(spec, result, [], strict).decision).toBe("retry")
    expect(mg.decideMerge(spec, result, [verdict], strict).decision).toBe("merge")
    expect(mg.decideMerge(spec, result, [{ ...verdict, score: 50 }], strict).decision).toBe("retry")
    expect(mg.decideMerge(spec, result, [{ ...verdict, verdict: "reject" }], strict).decision).toBe("escalate")
  })
  test("spec sem acceptance não passa com suite obrigatória", () => {
    expect(mg.decideMerge({ ...spec, acceptance: [] }, result, [], mg.DEFAULT_GATE).decision).toBe("retry")
  })
})

describe("gateFromConstitution", () => {
  test("defaults e overrides", () => {
    expect(mg.gateFromConstitution({})).toEqual({ requireGreenSuite: true, requireJudgeScore: 0 })
    expect(mg.gateFromConstitution({ mergeGate: { requireJudgeScore: 75 } })).toEqual({ requireGreenSuite: true, requireJudgeScore: 75 })
  })
})
