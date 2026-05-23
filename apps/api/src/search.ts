/**
 * v0 search ranking. BM25-ish lexical + outcome-weighted score.
 * No vectors yet — that lands when we move to Postgres + pgvector.
 *
 * The function shape (query → ranked previews) is what matters; the internals
 * are deliberately swappable.
 */

import type { Artifact, ArtifactContext, SearchResultPreview } from
  "@commons/schema";

export interface SearchInput {
  intent: string;
  context?: ArtifactContext;
  limit?: number;
}

export function search(
  artifacts: Artifact[],
  input: SearchInput,
): SearchResultPreview[] {
  const intentTokens = tokenize(input.intent);
  const stackSet = new Set(input.context?.stack ?? []);

  const scored = artifacts
    // Only published (stage 2 passed) artifacts surface in search. Probationary
    // artifacts are invisible until they pass.
    .filter((a) => a.published)
    .map((a) => {
      const text =
        `${a.title} ${a.summary} ${a.context.tags.join(" ")} ` +
        `${a.context.stack.join(" ")}`;
      const lexical = bm25Lite(intentTokens, tokenize(text));
      const stackOverlap = stackSet.size === 0
        ? 0
        : a.context.stack.filter((s) => stackSet.has(s)).length /
          Math.max(1, stackSet.size);
      const outcomeBoost = outcomeScore(a);
      const score =
        0.55 * lexical + 0.25 * stackOverlap + 0.2 * outcomeBoost;
      return { artifact: a, score };
    })
    .filter((s) => s.score > 0.01)
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit ?? 10);

  return scored.map(({ artifact, score }) => {
    const totalOutcomes = artifact.outcomes.length;
    const helpedCount = artifact.outcomes.filter((o) => o.helped).length;
    return {
      artifactId: artifact.id,
      type: artifact.type,
      title: artifact.title,
      summary: artifact.summary,
      context: artifact.context,
      score: round(score),
      unlockCost: 1, // CREDITS.fullPayloadCost
      helpedCount,
      totalOutcomes,
      verificationStatus: artifact.verification.status,
    };
  });
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

function outcomeScore(a: Artifact): number {
  if (a.outcomes.length === 0) return 0.3; // small prior so new artifacts can surface
  const helped = a.outcomes.filter((o) => o.helped).length;
  return helped / a.outcomes.length;
}

function bm25Lite(
  queryTokens: string[],
  docTokens: string[],
): number {
  if (queryTokens.length === 0 || docTokens.length === 0) return 0;
  const docSet = new Set(docTokens);
  let hits = 0;
  for (const qt of queryTokens) if (docSet.has(qt)) hits++;
  return hits / queryTokens.length;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
