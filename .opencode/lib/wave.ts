import type { Result, Spec, Verdict } from "./blackboard"

export const WORKER_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "failed"] },
    confidence: { type: "number", description: "0 a 1" },
    notes: { type: "string" },
    files: { type: "array", items: { type: "string" } },
  },
  required: ["status", "confidence", "notes"],
} as const

export interface WorkerOutcome {
  status: "done" | "failed"
  confidence: number
  notes: string
  files: string[]
}

export function buildWorkerPrompt(spec: Spec, context: string): string {
  return [
    `Você é um worker da frota god-mode. Execute UMA spec e nada além dela.`,
    "",
    "## Spec",
    `id: ${spec.id} | onda: ${spec.wave ?? "—"} | papel: ${spec.role}`,
    `Título: ${spec.title}`,
    spec.files.length > 0 ? `Arquivos permitidos: ${spec.files.join(", ")}` : "Arquivos: livre, mas evite tocar fora do escopo da spec.",
    spec.acceptance.length > 0 ? ["Aceitação (comandos executáveis):", ...spec.acceptance.map((a) => `- ${a}`)].join("\n") : "",
    "",
    "## Contexto",
    context.trim() || "—",
    "",
    "## Regras",
    "- Reporte etapas importantes com report_progress.",
    "- Bloqueado ou precisando de decisão? Chame ask_boss (ela espera a resposta; se der timeout, siga no nível L0 e registre a decisão com report_progress).",
    "- Não faça commit nem push. Edite arquivos e rode os comandos de aceitação.",
    `- Orçamento: ${spec.budgetTokens} tokens. Timeout: ${spec.timeoutSec}s.`,
    "- Ao terminar, retorne via StructuredOutput (status, confidence, notes, files).",
  ]
    .filter(Boolean)
    .join("\n")
}

export function extractStructured(res: any): WorkerOutcome | null {
  const direct =
    res?.data?.info?.structured ??
    res?.info?.structured ??
    res?.data?.info?.structured_output ??
    res?.info?.structured_output
  if (direct && typeof direct === "object") return normalizeOutcome(direct)
  const parts: any[] = res?.data?.parts ?? res?.parts ?? []
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (p?.type === "tool" && p?.tool === "StructuredOutput") {
      const inp = p?.state?.input ?? p?.state?.output
      if (inp && typeof inp === "object") return normalizeOutcome(inp)
    }
    if (p?.type === "text" && typeof p.text === "string") {
      const text = p.text.trim()
      if (!text.startsWith("{")) continue
      try {
        return normalizeOutcome(JSON.parse(text))
      } catch {
        continue
      }
    }
  }
  return null
}

function normalizeOutcome(raw: any): WorkerOutcome | null {
  if (!raw || typeof raw !== "object") return null
  const status = raw.status === "done" ? "done" : "failed"
  const confidence = Number.isFinite(Number(raw.confidence)) ? Number(raw.confidence) : 0
  return {
    status,
    confidence: Math.min(Math.max(confidence, 0), 1),
    notes: typeof raw.notes === "string" ? raw.notes : "",
    files: Array.isArray(raw.files) ? raw.files.map(String) : [],
  }
}

export interface WaveResultRow {
  spec: Spec
  result: Result | null
  error?: string
}

export function buildWaveSummary(rows: WaveResultRow[]): string {
  const done = rows.filter((r) => r.result?.status === "done")
  const failed = rows.filter((r) => r.result && r.result.status !== "done")
  const errored = rows.filter((r) => r.error)
  const lines: string[] = []
  lines.push(`Onda: ${done.length}/${rows.length} done, ${failed.length} failed, ${errored.length} erro`)
  for (const r of rows) {
    const icon = r.error ? "✗" : r.result?.status === "done" ? "✓" : "!"
    const conf = r.result ? ` (conf ${(r.result.confidence * 100).toFixed(0)}%)` : ""
    const note = r.error ?? r.result?.notes ?? ""
    lines.push(`${icon} [${r.spec.id}] ${r.spec.title}${conf}${note ? ` — ${truncate(note, 140)}` : ""}`)
  }
  return lines.join("\n")
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

export function aggregateVerdicts(verdicts: Verdict[], threshold: number): { verdict: "accept" | "revise" | "reject"; minScore: number } {
  if (verdicts.length === 0) return { verdict: "revise", minScore: 0 }
  const minScore = Math.min(...verdicts.map((v) => v.score))
  const rejects = verdicts.filter((v) => v.verdict === "reject").length
  if (rejects > 0) return { verdict: "reject", minScore }
  if (verdicts.every((v) => v.verdict === "accept") && minScore >= threshold) return { verdict: "accept", minScore }
  return { verdict: "revise", minScore }
}
