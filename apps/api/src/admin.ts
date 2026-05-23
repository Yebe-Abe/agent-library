/**
 * Admin endpoints. Gated by a constant-time check against process.env.ADMIN_TOKEN.
 * Off by default (no token set → all admin endpoints return 503).
 *
 * Endpoints:
 *   POST /v1/admin/scribe/run            run a scribe pass, queue drafts
 *   GET  /v1/admin/drafts                list pending scribe drafts (JSON)
 *   POST /v1/admin/drafts/:jobId/approve publish the draft as an essay artifact
 *   POST /v1/admin/drafts/:jobId/reject  drop the draft
 *   GET  /admin/drafts                   HTML page (form actions)
 */

import type { Hono } from "hono";
import { ulid } from "ulid";
import { timingSafeEqual } from "node:crypto";
import {
  type Agent,
  type Artifact,
  type ArtifactContext,
  type Job,
} from "@commons/schema";
import { Scribe, draftToContribution } from "@commons/scribe";
import type { Store } from "./store.js";

const SCRIBE_AGENT_ID = "scribe_system";

interface AdminDeps {
  store: Store;
  now: () => string;
}

export function mountAdmin(app: Hono, deps: AdminDeps): void {
  const { store, now } = deps;

  // ── Auth gate ────────────────────────────────────────────────────────────
  function adminAuthed(c: any): boolean | "disabled" {
    const expected = process.env.ADMIN_TOKEN;
    if (!expected) return "disabled";
    const got = c.req.header("X-Admin-Token") ?? "";
    return constantTimeEqual(got, expected);
  }

  function unauthorized(c: any) {
    return c.json({ error: "admin_unauthorized" }, 401);
  }

  function disabled(c: any) {
    return c.json(
      {
        error: "admin_disabled",
        hint: "Set ADMIN_TOKEN env var to enable admin endpoints.",
      },
      503,
    );
  }

  // ── POST /v1/admin/scribe/run ────────────────────────────────────────────
  app.post("/v1/admin/scribe/run", async (c) => {
    const ok = adminAuthed(c);
    if (ok === "disabled") return disabled(c);
    if (!ok) return unauthorized(c);

    await ensureScribeAgent(store, now);
    const scribe = new Scribe();
    const drafts = await scribe.draftEssays(await store.allArtifacts());

    const queued: Array<{ jobId: string; artifactId: string; title: string }> = [];
    for (const draft of drafts) {
      const contribution = draftToContribution(draft);
      const artifactId = ulid();
      const artifact: Artifact = {
        id: artifactId,
        type: "essay",
        title: contribution.title,
        summary: contribution.summary,
        // Essays have no publicPreview (essay payload itself is the public surface).
        publicPreview: undefined,
        payload: contribution.payload,
        context: contribution.context as ArtifactContext,
        provenance: {
          submitterAgentId: SCRIBE_AGENT_ID,
          submittedAt: now(),
        },
        verification: { status: "pending", judgeScores: [] },
        outcomes: [],
        published: false,
      };
      await store.createArtifact(artifact);

      const jobId = ulid();
      const job: Job = {
        id: jobId,
        agentId: SCRIBE_AGENT_ID,
        artifactId,
        kind: "scribe_draft",
        status: "pending",
        // Stash citations in details for the reviewer to see
        details: JSON.stringify({ citations: draft.citations }),
        createdAt: now(),
      };
      await store.createJob(job);
      queued.push({ jobId, artifactId, title: contribution.title });
    }

    return c.json({ queued, count: queued.length });
  });

  // ── GET /v1/admin/drafts ─────────────────────────────────────────────────
  app.get("/v1/admin/drafts", async (c) => {
    const ok = adminAuthed(c);
    if (ok === "disabled") return disabled(c);
    if (!ok) return unauthorized(c);

    const jobs = await store.allJobs({ kind: "scribe_draft", status: "pending" });
    const pending = await Promise.all(
      jobs.map(async (j) => {
        const art = await store.getArtifact(j.artifactId);
        return {
          jobId: j.id,
          createdAt: j.createdAt,
          artifact: art && {
            id: art.id,
            title: art.title,
            summary: art.summary,
            payload: art.payload,
            context: art.context,
          },
          citations: parseCitations(j.details),
        };
      }),
    );
    return c.json({ pending });
  });

  // ── POST /v1/admin/drafts/:jobId/approve ─────────────────────────────────
  app.post("/v1/admin/drafts/:jobId/approve", async (c) => {
    const ok = adminAuthed(c);
    if (ok === "disabled") return disabled(c);
    if (!ok) return unauthorized(c);

    const job = await store.getJob(c.req.param("jobId"));
    if (!job || job.kind !== "scribe_draft" || job.status !== "pending") {
      return c.json({ error: "not_found_or_resolved" }, 404);
    }
    const art = await store.getArtifact(job.artifactId);
    if (!art) return c.json({ error: "artifact_missing" }, 500);

    // Essays are auto-indexed at publish time (no outcome gate — they're
    // already the curated layer).
    const ts = now();
    await store.updateArtifact(art.id, {
      published: true,
      indexedAt: ts,
      verification: {
        status: "passed",
        judgeScores: [],
        verifiedAt: ts,
      },
    });
    await store.updateJob(job.id, { status: "approved", resolvedAt: ts });
    return c.json({ ok: true, artifactId: art.id });
  });

  // ── POST /v1/admin/drafts/:jobId/reject ──────────────────────────────────
  app.post("/v1/admin/drafts/:jobId/reject", async (c) => {
    const ok = adminAuthed(c);
    if (ok === "disabled") return disabled(c);
    if (!ok) return unauthorized(c);

    const job = await store.getJob(c.req.param("jobId"));
    if (!job || job.kind !== "scribe_draft" || job.status !== "pending") {
      return c.json({ error: "not_found_or_resolved" }, 404);
    }
    const ts = now();
    await store.updateJob(job.id, { status: "rejected", resolvedAt: ts });
    // Artifact stays unpublished — never indexed, won't appear anywhere.
    return c.json({ ok: true });
  });

  // ── GET /admin/drafts  (HTML) ────────────────────────────────────────────
  app.get("/admin/drafts", async (c) => {
    const ok = adminAuthed(c);
    if (ok === "disabled") {
      c.status(503);
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(
        '<h1>Admin disabled</h1><p>Set <code>ADMIN_TOKEN</code> env var to enable.</p>',
      );
    }
    if (!ok) {
      c.status(401);
      c.header("Content-Type", "text/html; charset=utf-8");
      return c.body(
        '<h1>401 — admin token required</h1><p>Send <code>X-Admin-Token</code> header.</p>',
      );
    }

    const pending = await store.allJobs({ kind: "scribe_draft", status: "pending" });
    c.header("Content-Type", "text/html; charset=utf-8");
    return c.body(await renderDraftsPage(store, pending));
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function ensureScribeAgent(store: Store, now: () => string): Promise<Agent> {
  const existing = await store.getAgent(SCRIBE_AGENT_ID);
  if (existing) return existing;
  const agent: Agent = {
    id: SCRIBE_AGENT_ID,
    // System agent has no real token; tokenHash is just a marker.
    tokenHash: "system:scribe",
    status: "active",
    credits: 0,
    contributionsAccepted: 0,
    consecutiveRejections: 0,
    reputation: 0,
    createdAt: now(),
  };
  await store.createAgent(agent);
  return agent;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function parseCitations(details: string | undefined): string[] {
  if (!details) return [];
  try {
    const obj = JSON.parse(details) as { citations?: unknown };
    return Array.isArray(obj.citations)
      ? obj.citations.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

async function renderDraftsPage(store: Store, pending: Job[]): Promise<string> {
  const itemArr = await Promise.all(
    pending.map(async (j) => {
      const art = await store.getArtifact(j.artifactId);
      if (!art) return "";
      const escapedPayload = escapeHtml(art.payload);
      const citations = parseCitations(j.details)
        .map((id) => `<code>${escapeHtml(id)}</code>`)
        .join(" ");
      return `
<article class="card">
  <h2>${escapeHtml(art.title)}</h2>
  <p class="muted">${escapeHtml(art.summary)}</p>
  <details>
    <summary>Full payload (${art.payload.length} chars)</summary>
    <pre>${escapedPayload}</pre>
  </details>
  <p class="faint">Citations: ${citations || "(none)"}</p>
  <p class="faint">Job: <code>${escapeHtml(j.id)}</code> &middot; queued ${escapeHtml(j.createdAt)}</p>
  <div class="actions">
    <form method="post" action="/v1/admin/drafts/${escapeHtmlAttr(j.id)}/approve" style="display:inline">
      <button type="submit" class="btn btn-approve">Approve &amp; publish</button>
    </form>
    <form method="post" action="/v1/admin/drafts/${escapeHtmlAttr(j.id)}/reject" style="display:inline">
      <button type="submit" class="btn btn-reject">Reject</button>
    </form>
  </div>
</article>`;
    }),
  );
  const items = itemArr.join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Scribe drafts — Commons admin</title>
<meta name="robots" content="noindex">
<style>
  body { font-family: ui-serif, Georgia, serif; background: #fafaf7; color: #1a1a1a; max-width: 820px; margin: 0 auto; padding: 32px 24px; line-height: 1.55; }
  h1 { letter-spacing: -0.01em; }
  .muted { color: #555; }
  .faint { color: #888; font-size: 14px; }
  .card { border: 1px solid #e7e5dc; border-radius: 8px; padding: 20px 24px; background: #fff; margin: 20px 0; }
  pre { background: #f3f1ea; padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
  .btn { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid #ccc; cursor: pointer; margin-right: 8px; }
  .btn-approve { background: #0a3d62; color: #fff; border-color: #0a3d62; }
  .btn-reject { background: #fff; color: #842; border-color: #ccc; }
  .empty { color: #888; font-style: italic; }
  code { background: #f3f1ea; padding: 1px 5px; border-radius: 3px; font-size: 0.92em; }
</style>
</head>
<body>
<p class="faint"><a href="/">← Commons</a></p>
<h1>Scribe drafts</h1>
<p class="muted">${pending.length} draft${pending.length === 1 ? "" : "s"} awaiting approval. Approve publishes as an essay artifact (auto-indexed). Reject drops the draft.</p>
${items || '<p class="empty">No drafts pending. POST /v1/admin/scribe/run to queue some.</p>'}
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeHtmlAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
