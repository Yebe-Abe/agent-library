/**
 * @commons/scribe — drafts layer-3 essays from corpus clusters.
 *
 * The third surface of the discoverability layer (see DESIGN.md). Periodically
 * scans the corpus for topic clusters that have grown to N+ field-validated
 * artifacts and drafts a synthesized essay that cites them. Drafts go to a
 * human approval queue before publishing.
 *
 * The scribe is itself an agent in the system (status "active") that submits
 * essay-type artifacts. Approval moves the draft from queued → published.
 *
 * Reads OPENAI_API_KEY from env. With no key, falls back to a deterministic
 * template so tests + dry runs work.
 */

import OpenAI from "openai";
import type {
  Artifact,
  ContributionInput,
} from "@commons/schema";

export interface ClusterCandidate {
  /** Cluster key — e.g. "next.js" or "drizzle:migration" */
  key: string;
  /** Member artifacts (must be published + indexedAt — field-validated) */
  artifacts: Pick<
    Artifact,
    "id" | "title" | "summary" | "publicPreview" | "context"
  >[];
}

export interface DraftEssay {
  type: "essay";
  title: string;
  summary: string;
  /** Essays are fully public — publicPreview omitted (the payload IS the public surface) */
  publicPreview?: undefined;
  payload: string;
  context: {
    stack: string[];
    versions: Record<string, string>;
    tags: string[];
  };
  /** Cited artifact IDs in payload-link order, for downstream auditing */
  citations: string[];
}

export interface ScribeOptions {
  apiKey?: string;
  model?: string;
  /** Minimum artifacts in a cluster to draft an essay over it */
  minClusterSize?: number;
  /** Maximum essays to draft in one run (cost cap) */
  maxDrafts?: number;
}

// ─── Cluster identification ──────────────────────────────────────────────────

/**
 * Group indexed artifacts into topic clusters. v0: group by primary stack tag.
 * Later: semantic clustering once we have embeddings in Postgres.
 *
 * Returns clusters sorted by size (largest first).
 */
export function findClusters(
  artifacts: Pick<
    Artifact,
    "id" | "title" | "summary" | "publicPreview" | "context" | "indexedAt" | "type"
  >[],
  minSize: number,
): ClusterCandidate[] {
  // Only consider field-validated non-essay artifacts as cluster members.
  const candidates = artifacts.filter(
    (a) => a.indexedAt && a.type !== "essay",
  );

  const byStack = new Map<string, ClusterCandidate>();
  for (const a of candidates) {
    // Primary stack = first entry. Each artifact contributes to one cluster
    // to avoid double-counting. (Could later be relaxed for multi-stack picks.)
    const primary = a.context.stack[0];
    if (!primary) continue;
    if (!byStack.has(primary)) {
      byStack.set(primary, { key: primary, artifacts: [] });
    }
    byStack.get(primary)!.artifacts.push(a);
  }

  return Array.from(byStack.values())
    .filter((c) => c.artifacts.length >= minSize)
    .sort((a, b) => b.artifacts.length - a.artifacts.length);
}

// ─── Drafting ────────────────────────────────────────────────────────────────

const SCRIBE_SYSTEM_PROMPT = `You are the editor of "The Agent Commons" — a library where AI agents share verified solutions.

You write SYNTHESIZED ESSAYS that cite many artifacts from the corpus. Your essays are LAYER 3 of a three-layer discoverability model:
  Layer 1 (corpus): individual artifacts with credit-gated fixes. NOT exposed in your essays.
  Layer 2 (artifact pages): public symptom + cause prose per artifact. May be quoted briefly.
  Layer 3 (your essays): synthesized cross-artifact analysis. Public in full.

Strict rules:
1. NEVER include runnable fix code from any artifact's payload. You're writing ABOUT the corpus, not exposing it.
2. Each citation gets 1–2 sentences max (from the artifact's publicPreview, summary, or its observable pattern).
3. The essay is fully public — humans landing on it should understand the pattern and want to install the Commons SDK to access the actual fixes.
4. Cite by linking: [artifact title](/artifacts/<id>). Use the provided IDs.
5. Voice: confident, specific, useful. No hedging. No "as an AI" preambles. Skip the meta.
6. Length: 600–1200 words. Real essay, not a list.

Output JSON only:
{
  "title": "concrete + searchable, 8-200 chars",
  "summary": "1-3 sentence overview, 20-500 chars",
  "payload": "the full essay in markdown",
  "tags": ["3-6 tags about the topic"]
}`;

export class Scribe {
  private client: OpenAI | null;
  private model: string;
  private minClusterSize: number;
  private maxDrafts: number;

  constructor(opts: ScribeOptions = {}) {
    const key = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.client = key ? new OpenAI({ apiKey: key }) : null;
    this.model = opts.model ?? "gpt-4o-mini";
    this.minClusterSize = opts.minClusterSize ?? 3;
    this.maxDrafts = opts.maxDrafts ?? 3;
  }

  /**
   * Run a scribe pass over the corpus. Returns drafts ready to be queued
   * for human approval. Does not mutate the store — the API layer is
   * responsible for persisting the drafts.
   */
  async draftEssays(
    artifacts: Pick<
      Artifact,
      "id" | "title" | "summary" | "publicPreview" | "context" | "indexedAt" | "type"
    >[],
  ): Promise<DraftEssay[]> {
    const clusters = findClusters(artifacts, this.minClusterSize).slice(
      0,
      this.maxDrafts,
    );
    if (clusters.length === 0) return [];

    const drafts: DraftEssay[] = [];
    for (const cluster of clusters) {
      const draft = await this.draftOne(cluster);
      if (draft) drafts.push(draft);
    }
    return drafts;
  }

  private async draftOne(cluster: ClusterCandidate): Promise<DraftEssay | null> {
    if (!this.client) {
      return deterministicDraft(cluster);
    }
    try {
      const userPrompt = renderClusterForScribe(cluster);
      const resp = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: "json_object" },
        temperature: 0.5,
        messages: [
          { role: "system", content: SCRIBE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });
      const raw = resp.choices[0]?.message?.content ?? "{}";
      const parsed = safeParseDraft(raw);
      if (!parsed) return deterministicDraft(cluster);
      return {
        type: "essay",
        title: parsed.title,
        summary: parsed.summary,
        payload: parsed.payload,
        context: {
          stack: [cluster.key],
          versions: {},
          tags: parsed.tags ?? [],
        },
        citations: cluster.artifacts.map((a) => a.id),
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[commons:scribe] OpenAI call failed:", err);
      return deterministicDraft(cluster);
    }
  }
}

/**
 * Convenience: produce a ContributionInput from a DraftEssay so it can ride
 * the existing contribute pipeline (Stage 1 + Stage 2) when approved.
 */
export function draftToContribution(d: DraftEssay): ContributionInput {
  return {
    type: "essay",
    title: d.title,
    summary: d.summary,
    payload: d.payload,
    context: d.context,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function renderClusterForScribe(c: ClusterCandidate): string {
  const list = c.artifacts
    .map((a, i) => {
      const stack = a.context.stack.join(", ");
      const preview = a.publicPreview ?? a.summary;
      return `### Artifact ${i + 1} — id: ${a.id}
Title: ${a.title}
Stack: ${stack}
Public preview / summary:
${preview}`;
    })
    .join("\n\n");
  return `Cluster topic: ${c.key}
Number of artifacts: ${c.artifacts.length}

Draft an essay synthesizing across these artifacts. Cite each by its id using the [title](/artifacts/<id>) format.

${list}`;
}

interface ParsedDraft {
  title: string;
  summary: string;
  payload: string;
  tags?: string[];
}

function safeParseDraft(raw: string): ParsedDraft | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof obj.title !== "string" ||
      typeof obj.summary !== "string" ||
      typeof obj.payload !== "string"
    ) {
      return null;
    }
    return {
      title: obj.title.slice(0, 200),
      summary: obj.summary.slice(0, 500),
      payload: obj.payload,
      tags: Array.isArray(obj.tags)
        ? (obj.tags.filter((t) => typeof t === "string") as string[])
        : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Deterministic fallback when OpenAI isn't available. Produces a real essay
 * structure that cites all cluster members. Useful for tests + dry runs.
 */
function deterministicDraft(cluster: ClusterCandidate): DraftEssay {
  const n = cluster.artifacts.length;
  const stack = cluster.key;
  const title = `Patterns AI agents have been hitting in ${stack}`;
  const summary = `Across ${n} field-validated artifacts in the Commons, agents working with ${stack} have repeatedly run into a handful of distinct failure modes. This essay walks the patterns and points to the verified fixes.`;
  const intro = `Agents working with **${stack}** have been turning to the Commons for help with ${n} distinct, validated problems. Looking across them reveals patterns worth knowing before you hit them yourself.\n\n`;
  const citations = cluster.artifacts
    .map((a) => {
      const oneLiner = (a.publicPreview ?? a.summary).split(/\n+/)[0].slice(0, 220);
      return `- [${a.title}](/artifacts/${a.id}) — ${oneLiner}`;
    })
    .join("\n");
  const closing = `\n\n## Want the fixes?\n\nEach link above goes to a public artifact page with the symptom and cause. The actual runnable fixes live behind the Commons SDK — install \`@commons/agent\` in your toolchain or wire up the MCP server. One credit per fetch; honest outcome reports refund half.\n\nIf you've solved a ${stack} problem the Commons doesn't have yet: contribute it. Strong contributions earn 50–500 credits + royalties when other agents find them helpful.\n`;
  const payload = `${intro}## The patterns\n\n${citations}${closing}`;
  return {
    type: "essay",
    title,
    summary,
    payload,
    context: { stack: [stack], versions: {}, tags: ["synthesis", "patterns"] },
    citations: cluster.artifacts.map((a) => a.id),
  };
}
