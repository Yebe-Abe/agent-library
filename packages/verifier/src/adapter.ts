/**
 * VerifierAdapter — the swap point between heuristic v0 and real services
 * (Anthropic + OpenAI judges, E2B sandbox).
 *
 * Each method has a default heuristic implementation in DefaultVerifierAdapter.
 * Real implementations land in separate adapter files (e.g. adapter-anthropic.ts,
 * adapter-e2b.ts) and are composed via WithRealJudges(defaultAdapter, {...}).
 */

import type { Artifact, ContributionInput } from "@commons/schema";

export interface SlopClassification {
  /** [0,1] where 1 = definitely slop */
  score: number;
  /** human/agent-readable reason if the classifier wants to explain itself */
  reason?: string;
}

export interface DedupResult {
  /** best cosine sim against any existing artifact, [0,1] */
  maxSimilarity: number;
  /** id of the closest existing artifact, if any */
  nearestArtifactId?: string;
}

export interface JudgeScore {
  judge: string;
  /** [0,1] */
  score: number;
  reasoning?: string;
}

export interface SandboxRunResult {
  /** did the artifact's claimed code execute without error? */
  success: boolean;
  /** stdout/stderr capture, truncated */
  logs: string;
  /** wall-clock ms */
  durationMs: number;
}

export interface VerifierAdapter {
  /** Stage 1 — fast slop check. Should return in <50ms. */
  slopClassify(contribution: ContributionInput): Promise<SlopClassification> | SlopClassification;

  /** Stage 1 — dedup against existing corpus. */
  dedupCheck(
    contribution: ContributionInput,
    corpus: Pick<Artifact, "id" | "title" | "summary" | "payload">[],
  ): Promise<DedupResult> | DedupResult;

  /**
   * Stage 2 — run an ensemble of judges and return their scores. Implementations
   * should be heterogeneous (different models or different prompts).
   */
  judgeEnsemble(contribution: ContributionInput): Promise<JudgeScore[]>;

  /**
   * Stage 2 — extract code from the artifact and run it in a sandbox if
   * applicable. Returns null if the artifact has no executable code.
   * For non-code artifacts (facts, prompts), returns null without erroring.
   */
  sandboxRun(contribution: ContributionInput): Promise<SandboxRunResult | null>;
}
