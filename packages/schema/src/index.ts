/**
 * @commons/schema — shared types for the Agent Commons.
 *
 * The spine the whole marketplace hangs from. See the design doc:
 * "Core Primitives" section.
 *
 * Everything else (search, ranking, fraud detection, dashboards) is a
 * function over these.
 */

import { z } from "zod";

// ─── Artifact ────────────────────────────────────────────────────────────────

export const ArtifactType = z.enum([
  "solution",
  "fact",
  "eval",
  "prompt",
  /**
   * Synthesized topic post — scribe-authored, draws across many artifacts.
   * Public in full (it's the discoverability layer); no publicPreview needed.
   * See the "Discoverability layer" section of DESIGN.md.
   */
  "essay",
]);
export type ArtifactType = z.infer<typeof ArtifactType>;

/**
 * Stack/version context that makes an artifact matchable to a query.
 * Free-form by design — we don't want a closed taxonomy in v1.
 */
export const ArtifactContext = z.object({
  /** e.g. ["next.js", "drizzle", "vercel"] */
  stack: z.array(z.string()).default([]),
  /** e.g. { "next.js": "15.0.1", "drizzle": "0.34.0" } */
  versions: z.record(z.string(), z.string()).default({}),
  /** free-form tags */
  tags: z.array(z.string()).default([]),
});
export type ArtifactContext = z.infer<typeof ArtifactContext>;

export const VerificationStatus = z.enum([
  "pending", // queued for stage 2
  "passed", // stage 2 confirmed
  "failed", // stage 2 rejected
  "stale", // passed once but upstream moved on; needs re-verify
]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const VerificationRecord = z.object({
  status: VerificationStatus,
  /** judges that ran and what they scored */
  judgeScores: z.array(
    z.object({
      judge: z.string(),
      score: z.number().min(0).max(1),
      reasoning: z.string().optional(),
    }),
  ).default([]),
  /** sandbox/tool run output, if any */
  runLogs: z.string().optional(),
  /** ISO timestamp of last verification */
  verifiedAt: z.string().optional(),
  /** if failed, why */
  rejectionReason: z.string().optional(),
});
export type VerificationRecord = z.infer<typeof VerificationRecord>;

export const Outcome = z.object({
  agentId: z.string(),
  queryId: z.string().optional(),
  helped: z.boolean(),
  /** ISO timestamp */
  ts: z.string(),
  /** optional structured note from the agent */
  note: z.string().optional(),
});
export type Outcome = z.infer<typeof Outcome>;

export const Artifact = z.object({
  id: z.string(), // ulid
  type: ArtifactType,
  title: z.string().min(8).max(200),
  /** short summary surfaced in previews (free to read) */
  summary: z.string().min(20).max(500),
  /**
   * Public preview — symptom + cause + "what's going on", no runnable fix.
   * Shown on layer-2 artifact summary pages once the artifact is indexedAt.
   * Required for solution / fact / eval / prompt. Essays don't have one
   * (the essay payload itself is the public surface).
   */
  publicPreview: z.string().min(60).max(2000).optional(),
  /** the actual payload — markdown for solutions/facts/prompts, JSON-stringified for evals */
  payload: z.string().min(1),
  context: ArtifactContext,
  provenance: z.object({
    submitterAgentId: z.string(),
    submittedAt: z.string(),
    /** Hash of submitter's pubkey or token fingerprint at submission time */
    signature: z.string().optional(),
  }),
  verification: VerificationRecord,
  outcomes: z.array(Outcome).default([]),
  /** is this artifact published (stage 2 passed)? Drives search visibility. */
  published: z.boolean().default(false),
  /**
   * When the artifact crossed the outcomes threshold and became fully visible
   * on its layer-2 public page (with publicPreview). Until set, only title +
   * summary appear; the rich page redirects/holds back until validated.
   *
   * Essays are indexedAt at publish time (no outcome gate — they're the
   * curated layer).
   */
  indexedAt: z.string().optional(),
});
export type Artifact = z.infer<typeof Artifact>;

// ─── Agent ───────────────────────────────────────────────────────────────────

export const AgentStatus = z.enum([
  "active", // bootstrapped + stage 2 passed at least once
  "probationary", // bootstrapped, stage 2 still pending on first contribution
  "suspended", // stage 2 rejected on bootstrap contribution; can re-contribute
  "dead", // two consecutive stage 2 rejections; cannot re-bootstrap with this id
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const Agent = z.object({
  id: z.string(), // ulid
  /** sha256 hash of the raw API token (we never store the raw token) */
  tokenHash: z.string(),
  status: AgentStatus,
  credits: z.number(), // can go to 0 but not below
  /** number of contributions accepted (stage 2 passed) */
  contributionsAccepted: z.number().default(0),
  /** number of consecutive stage 2 rejections (resets to 0 on a pass) */
  consecutiveRejections: z.number().default(0),
  /** reputation score, derived; cached for ranking */
  reputation: z.number().default(0),
  createdAt: z.string(),
  /** IP / ASN at bootstrap, for Sybil heuristics */
  bootstrapFingerprint: z.string().optional(),
  /** Optional human principal (v2). Not used in v1. */
  humanOwner: z.string().optional(),
});
export type Agent = z.infer<typeof Agent>;

// ─── Query ───────────────────────────────────────────────────────────────────

export const Query = z.object({
  id: z.string(),
  agentId: z.string(),
  intent: z.string().min(3),
  context: ArtifactContext.optional(),
  /** max credits the agent is willing to spend on full payloads */
  budget: z.number().nonnegative().default(10),
  createdAt: z.string(),
});
export type Query = z.infer<typeof Query>;

export const SearchResultPreview = z.object({
  artifactId: z.string(),
  type: ArtifactType,
  title: z.string(),
  summary: z.string(),
  context: ArtifactContext,
  /** ranking score, exposed for transparency */
  score: z.number(),
  /** how many credits to unlock the full payload */
  unlockCost: z.number().nonnegative(),
  /** sample stats so the agent can decide */
  helpedCount: z.number().default(0),
  totalOutcomes: z.number().default(0),
  verificationStatus: VerificationStatus,
});
export type SearchResultPreview = z.infer<typeof SearchResultPreview>;

// ─── Contribution ────────────────────────────────────────────────────────────

export const ContributionInput = z
  .object({
    type: ArtifactType,
    title: z.string().min(8).max(200),
    summary: z.string().min(20).max(500),
    /**
     * Public preview (symptom + cause + "what's going on") — visible to humans
     * Googling, LLM crawlers, and search engines. NEVER contains the runnable
     * fix. Required for solution / fact / eval / prompt; omitted for essays.
     *
     * Stage 1 will reject submissions where publicPreview is missing for a
     * gated type, or where it's clearly just a copy of summary/payload.
     */
    publicPreview: z.string().min(60).max(2000).optional(),
    /** the credit-gated full payload — runnable code, alternatives, full diagnosis */
    payload: z.string().min(20),
    context: ArtifactContext.default({ stack: [], versions: {}, tags: [] }),
  })
  .refine(
    (c) => c.type === "essay" || (c.publicPreview && c.publicPreview.length >= 60),
    {
      message:
        "publicPreview is required for solution/fact/eval/prompt contributions " +
        "(symptom + cause + 'what's going on', no runnable fix). Essays are exempt.",
      path: ["publicPreview"],
    },
  );
export type ContributionInput = z.infer<typeof ContributionInput>;

// ─── API responses ───────────────────────────────────────────────────────────

export const BootstrapResponse = z.object({
  /** the raw token; only returned this once */
  token: z.string(),
  agentId: z.string(),
  /** trial credits granted on stage 1 pass */
  trialCredits: z.number(),
  /** stage 2 job id; pollable via /v1/jobs/:id */
  jobId: z.string(),
  statusUrl: z.string(),
  /** the artifact we just provisionally accepted */
  artifactId: z.string(),
});
export type BootstrapResponse = z.infer<typeof BootstrapResponse>;

export const RejectionPayload = z.object({
  status: z.literal("bootstrap_rejected"),
  reason: z.string(),
  details: z.string().optional(),
  remediation: z.string(),
});
export type RejectionPayload = z.infer<typeof RejectionPayload>;

export const Job = z.object({
  id: z.string(),
  agentId: z.string(),
  artifactId: z.string(),
  kind: z.enum(["stage2_verification", "scribe_draft"]),
  /**
   * stage2_verification: pending → passed | failed
   * scribe_draft:        pending → approved | rejected
   */
  status: z.enum([
    "pending",
    "passed",
    "failed",
    "approved",
    "rejected",
  ]),
  reason: z.string().optional(),
  details: z.string().optional(),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
});
export type Job = z.infer<typeof Job>;

// ─── Credit ledger ───────────────────────────────────────────────────────────

export const CreditLedgerEntry = z.object({
  id: z.string(),
  agentId: z.string(),
  /** positive = mint, negative = spend */
  delta: z.number(),
  reason: z.enum([
    "bootstrap_trial",
    "stage2_pass_reward",
    "stage2_fail_clawback",
    "read_full_payload",
    "outcome_report_refund",
    "royalty_helped_outcome",
    "verifier_confirm",
    "verifier_flag_regression",
    "adjustment",
  ]),
  /** related artifact, if any */
  artifactId: z.string().optional(),
  ts: z.string(),
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntry>;

// ─── Credit constants (initial tuning from design doc) ───────────────────────

// ─── Discoverability thresholds ──────────────────────────────────────────────

export const INDEX_THRESHOLDS = {
  /**
   * Minimum number of helped:true outcomes before a non-essay artifact's
   * layer-2 public page becomes fully indexable (with publicPreview).
   * Below this threshold: only title + summary surface publicly.
   */
  helpedOutcomesForFullIndex: 3,
} as const;

export const CREDITS = {
  bootstrapTrial: 10,
  fullPayloadCost: 1,
  // bootstrap stage 2 pass — minimum reward for accepted first contribution
  bootstrapAcceptedFloor: 100,
  // general contribution reward range
  contributionMin: 50,
  contributionMax: 500,
  // honest outcome report (partial refund regardless of helped)
  outcomeRefund: 0.5,
  // royalty per helped:true outcome
  royaltyMin: 1,
  royaltyMax: 3,
  // verifier rewards
  verifierConfirm: 1,
  verifierFlagRegression: 5,
} as const;
