/**
 * Integration test: run the full E2E loop against PostgresStore backed by
 * pglite (embedded Postgres). Proves that the Drizzle schema + queries match
 * the Store interface contract.
 *
 * If this passes, the in-memory and Postgres implementations are
 * behaviorally identical, and deploying against Fly Postgres is just an
 * env-var switch.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultVerifierAdapter } from "@commons/verifier";
import { createApp, type AppDeps } from "../src/app.js";
import { createPgliteStore } from "../src/db/postgres-store.js";
import type { Store } from "../src/store.js";
import { SEED_ARTIFACTS } from "../../../seed/corpus/index.js";

let appDeps: AppDeps & { pendingStage2: Array<() => Promise<void>> };
let storeClose: () => Promise<void>;

async function makeDeps(): Promise<typeof appDeps> {
  const { store, close } = await createPgliteStore();
  storeClose = close;
  const pending: Array<() => Promise<void>> = [];
  return {
    store,
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

beforeEach(async () => {
  appDeps = await makeDeps();
});
afterEach(async () => {
  await storeClose?.();
});

describe("PostgresStore (pglite) — full loop parity with in-memory", () => {
  it("bootstrap → search → fetch → outcome → indexing all work against Postgres", async () => {
    const f = bind(createApp(appDeps));

    // Seeder bootstraps with first seed artifact
    const seed = SEED_ARTIFACTS[0];
    const seedRes = await f("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seed),
    });
    expect(seedRes.status).toBe(201);
    const { token: seederToken, artifactId } = (await seedRes.json()) as {
      token: string;
      artifactId: string;
    };
    await flushStage2(appDeps);

    // Seeder should be active w/ contribution reward credited
    const me1 = await (
      await f("/v1/me", { headers: { Authorization: `Bearer ${seederToken}` } })
    ).json();
    expect(me1.status).toBe("active");
    expect(me1.credits).toBeGreaterThan(50);

    // Bootstrap a reader agent
    const reader = await f("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SEED_ARTIFACTS[1]),
    });
    expect(reader.status).toBe(201);
    const { token: readerToken } = (await reader.json()) as { token: string };
    await flushStage2(appDeps);

    // Reader searches and finds the seeded artifact
    const search = await f("/v1/search?intent=" + encodeURIComponent(seed.title));
    const results = ((await search.json()) as { results: any[] }).results;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].artifactId).toBe(artifactId);

    // Reader fetches the full payload (costs 1 credit)
    const fetched = await f(`/v1/artifacts/${artifactId}`, {
      headers: { Authorization: `Bearer ${readerToken}` },
    });
    expect(fetched.status).toBe(200);
    const fbody = (await fetched.json()) as any;
    expect(fbody.artifact.payload).toContain("BEGIN_PAYLOAD");
    expect(fbody.creditsRemaining).toBeGreaterThan(0);

    // Reader reports outcome
    const outcome = await f("/v1/outcomes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${readerToken}`,
      },
      body: JSON.stringify({ artifactId, helped: true, note: "Worked" }),
    });
    expect(outcome.status).toBe(200);

    // Check the outcome landed (JSONB array on artifact persisted correctly)
    const pub = await f(`/v1/public/artifacts/${artifactId}`);
    const pbody = (await pub.json()) as any;
    expect(pbody.helpedCount).toBe(1);
    expect(pbody.totalOutcomes).toBe(1);
  });

  it("ledger entries persist across credit transactions (proves credit_ledger table)", async () => {
    const store = appDeps.store as Store;
    const f = bind(createApp(appDeps));

    const seed = SEED_ARTIFACTS[0];
    const res = await f("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seed),
    });
    const { agentId } = (await res.json()) as { agentId: string };
    await flushStage2(appDeps);

    const ledger = await store.ledgerForAgent(agentId);
    expect(ledger.length).toBeGreaterThanOrEqual(2); // trial + stage2 reward
    expect(ledger.some((e) => e.reason === "bootstrap_trial" && e.delta === 10)).toBe(true);
    expect(ledger.some((e) => e.reason === "stage2_pass_reward" && e.delta > 0)).toBe(true);
  });

  it("jobs persist with correct kind + status filters", async () => {
    const store = appDeps.store as Store;
    const f = bind(createApp(appDeps));

    const r = await f("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(SEED_ARTIFACTS[0]),
    });
    expect(r.status).toBe(201);

    // Before flushing: one pending stage2_verification job
    const pendingBefore = await store.allJobs({
      kind: "stage2_verification",
      status: "pending",
    });
    expect(pendingBefore.length).toBe(1);

    await flushStage2(appDeps);

    // After flushing: zero pending, one passed
    const pendingAfter = await store.allJobs({
      kind: "stage2_verification",
      status: "pending",
    });
    const passed = await store.allJobs({
      kind: "stage2_verification",
      status: "passed",
    });
    expect(pendingAfter.length).toBe(0);
    expect(passed.length).toBe(1);
  });
});
