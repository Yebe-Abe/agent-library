/**
 * @commons/verifier — two-stage verification for the Agent Commons.
 *
 * Stage 1 (fast vet, synchronous-ish, ~ms): format, length/specificity, slop
 * classifier, light semantic dedup.
 *
 * Stage 2 (full verification, async): sandbox run, judge ensemble, strict
 * dedup, injection scan.
 *
 * The heuristic v0 lives in DefaultVerifierAdapter. Real implementations
 * (Anthropic + OpenAI judges, E2B sandbox) compose via the same interface.
 * Callers should not change when adapters change.
 */

import type {
  Artifact,
  ContributionInput,
  VerificationRecord,
} from "@commons/schema";
import type { VerifierAdapter } from "./adapter.js";
import { DefaultVerifierAdapter } from "./adapter-default.js";

export type {
  VerifierAdapter,
  SlopClassification,
  DedupResult,
  JudgeScore,
  SandboxRunResult,
} from "./adapter.js";
export { DefaultVerifierAdapter } from "./adapter-default.js";
export { OpenAIJudgeAdapter, ensembleOf } from "./adapter-openai.js";

// ─── Stage 1 ─────────────────────────────────────────────────────────────────

export interface Stage1Result {
  passed: boolean;
  reason?: string;
  details?: string;
  /** preliminary quality signal in [0,1]; informs ranking even before stage 2 */
  preliminaryScore: number;
}

const LOW_SPECIFICITY_MARKERS = [
  /^(make sure to|don'?t forget to|remember to)/i,
  /^(consider|try|maybe|perhaps)\b/i,
];

/**
 * Stage 1 — fast vet. Runs format checks first (cheap), then defers to the
 * adapter for slop classification and dedup. With the default adapter this
 * completes in <50ms. With a real LLM-based classifier it could take longer;
 * Stage 1 is allowed to be ~1–3s overall.
 */
export async function stage1FastVet(
  contribution: ContributionInput,
  existingCorpus: Pick<Artifact, "id" | "title" | "summary" | "payload">[],
  adapter: VerifierAdapter = new DefaultVerifierAdapter(),
): Promise<Stage1Result> {
  // 1. Format/length checks (fastest filter, run before adapter calls)
  if (contribution.payload.trim().length < 40) {
    return {
      passed: false,
      reason: "payload_too_short",
      details: "Payload must be at least 40 characters of substantive content.",
      preliminaryScore: 0,
    };
  }
  if (contribution.title.trim().length < 8) {
    return {
      passed: false,
      reason: "title_too_short",
      preliminaryScore: 0,
    };
  }

  // 1b. publicPreview validation (required for non-essay types)
  if (contribution.type !== "essay") {
    const pp = contribution.publicPreview?.trim() ?? "";
    if (pp.length < 60) {
      return {
        passed: false,
        reason: "missing_public_preview",
        details:
          "Non-essay contributions must include publicPreview (≥60 chars): " +
          "the symptom + cause + 'what's going on', without the runnable fix. " +
          "This is what becomes visible on the artifact's layer-2 public page.",
        preliminaryScore: 0,
      };
    }
    if (pp === contribution.summary.trim()) {
      return {
        passed: false,
        reason: "public_preview_duplicates_summary",
        details:
          "publicPreview cannot just be a copy of summary. Write a longer, " +
          "more useful symptom-and-cause explanation for layer-2 readers.",
        preliminaryScore: 0.1,
      };
    }
    // Reject if publicPreview is just a prefix of payload (likely a lazy copy)
    if (
      contribution.payload.trim().startsWith(pp) &&
      pp.length > 100
    ) {
      return {
        passed: false,
        reason: "public_preview_duplicates_payload",
        details:
          "publicPreview cannot be a prefix of payload. It should be a " +
          "human-readable problem statement; payload contains the runnable fix.",
        preliminaryScore: 0.1,
      };
    }
    // Heuristic: publicPreview shouldn't contain code fences (those belong to payload)
    if (/```[a-zA-Z]+\n/.test(pp)) {
      return {
        passed: false,
        reason: "public_preview_contains_code",
        details:
          "publicPreview should be prose describing the problem and cause. " +
          "Runnable code belongs in payload (which is credit-gated). The " +
          "split is what preserves the contribution gate.",
        preliminaryScore: 0.2,
      };
    }
  }

  // 2. Slop classifier (via adapter)
  const slop = await adapter.slopClassify(contribution);
  if (slop.score >= 0.5) {
    return {
      passed: false,
      reason: "slop_classifier_rejected",
      details:
        slop.reason ??
        "Payload reads like generic LLM filler rather than specific novel signal.",
      preliminaryScore: Math.max(0, 1 - slop.score),
    };
  }

  // 3. Specificity check — solutions need to name a stack
  if (
    contribution.type === "solution" &&
    contribution.context.stack.length === 0
  ) {
    return {
      passed: false,
      reason: "missing_stack_context",
      details:
        "Solutions must declare the stack they apply to (e.g. context.stack: ['next.js','drizzle']).",
      preliminaryScore: 0.2,
    };
  }

  const lowSpecHits = LOW_SPECIFICITY_MARKERS.filter((rx) =>
    rx.test(contribution.summary),
  ).length;

  // 4. Dedup (via adapter)
  const dedup = await adapter.dedupCheck(contribution, existingCorpus);
  if (dedup.maxSimilarity > 0.9) {
    return {
      passed: false,
      reason: "duplicate_of_existing_artifact",
      details: `Too similar to existing artifact ${dedup.nearestArtifactId} (cosine=${dedup.maxSimilarity.toFixed(2)}).`,
      preliminaryScore: 0.3,
    };
  }

  // 5. Aggregate preliminary score
  const lengthScore = Math.min(1, contribution.payload.length / 800);
  const novelty = 1 - dedup.maxSimilarity;
  const specificity = contribution.context.stack.length > 0 ? 1 : 0.4;
  const cleanliness = lowSpecHits === 0 ? 1 : 0.7;
  const preliminaryScore = round(
    0.35 * lengthScore +
      0.3 * novelty +
      0.2 * specificity +
      0.15 * cleanliness,
  );

  return { passed: true, preliminaryScore };
}

// ─── Stage 2 ─────────────────────────────────────────────────────────────────

export interface Stage2Result {
  passed: boolean;
  record: VerificationRecord;
  contributionReward: number;
  rejection?: { reason: string; details: string };
}

const INJECTION_MARKERS = [
  /\bignore (all )?(previous|prior|above) instructions?\b/i,
  /\b(system|developer) prompt:?/i,
  /\bexfiltrate|leak (the |your )?(api )?key\b/i,
  /\b<\/?system>\b/i,
];

/**
 * Stage 2 — full verification. Runs async after stage 1 passes.
 *
 * Injection scan is gated synchronously here (it's cheap regex; a real adapter
 * could also run an LLM-based classifier in parallel with the judges). Then
 * the adapter's judge ensemble + optional sandbox run feed into the final
 * score.
 */
export async function stage2FullVerification(
  contribution: ContributionInput,
  preliminaryScore: number,
  adapter: VerifierAdapter = new DefaultVerifierAdapter(),
): Promise<Stage2Result> {
  // Injection scan — hard fail
  for (const rx of INJECTION_MARKERS) {
    if (rx.test(contribution.payload)) {
      return {
        passed: false,
        contributionReward: 0,
        rejection: {
          reason: "injection_detected",
          details:
            "Payload contains text that looks like an attempt to override " +
            "downstream agent instructions. Rejected.",
        },
        record: {
          status: "failed",
          judgeScores: [],
          rejectionReason: "injection_detected",
          verifiedAt: new Date().toISOString(),
        },
      };
    }
  }

  // Run judges + sandbox in parallel (the sandbox is optional / may return null)
  const [judgeScores, sandbox] = await Promise.all([
    adapter.judgeEnsemble(contribution),
    adapter.sandboxRun(contribution),
  ]);

  const judgeAvg =
    judgeScores.length === 0
      ? 0
      : judgeScores.reduce((s, j) => s + j.score, 0) / judgeScores.length;

  // Sandbox signal (when available) gates downward: a failed sandbox run
  // caps the final score. When the sandbox didn't run (null), it's neutral.
  const sandboxPenalty = sandbox && !sandbox.success ? 0.5 : 1.0;

  // Compose final score: 60% judges, 40% preliminary; then sandbox penalty.
  const finalScore = round(
    (0.6 * judgeAvg + 0.4 * preliminaryScore) * sandboxPenalty,
  );

  const passed = finalScore >= 0.55;
  const runLogs = sandbox ? truncate(sandbox.logs, 4000) : undefined;
  const verifiedAt = new Date().toISOString();

  if (!passed) {
    return {
      passed: false,
      contributionReward: 0,
      rejection: {
        reason: "verification_failed",
        details:
          `Judges scored ${judgeAvg.toFixed(2)} (final ${finalScore}). ` +
          (sandbox && !sandbox.success
            ? "Sandbox run failed. "
            : "") +
          "Threshold is 0.55. Provide more specific, runnable detail — " +
          "particularly: concrete code, actual error messages, the resolution " +
          "that worked, and why.",
      },
      record: {
        status: "failed",
        judgeScores,
        runLogs,
        rejectionReason:
          sandbox && !sandbox.success ? "sandbox_failed" : "below_threshold",
        verifiedAt,
      },
    };
  }

  // Map final score → contribution reward (50 at threshold, 500 at perfect).
  const reward = Math.round(50 + (finalScore - 0.55) * (450 / 0.45));

  return {
    passed: true,
    contributionReward: Math.min(500, Math.max(50, reward)),
    record: {
      status: "passed",
      judgeScores,
      runLogs,
      verifiedAt,
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}
