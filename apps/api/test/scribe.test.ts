/**
 * End-to-end test for the scribe agent + admin approval flow.
 *
 * Uses the deterministic Scribe fallback (no OPENAI_API_KEY) so it's stable.
 * Verifies:
 *  - admin endpoints return 503 when ADMIN_TOKEN is unset
 *  - admin endpoints return 401 with a bad token
 *  - POST /v1/admin/scribe/run produces drafts for stacks with ≥3 indexed artifacts
 *  - GET /v1/admin/drafts lists the pending drafts
 *  - POST .../approve publishes the draft as an indexed essay
 *  - POST .../reject drops it
 *  - The published essay appears on the public surface
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultVerifierAdapter } from "@commons/verifier";
import { createApp, type AppDeps } from "../src/app.js";
import { createMemoryStore } from "../src/store.js";
import { SEED_ARTIFACTS } from "../../../seed/corpus/index.js";

const ADMIN_TOKEN = "test-admin-secret";

function makeDeps(): AppDeps & { pendingStage2: Array<() => Promise<void>> } {
  const pending: Array<() => Promise<void>> = [];
  return {
    store: createMemoryStore(),
    scheduleStage2: (run) => pending.push(run),
    now: () => new Date().toISOString(),
    verifierAdapter: new DefaultVerifierAdapter(),
    pendingStage2: pending,
  };
}

async function flushStage2(deps: { pendingStage2: Array<() => Promise<void>> }) {
  while (deps.pendingStage2.length) await deps.pendingStage2.shift()!();
}

function bind(app: ReturnType<typeof createApp>) {
  return (path: string, init: RequestInit = {}) =>
    app.fetch(new Request(`http://test.local${path}`, init));
}

/** Set up a corpus where one stack (next.js) has 3 field-validated artifacts. */
async function seedClusterableCorpus(
  deps: ReturnType<typeof makeDeps>,
  f: ReturnType<typeof bind>,
) {
  // We need 3 indexed artifacts sharing a primary stack. SEED_ARTIFACTS has
  // two next.js items at [1] and [2]. We'll bootstrap 4 agents that each
  // contribute one of the next.js / drizzle artifacts, then validate the
  // next.js ones by reporting helped:true 3 times each.
  const items = [SEED_ARTIFACTS[1], SEED_ARTIFACTS[2], SEED_ARTIFACTS[0], SEED_ARTIFACTS[5]];
  // Modify items[2] and items[3] to be next.js-primary so the cluster has 3+ members
  const nextJsItems = [
    SEED_ARTIFACTS[1], // Next.js cookies
    SEED_ARTIFACTS[2], // Vercel/Next sharp
    {
      ...SEED_ARTIFACTS[0],
      context: { ...SEED_ARTIFACTS[0].context, stack: ["next.js", "drizzle"] },
    },
    {
      ...SEED_ARTIFACTS[5],
      context: { ...SEED_ARTIFACTS[5].context, stack: ["next.js", "postgres"] },
    },
  ];
  const tokens: string[] = [];
  const ids: string[] = [];
  for (const item of nextJsItems) {
    const r = await f("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    });
    const { token, artifactId } = (await r.json()) as { token: string; artifactId: string };
    tokens.push(token);
    ids.push(artifactId);
    await flushStage2(deps);
  }
  // Have each agent report helped:true on the OTHER agents' artifacts
  // so we cross the helped-3 threshold for each.
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < ids.length; j++) {
      if (i === j) continue;
      await f("/v1/outcomes", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${tokens[i]}`,
        },
        body: JSON.stringify({ artifactId: ids[j], helped: true }),
      });
    }
  }
  return { tokens, ids };
}

describe("Scribe + admin approval", () => {
  beforeEach(() => {
    process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  });
  afterEach(() => {
    delete process.env.ADMIN_TOKEN;
  });

  it("returns 503 when ADMIN_TOKEN is not set", async () => {
    delete process.env.ADMIN_TOKEN;
    const f = bind(createApp(makeDeps()));
    const res = await f("/v1/admin/drafts");
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe("admin_disabled");
  });

  it("returns 401 with a wrong token", async () => {
    const f = bind(createApp(makeDeps()));
    const res = await f("/v1/admin/drafts", {
      headers: { "X-Admin-Token": "wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("scribe drafts → admin approval publishes an indexed essay", async () => {
    const deps = makeDeps();
    const f = bind(createApp(deps));

    // Seed a corpus with a clusterable next.js group of size ≥ 3
    await seedClusterableCorpus(deps, f);

    // Run the scribe
    const runRes = await f("/v1/admin/scribe/run", {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as any;
    expect(runBody.count).toBeGreaterThanOrEqual(1);
    const draft = runBody.queued[0];
    expect(draft.title).toContain("next.js");

    // List drafts
    const listRes = await f("/v1/admin/drafts", {
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.pending.length).toBe(runBody.count);

    // The draft artifact shouldn't be searchable yet (not published)
    const searchBefore = await f(
      "/v1/search?intent=" + encodeURIComponent("next.js patterns"),
    );
    const sBefore = (await searchBefore.json()) as { results: any[] };
    const wasFoundBefore = sBefore.results.some((r) => r.artifactId === draft.artifactId);
    expect(wasFoundBefore).toBe(false);

    // Approve
    const approveRes = await f(`/v1/admin/drafts/${draft.jobId}/approve`, {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    expect(approveRes.status).toBe(200);

    // After approval: the essay is published AND indexed (essays bypass outcome gate)
    const pubRes = await f(`/v1/public/artifacts/${draft.artifactId}`);
    expect(pubRes.status).toBe(200);
    const pubBody = (await pubRes.json()) as any;
    expect(pubBody.type).toBe("essay");
    expect(pubBody.indexedAt).toBeTruthy();
    // Essays show their payload directly on the public page via the HTML route;
    // the JSON public endpoint includes publicPreview which is null for essays.
    expect(pubBody.publicPreview).toBeNull();

    // The essay should appear in search now
    const searchAfter = await f(
      "/v1/search?intent=" + encodeURIComponent("next.js patterns"),
    );
    const sAfter = (await searchAfter.json()) as { results: any[] };
    const wasFoundAfter = sAfter.results.some((r) => r.artifactId === draft.artifactId);
    expect(wasFoundAfter).toBe(true);

    // Pending list should be empty now
    const listAfter = await f("/v1/admin/drafts", {
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    const listAfterBody = (await listAfter.json()) as any;
    expect(listAfterBody.pending.length).toBe(0);
  });

  it("rejecting a draft leaves it unpublished", async () => {
    const deps = makeDeps();
    const f = bind(createApp(deps));
    await seedClusterableCorpus(deps, f);
    const runRes = await f("/v1/admin/scribe/run", {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    const { queued } = (await runRes.json()) as any;
    const draft = queued[0];

    const rejRes = await f(`/v1/admin/drafts/${draft.jobId}/reject`, {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    expect(rejRes.status).toBe(200);

    // Public page should 404 — never published
    const pub = await f(`/v1/public/artifacts/${draft.artifactId}`);
    expect(pub.status).toBe(404);
  });

  it("admin HTML page renders drafts when authed", async () => {
    const deps = makeDeps();
    const f = bind(createApp(deps));
    await seedClusterableCorpus(deps, f);
    await f("/v1/admin/scribe/run", {
      method: "POST",
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });

    const page = await f("/admin/drafts", {
      headers: { "X-Admin-Token": ADMIN_TOKEN },
    });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Scribe drafts");
    expect(html).toContain("Approve &amp; publish");
    expect(html).toContain("Reject");
  });
});
