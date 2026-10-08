import { describe, expect, test } from "bun:test"
import * as bb from "../.opencode/lib/blackboard"

async function tmpRoot(): Promise<string> {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  return await fs.mkdtemp(`${os.tmpdir()}/bb-`)
}

describe("blackboard", () => {
  test("createSpec + listSpecs com filtro", async () => {
    const root = await tmpRoot()
    const s1 = await bb.createSpec(root, { title: "A", role: "implementer" })
    const s2 = await bb.createSpec(root, { title: "B", role: "explorer", status: "open" as any })
    const all = await bb.listSpecs(root)
    expect(all.length).toBe(2)
    const open = await bb.listSpecs(root, "open")
    expect(open.map((s) => s.id)).toEqual([s1.id, s2.id].sort())
    expect(s1.id.startsWith("spec-")).toBe(true)
  })

  test("claimSpec é exclusivo", async () => {
    const root = await tmpRoot()
    const spec = await bb.createSpec(root, { title: "A" })
    const c1 = await bb.claimSpec(root, spec.id, "sess1", "local", 60)
    expect(c1).not.toBeNull()
    const c2 = await bb.claimSpec(root, spec.id, "sess2", "local", 60)
    expect(c2).toBeNull()
    const specAfter = await bb.getSpec(root, spec.id)
    expect(specAfter?.status).toBe("claimed")
  })

  test("gc expira claim e devolve spec pra open", async () => {
    const root = await tmpRoot()
    const spec = await bb.createSpec(root, { title: "A" })
    await bb.claimSpec(root, spec.id, "sess1", "local", 0)
    const report = await bb.gc(root, Date.now() + 1_000)
    expect(report.expiredClaims).toBe(1)
    const specAfter = await bb.getSpec(root, spec.id)
    expect(specAfter?.status).toBe("open")
    expect(await bb.getClaim(root, spec.id)).toBeNull()
  })

  test("completeSpec grava result e muda status", async () => {
    const root = await tmpRoot()
    const spec = await bb.createSpec(root, { title: "A" })
    await bb.claimSpec(root, spec.id, "sess1", "local", 60)
    const res = await bb.completeSpec(root, spec.id, {
      session: "sess1",
      branch: "god/spec-1",
      status: "done",
      checks: [{ cmd: "bun test", passed: true }],
      confidence: 0.9,
      notes: "ok",
    })
    expect(res?.spec).toBe(spec.id)
    expect((await bb.getSpec(root, spec.id))?.status).toBe("done")
    expect((await bb.getResult(root, spec.id))?.confidence).toBe(0.9)
    expect(await bb.getClaim(root, spec.id)).toBeNull()
  })

  test("verdicts por spec", async () => {
    const root = await tmpRoot()
    const spec = await bb.createSpec(root, { title: "A" })
    await bb.addVerdict(root, { spec: spec.id, judge: "j1", verdict: "accept", score: 90, reasons: [], createdAt: 0 })
    await bb.addVerdict(root, { spec: spec.id, judge: "j2", verdict: "revise", score: 60, reasons: ["x"], createdAt: 0 })
    const vs = await bb.listVerdicts(root, spec.id)
    expect(vs.length).toBe(2)
    expect(vs.find((v) => v.judge === "j2")?.verdict).toBe("revise")
  })

  test("learnings ordenados por createdAt desc", async () => {
    const root = await tmpRoot()
    await bb.addLearning(root, { kind: "ignore", text: "lint não gera ALERT", source: "user", weight: 1 })
    await bb.addLearning(root, { kind: "strategy", text: "usar ondas curtas", source: "stats", weight: 2 })
    const all = await bb.listLearnings(root)
    expect(all.length).toBe(2)
    expect(all[0].createdAt >= all[1].createdAt).toBe(true)
    expect((await bb.listLearnings(root, 2)).length).toBe(1)
  })

  test("waves create/get/update", async () => {
    const root = await tmpRoot()
    const w = await bb.createWave(root, {
      objective: "consertar suite",
      composition: { implementer: 10 },
      burstWindowSec: 120,
      budgetTokens: 1_000_000,
      timeboxMin: 60,
      gate: "merge-queue",
    })
    expect(w.status).toBe("open")
    expect(w.id.startsWith("wave-")).toBe(true)
    await bb.saveWave(root, { ...w, status: "running" })
    expect((await bb.getWave(root, w.id))?.status).toBe("running")
  })
})
