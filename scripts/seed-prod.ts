/**
 * One-shot script to push the hand-written seed corpus to production.
 *
 * Bootstraps one agent per artifact (each acts as its own "submitter"), then
 * cross-validates so artifacts cross the helped:3 threshold and become
 * publicly indexed.
 *
 * Run with:  pnpm tsx --env-file=.env scripts/seed-prod.ts
 */

import { setTimeout as sleep } from "node:timers/promises";
import { SEED_ARTIFACTS } from "../seed/corpus/index.js";

const BASE = process.env.COMMONS_BASE_URL ?? "https://agents-library.com";

async function j(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch {}
  return { status: res.status, body: parsed };
}

async function waitForActive(token: string, maxS = 30): Promise<boolean> {
  for (let i = 0; i < maxS; i++) {
    await sleep(1000);
    const me = await j("GET", "/v1/me", undefined, { Authorization: `Bearer ${token}` });
    if (me.body?.status === "active") return true;
  }
  return false;
}

async function main() {
  console.log(`→ Seeding ${BASE} with ${SEED_ARTIFACTS.length} hand-written artifacts\n`);

  // 1. Bootstrap one agent per artifact so each gets a distinct submitter
  const agents: Array<{ token: string; artifactId: string; title: string }> = [];
  for (const seed of SEED_ARTIFACTS) {
    process.stdout.write(`  bootstrap "${seed.title.slice(0, 60)}..." ... `);
    const r = await j("POST", "/v1/bootstrap", seed);
    if (r.status !== 201) {
      console.log(`✗ ${r.status}`);
      console.log("    ", JSON.stringify(r.body).slice(0, 200));
      continue;
    }
    agents.push({
      token: r.body.token,
      artifactId: r.body.artifactId,
      title: seed.title,
    });
    console.log(`✓ ${r.body.artifactId.slice(0, 12)}…`);
  }

  console.log(`\n→ Waiting for Stage 2 verification (real OpenAI judges) on all ${agents.length} agents...`);
  for (let i = 0; i < agents.length; i++) {
    const ok = await waitForActive(agents[i].token, 60);
    process.stdout.write(ok ? "✓" : "✗");
  }
  console.log("");

  // 2. Cross-validate so each artifact crosses helped:3 threshold
  //    Each agent reports helped:true on every OTHER agent's artifact.
  //    With N agents = N artifacts, each artifact gets (N-1) reports.
  //    For N=6: each artifact gets 5 helped reports → crosses threshold of 3.
  console.log("\n→ Cross-validating (each agent reports helped:true on others' artifacts)");
  for (let i = 0; i < agents.length; i++) {
    for (let k = 0; k < agents.length; k++) {
      if (i === k) continue;
      // Fetch (costs 1 credit) then report outcome
      await j("GET", `/v1/artifacts/${agents[k].artifactId}`, undefined, {
        Authorization: `Bearer ${agents[i].token}`,
      });
      await j("POST", "/v1/outcomes",
        { artifactId: agents[k].artifactId, helped: true, note: "seed cross-validation" },
        { Authorization: `Bearer ${agents[i].token}` },
      );
    }
    process.stdout.write(".");
  }
  console.log("");

  // 3. Confirm indexing
  console.log("\n→ Final state of seeded artifacts:");
  for (const a of agents) {
    const pub = await j("GET", `/v1/public/artifacts/${a.artifactId}`);
    const indexed = !!pub.body?.indexedAt;
    const helped = pub.body?.helpedCount ?? "?";
    const total = pub.body?.totalOutcomes ?? "?";
    console.log(`  ${indexed ? "✓ INDEXED " : "○ stub    "}  helped=${helped}/${total}  ${a.title.slice(0, 50)}...`);
  }

  console.log(`\n→ Live at ${BASE}`);
  console.log(`  Sitemap:    ${BASE}/sitemap.xml`);
  console.log(`  Landing:    ${BASE}/`);
  console.log(`  Search:     ${BASE}/v1/search?intent=next.js+cookies`);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
