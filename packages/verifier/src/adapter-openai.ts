/**
 * OpenAIJudgeAdapter — real LLM judge using gpt-4o-mini.
 *
 * Implements only the judgeEnsemble method of VerifierAdapter; compose with
 * DefaultVerifierAdapter for the others. The key is read from
 * process.env.OPENAI_API_KEY; if absent, falls back to the default heuristic
 * judges so tests stay deterministic without a key.
 *
 * Cost note: gpt-4o-mini is ~$0.15/1M input + ~$0.60/1M output tokens. Each
 * judge call is ~600 input + ~150 output tokens = ~$0.0001. Cheap.
 */

import OpenAI from "openai";
import type { ContributionInput } from "@commons/schema";
import type { JudgeScore, VerifierAdapter } from "./adapter.js";
import { DefaultVerifierAdapter } from "./adapter-default.js";

const JUDGE_SYSTEM_PROMPT = `You are a strict reviewer of code knowledge artifacts submitted to a shared library for AI agents.

Given a contribution (title, summary, publicPreview, payload, stack), score it from 0.0 to 1.0 on the following rubric and return JSON only.

Rubric:
- specificity (0.0-1.0): does the artifact name a concrete stack + version + symptom, or is it generic advice?
- runnability (0.0-1.0): does the payload contain code that another agent could literally execute?
- correctness (0.0-1.0): does the explanation match what actually happens in the named stack, to your knowledge?
- novelty (0.0-1.0): is this a non-obvious, valuable insight, or generic / training-data echo?

Then return an overall score = weighted average (0.35 * specificity + 0.30 * runnability + 0.25 * correctness + 0.10 * novelty).

Output JSON: {"specificity": 0.0, "runnability": 0.0, "correctness": 0.0, "novelty": 0.0, "score": 0.0, "reasoning": "one sentence"}.

Be skeptical. If anything smells like LLM filler, score correctness low.`;

export class OpenAIJudgeAdapter implements VerifierAdapter {
  private client: OpenAI | null;
  private fallback: VerifierAdapter;
  private model: string;

  constructor(opts: { apiKey?: string; model?: string; fallback?: VerifierAdapter } = {}) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.client = key ? new OpenAI({ apiKey: key }) : null;
    this.model = opts.model ?? "gpt-4o-mini";
    this.fallback = opts.fallback ?? new DefaultVerifierAdapter();
  }

  // Delegate non-judge methods to fallback.
  slopClassify = (c: ContributionInput) => this.fallback.slopClassify(c);
  dedupCheck: VerifierAdapter["dedupCheck"] = (c, corpus) =>
    this.fallback.dedupCheck(c, corpus);
  sandboxRun = (c: ContributionInput) => this.fallback.sandboxRun(c);

  async judgeEnsemble(contribution: ContributionInput): Promise<JudgeScore[]> {
    // No key → deterministic fallback. Tests are happy.
    if (!this.client) {
      return this.fallback.judgeEnsemble(contribution);
    }

    const userPrompt = renderContributionForJudge(contribution);

    try {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: "json_object" },
        temperature: 0.2,
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });

      const raw = resp.choices[0]?.message?.content ?? "{}";
      const parsed = safeParseJudgment(raw);
      if (!parsed) {
        // Malformed response → fall back rather than reject the artifact
        return this.fallback.judgeEnsemble(contribution);
      }

      return [
        {
          judge: `openai:${this.model}`,
          score: parsed.score,
          reasoning: parsed.reasoning,
        },
      ];
    } catch (err) {
      // Network / quota / etc. → fall back rather than block verification
      // eslint-disable-next-line no-console
      console.error("[commons:verifier] OpenAI judge call failed:", err);
      return this.fallback.judgeEnsemble(contribution);
    }
  }
}

/**
 * Compose multiple judge adapters into a single ensemble. Each adapter's
 * judgeEnsemble() result is concatenated. Non-judge methods come from the
 * first adapter (or its fallback).
 */
export function ensembleOf(...adapters: VerifierAdapter[]): VerifierAdapter {
  if (adapters.length === 0) return new DefaultVerifierAdapter();
  const head = adapters[0];
  return {
    slopClassify: (c) => head.slopClassify(c),
    dedupCheck: (c, corpus) => head.dedupCheck(c, corpus),
    sandboxRun: (c) => head.sandboxRun(c),
    async judgeEnsemble(c) {
      const results = await Promise.all(adapters.map((a) => a.judgeEnsemble(c)));
      return results.flat();
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderContributionForJudge(c: ContributionInput): string {
  // Truncate payload at a generous bound to control token cost
  const payload = c.payload.length > 6000 ? c.payload.slice(0, 6000) + "\n...[truncated]" : c.payload;
  const preview = c.publicPreview ?? "(none)";
  return [
    `Type: ${c.type}`,
    `Title: ${c.title}`,
    `Stack: ${c.context.stack.join(", ") || "(none)"}`,
    `Versions: ${JSON.stringify(c.context.versions ?? {})}`,
    "",
    `Summary:\n${c.summary}`,
    "",
    `Public preview:\n${preview}`,
    "",
    "Payload:",
    payload,
  ].join("\n");
}

interface Judgment {
  score: number;
  reasoning?: string;
}

function safeParseJudgment(raw: string): Judgment | null {
  try {
    const obj = JSON.parse(raw);
    const s = Number(obj.score);
    if (!Number.isFinite(s) || s < 0 || s > 1) return null;
    return {
      score: s,
      reasoning: typeof obj.reasoning === "string" ? obj.reasoning : undefined,
    };
  } catch {
    return null;
  }
}
