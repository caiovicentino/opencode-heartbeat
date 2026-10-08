import type { Result, Spec, Verdict } from "./blackboard"

export interface MergeGate {
  requireGreenSuite: boolean
  requireJudgeScore: number
}

export const DEFAULT_GATE: MergeGate = {
  requireGreenSuite: true,
  requireJudgeScore: 0,
}

export type MergeDecision = "merge" | "retry" | "escalate"

export interface MergeDecisionOut {
  decision: MergeDecision
  reason: string
}

export function decideMerge(
  spec: Spec,
  result: Result | null,
  verdicts: Verdict[],
  gate: MergeGate = DEFAULT_GATE,
): MergeDecisionOut {
  if (!result) return { decision: "retry", reason: "sem resultado registrado" }
  if (result.status === "timeout") return { decision: "retry", reason: "worker excedeu o timeout" }
  if (result.status === "cancelled") return { decision: "escalate", reason: "spec cancelada" }
  if (result.status !== "done") return { decision: "escalate", reason: `worker reportou ${result.status}: ${result.notes || "sem notas"}` }
  if (gate.requireGreenSuite) {
    if (spec.acceptance.length === 0) {
      return { decision: "retry", reason: "spec sem critérios de aceitação executáveis" }
    }
    if (result.checks.length === 0) {
      return { decision: "retry", reason: "nenhum check de aceitação foi rodado" }
    }
    const red = result.checks.filter((c) => !c.passed)
    if (red.length > 0) {
      return { decision: "retry", reason: `suite vermelha: ${red.map((c) => c.cmd).join("; ")}` }
    }
  }
  if (gate.requireJudgeScore > 0) {
    if (verdicts.length === 0) {
      return { decision: "retry", reason: `gate exige verdict ≥ ${gate.requireJudgeScore} e não há judges` }
    }
    const minScore = Math.min(...verdicts.map((v) => v.score))
    if (minScore < gate.requireJudgeScore) {
      return { decision: "retry", reason: `verdict mínimo ${minScore} < ${gate.requireJudgeScore}` }
    }
    if (verdicts.some((v) => v.verdict === "reject")) {
      return { decision: "escalate", reason: "algum judge rejeitou — escalar para humano" }
    }
  }
  return { decision: "merge", reason: "critérios satisfeitos" }
}

export function gateFromConstitution(cons: any): MergeGate {
  const g = cons?.mergeGate ?? {}
  return {
    requireGreenSuite: g.requireGreenSuite ?? DEFAULT_GATE.requireGreenSuite,
    requireJudgeScore: typeof g.requireJudgeScore === "number" ? g.requireJudgeScore : DEFAULT_GATE.requireJudgeScore,
  }
}

export function gitlessNotice(): string {
  return "merge queue: este projeto não é um repositório git — decisão calculada, execução real requer worktrees/repo (F2 completo)."
}
