import { describe, expect, test } from "bun:test"
import * as pb from "../.opencode/lib/postbox"
import * as bb from "../.opencode/lib/blackboard"

async function tmpRoot(): Promise<string> {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  return await fs.mkdtemp(`${os.tmpdir()}/pb-`)
}

describe("postbox asks", () => {
  test("createAsk + unseen + markSeen + answer", async () => {
    const root = await tmpRoot()
    const a1 = await pb.createAsk(root, { spec: "spec-1", session: "s1", question: "jitter ou exponential?", options: ["jitter", "exponential"] })
    const a2 = await pb.createAsk(root, { spec: null, session: "s2", question: "posso tocar em README?", options: [] })
    expect(a1.id.startsWith("ask-")).toBe(true)
    expect((await pb.unseenAsks(root)).length).toBe(2)
    await pb.markAsksSeen(root, [a1.id])
    const unseen = await pb.unseenAsks(root)
    expect(unseen.length).toBe(1)
    expect(unseen[0].id).toBe(a2.id)
    const answered = await pb.answerAsk(root, a1.id, "use jitter, 3 tentativas")
    expect(answered?.status).toBe("answered")
    expect(answered?.answer).toContain("jitter")
    expect((await pb.unseenAsks(root)).length).toBe(1)
  })

  test("expire e gcAsks", async () => {
    const root = await tmpRoot()
    const a = await pb.createAsk(root, { spec: null, session: "s1", question: "q", options: [] })
    await pb.expireAsk(root, a.id)
    expect((await pb.getAsk(root, a.id))?.status).toBe("expired")
    const b = await pb.createAsk(root, { spec: null, session: "s2", question: "q2", options: [] })
    const now = Date.now()
    expect(await pb.gcAsks(root, 60_000, now + 120_000)).toBe(1)
    expect((await pb.getAsk(root, b.id))?.status).toBe("expired")
  })
})

describe("postbox progress", () => {
  test("addProgress + listProgressSince", async () => {
    const root = await tmpRoot()
    const before = Date.now()
    await pb.addProgress(root, "spec-1", "s1", "começando", "start")
    await pb.addProgress(root, "spec-1", "s1", "50% pronto")
    await pb.addProgress(root, "spec-2", "s2", "outro worker")
    const all = await pb.listProgressSince(root, 0)
    expect(all.length).toBe(3)
    const recent = await pb.listProgressSince(root, before - 1_000)
    expect(recent.length).toBe(3)
    const sinceFuture = await pb.listProgressSince(root, before + 3_600_000)
    expect(sinceFuture.length).toBe(0)
    expect(all[0].status).toBe("start")
  })
})

describe("postbox steers", () => {
  test("record + update + list por spec", async () => {
    const root = await tmpRoot()
    const r = await pb.recordSteer(root, { spec: "spec-1", session: "s1", instruction: "pare em auth.ts", status: "queued", deliveredAt: null, error: null })
    expect(r.id.startsWith("steer-")).toBe(true)
    await pb.updateSteer(root, { ...r, status: "delivered", deliveredAt: Date.now() })
    const list = await pb.listSteers(root, "spec-1")
    expect(list.length).toBe(1)
    expect(list[0].status).toBe("delivered")
    expect(await pb.listSteers(root, "spec-9")).toEqual([])
  })
})

describe("postbox claim lookup", () => {
  test("findSpecBySession via claims do blackboard", async () => {
    const root = await tmpRoot()
    await bb.ensure(root)
    const spec = await bb.createSpec(root, { title: "A" })
    await bb.claimSpec(root, spec.id, "sess-worker-1", "local", 60)
    expect(await pb.findSpecBySession(root, "sess-worker-1")).toBe(spec.id)
    expect(await pb.findSpecBySession(root, "sess-desconhecida")).toBe(null)
  })
})
