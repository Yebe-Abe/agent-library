/**
 * DefaultVerifierAdapter — heuristic v0 implementations of every method.
 *
 * These are deliberately weak but the right *shape*. Replace any subset by
 * composing a different adapter (e.g. an Anthropic+OpenAI judge adapter +
 * an E2B sandbox adapter) without touching callers.
 */

import type { Artifact, ContributionInput } from "@commons/schema";
import type {
  DedupResult,
  JudgeScore,
  SandboxRunResult,
  SlopClassification,
  VerifierAdapter,
} from "./adapter.js";

const SLOP_MARKERS = [
  /^(here'?s? (an? )?(example|solution|implementation)|let me (help|explain|show))/i,
  /\bin (this|the following) (example|code)\b/i,
  /\bas an? (ai|language model)\b/i,
  /\bi (cannot|can not|am unable to)\b/i,
];

export class DefaultVerifierAdapter implements VerifierAdapter {
  slopClassify(contribution: ContributionInput): SlopClassification {
    const hits = SLOP_MARKERS.filter((rx) => rx.test(contribution.payload))
      .length;
    if (hits >= 2) {
      return {
        score: 0.85,
        reason:
          "Payload reads like generic LLM filler rather than specific novel signal. Lead with concrete code/context, drop the meta narration.",
      };
    }
    return { score: hits === 0 ? 0.05 : 0.3 };
  }

  dedupCheck(
    contribution: ContributionInput,
    corpus: Pick<Artifact, "id" | "title" | "summary" | "payload">[],
  ): DedupResult {
    const inputShingles = shingles(
      `${contribution.title}\n${contribution.summary}\n${contribution.payload}`,
    );
    let maxSim = 0;
    let nearest: string | undefined;
    for (const a of corpus) {
      const sim = cosine(
        inputShingles,
        shingles(`${a.title}\n${a.summary}\n${a.payload}`),
      );
      if (sim > maxSim) {
        maxSim = sim;
        nearest = a.id;
      }
    }
    return { maxSimilarity: maxSim, nearestArtifactId: nearest };
  }

  async judgeEnsemble(contribution: ContributionInput): Promise<JudgeScore[]> {
    // Simulated heterogeneous judges. Deterministic-ish so tests pass.
    return [
      { judge: "claude-stub", score: judgeScoreSync(contribution, "claude") },
      { judge: "gpt-stub", score: judgeScoreSync(contribution, "gpt") },
      { judge: "open-stub", score: judgeScoreSync(contribution, "open") },
    ];
  }

  async sandboxRun(
    contribution: ContributionInput,
  ): Promise<SandboxRunResult | null> {
    // v0: we don't run code. Returning null means "no sandbox signal";
    // Stage 2 falls back to judge ensemble alone for non-code or unrunnable
    // artifacts.
    void contribution;
    return null;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function judgeScoreSync(
  c: ContributionInput,
  bias: "claude" | "gpt" | "open",
): number {
  const payload = c.payload;
  let s = 0;
  s += Math.min(0.35, payload.length / 2000);
  if (/```[a-zA-Z]+\n/.test(payload)) s += 0.2;
  if (/(Error|Exception|TypeError|undefined|null|stack trace)/.test(payload))
    s += 0.15;
  if (c.context.stack.length >= 2) s += 0.15;
  if (c.context.versions && Object.keys(c.context.versions).length >= 1)
    s += 0.1;
  const jitter =
    bias === "claude" ? 0.03 : bias === "gpt" ? -0.02 : 0.01;
  return Math.max(0, Math.min(1, s + jitter));
}

function shingles(text: string, k = 4): Map<string, number> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const m = new Map<string, number>();
  for (let i = 0; i + k <= tokens.length; i++) {
    const sh = tokens.slice(i, i + k).join(" ");
    m.set(sh, (m.get(sh) ?? 0) + 1);
  }
  return m;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [, v] of a) na += v * v;
  for (const [, v] of b) nb += v * v;
  for (const [k, v] of a) {
    const bv = b.get(k);
    if (bv) dot += v * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
