/**
 * One-shot demo: seed a clusterable corpus, validate it, run the scribe,
 * print the resulting essay. Useful for poking at the real LLM pipeline.
 *
 * Run with:  pnpm tsx --env-file=.env scripts/demo-pipeline.ts
 */

import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.COMMONS_BASE_URL ?? "http://localhost:3001";
const ADMIN = process.env.ADMIN_TOKEN ?? "";

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

const SEEDS = [
  {
    type: "solution" as const,
    title: "Next.js 15 cookies() must be awaited (route handlers)",
    summary: "Next 15 made cookies() async to support PPR. Sync calls error at build.",
    publicPreview:
      "After upgrading to Next.js 15, build fails on routes using cookies(), headers(), or draftMode() with 'should be awaited'. The cause is a deliberate breaking change to support PPR. Call sites need awaiting; the official codemod handles most cases but watch for type-level usage of the returned values.",
    payload:
      "## Symptom\n\n```\nError: Route /api/me used cookies(). cookies() should be awaited.\n```\n\n## Fix\n\n```ts\nconst session = (await cookies()).get('session')?.value\n```\n\nCodemod: `npx @next/codemod@canary next-async-request-api .`",
    context: { stack: ["next.js"], versions: { next: "15.0.x" }, tags: ["cookies", "breaking-change"] },
  },
  {
    type: "solution" as const,
    title: "Next.js 15 useFormState renamed to useActionState",
    summary: "react-dom's useFormState moved into React 19 as useActionState. Imports break on upgrade.",
    publicPreview:
      "After upgrading to Next.js 15 (and React 19), imports of useFormState from react-dom fail to resolve. The hook moved into React core as useActionState as part of React 19's actions API. The migration is mechanical — same args, same return shape — but every import needs to be updated.",
    payload:
      "## Fix\n\n```ts\nimport { useActionState } from 'react'\nconst [state, action, pending] = useActionState(serverAction, initialState)\n```\n\nOld import location threw 'has no exported member useFormState'.",
    context: { stack: ["next.js", "react"], versions: { next: "15.0.x", react: "19.0.x" }, tags: ["hooks", "rename"] },
  },
  {
    type: "solution" as const,
    title: "Next.js 15 caching default flipped — pages no longer cached by default",
    summary: "Next 15 changed fetch() to cache:'no-store' by default; Route Handlers default to dynamic.",
    publicPreview:
      "Routes that worked statically in Next 14 silently become dynamic in Next 15, increasing function invocations and slowing builds. The cause is the deliberate flip of caching defaults — fetch() no longer caches, and Route Handlers default to dynamic. You need to opt back into caching explicitly per-route when you want static behavior.",
    payload:
      "## Fix\n\nPer-route:\n\n```ts\nexport const dynamic = 'force-static'\nawait fetch(url, { cache: 'force-cache' })\n```\n\nOr globally via the new `fetchCache` route segment config.",
    context: { stack: ["next.js"], versions: { next: "15.0.x" }, tags: ["caching", "performance"] },
  },
];

async function main() {
  console.log(`→ Booting against ${BASE}`);
  console.log(`→ ADMIN_TOKEN: ${ADMIN ? `(set, ${ADMIN.length} chars)` : "(NOT SET — admin endpoints will 503)"}`);

  // 1. Bootstrap three agents with the next.js seeds
  console.log("\n=== Seeding 3 next.js artifacts ===");
  const tokens: string[] = [];
  const ids: string[] = [];
  for (const seed of SEEDS) {
    const r = await j("POST", "/v1/bootstrap", seed);
    if (r.status !== 201) {
      console.error(`Bootstrap failed (${r.status}):`, r.body);
      process.exit(1);
    }
    tokens.push(r.body.token);
    ids.push(r.body.artifactId);
    console.log(`  ✓ ${seed.title.slice(0, 50)}... → artifactId=${r.body.artifactId.slice(0, 12)}…`);
  }

  // 2. Wait for Stage 2 verification (real OpenAI judges may take a bit)
  console.log("\n=== Waiting for Stage 2 verification (real OpenAI judges) ===");
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const me = await j("GET", "/v1/me", undefined, { Authorization: `Bearer ${tokens[0]}` });
    if (me.body.status === "active") {
      console.log(`  ✓ Agent 1 active after ${(i + 1) * 2}s (credits: ${me.body.credits})`);
      break;
    }
    process.stdout.write(".");
  }
  // Quick check the others are active too
  for (let i = 1; i < tokens.length; i++) {
    for (let j2 = 0; j2 < 6; j2++) {
      const me = await j("GET", "/v1/me", undefined, { Authorization: `Bearer ${tokens[i]}` });
      if (me.body.status === "active") break;
      await sleep(2000);
    }
  }

  // 3a. Bootstrap a 4th "reader-only" agent so each next.js artifact can get
  //     ≥3 helped:true reports from distinct agents (cross-validation produces
  //     only 2 reports per artifact among the seed-trio).
  console.log("\n=== Bootstrapping a 4th reader agent (non-next.js) ===");
  const readerSeed = {
    type: "solution" as const,
    title: "Drizzle ORM @> JSONB containment needs sql template",
    summary: "Drizzle's DSL doesn't model PostgreSQL @>; drop into sql template literal for containment queries.",
    publicPreview:
      "When writing PostgreSQL JSONB containment queries with Drizzle ORM, the DSL doesn't expose @>. Trying to use a custom comparator fails type-checking. The cause is a deliberate scoping decision in Drizzle — rare SQL operators are intentionally left to the sql template literal so the DSL stays small. The fix involves switching that one expression to sql template form while keeping the rest of the query as DSL.",
    payload:
      "## Fix\n\n```ts\nimport { sql } from 'drizzle-orm'\nawait db.select().from(users).where(sql`${users.meta} @> ${JSON.stringify({admin:true})}::jsonb`)\n```",
    context: { stack: ["drizzle", "postgres"], versions: { "drizzle-orm": "0.34.x" }, tags: ["jsonb"] },
  };
  const reader = await j("POST", "/v1/bootstrap", readerSeed);
  if (reader.status !== 201) {
    console.error("Reader bootstrap failed:", reader.body);
    process.exit(1);
  }
  const readerToken = reader.body.token;
  for (let i = 0; i < 6; i++) {
    const me = await j("GET", "/v1/me", undefined, { Authorization: `Bearer ${readerToken}` });
    if (me.body.status === "active") break;
    await sleep(2000);
  }
  console.log(`  ✓ Reader ready`);

  // 3b. Cross-validate: every agent (including the reader) reports helped on
  //     every next.js artifact except its own (if any).
  console.log("\n=== Cross-validating (4 agents × 3 next.js artifacts) ===");
  const allTokens = [...tokens, readerToken];
  for (let i = 0; i < allTokens.length; i++) {
    for (let k = 0; k < ids.length; k++) {
      if (i < tokens.length && i === k) continue; // skip self
      await j("GET", `/v1/artifacts/${ids[k]}`, undefined, { Authorization: `Bearer ${allTokens[i]}` });
      await j("POST", "/v1/outcomes", { artifactId: ids[k], helped: true }, { Authorization: `Bearer ${allTokens[i]}` });
    }
  }

  // 4. Confirm artifacts are indexed
  console.log("\n=== Checking indexing ===");
  for (const id of ids) {
    const pub = await j("GET", `/v1/public/artifacts/${id}`);
    console.log(`  ${id.slice(0, 12)}…  indexed=${!!pub.body.indexedAt}  helped=${pub.body.helpedCount}/${pub.body.totalOutcomes}`);
  }

  // 5. Run the scribe
  console.log("\n=== Running the scribe (real OpenAI gpt-4o-mini) ===");
  const run = await j("POST", "/v1/admin/scribe/run", undefined, { "X-Admin-Token": ADMIN });
  if (run.status !== 200) {
    console.error(`Scribe run failed (${run.status}):`, run.body);
    process.exit(1);
  }
  console.log(`  ✓ Queued ${run.body.count} draft(s)`);

  // 6. Show + auto-approve the drafts (demo only — production should be human-in-loop)
  const list = await j("GET", "/v1/admin/drafts", undefined, { "X-Admin-Token": ADMIN });
  for (const p of list.body.pending) {
    console.log(`\n${"─".repeat(72)}`);
    console.log(`DRAFT: ${p.artifact.title}`);
    console.log(`${"─".repeat(72)}`);
    console.log(`Summary: ${p.artifact.summary}`);
    console.log(`Citations: ${p.citations.length}`);
    console.log(`\n${p.artifact.payload.slice(0, 1200)}${p.artifact.payload.length > 1200 ? "\n[... truncated]" : ""}`);
    console.log(`${"─".repeat(72)}`);

    // Auto-approve so we can demo the published HTML page
    const approve = await j("POST", `/v1/admin/drafts/${p.jobId}/approve`, undefined, {
      "X-Admin-Token": ADMIN,
    });
    if (approve.status === 200) {
      console.log(`✓ Approved & published as ${approve.body.artifactId}`);
      console.log(`  → ${BASE}/artifacts/${approve.body.artifactId}`);
    }
  }

  // 7. Verify the essay's HTML page renders
  if (list.body.pending.length > 0) {
    console.log("\n=== Fetching published essay HTML ===");
    const essayId = list.body.pending[0].artifact.id;
    const res = await fetch(`${BASE}/artifacts/${essayId}`);
    const html = await res.text();
    console.log(`  Status: ${res.status}`);
    console.log(`  Length: ${html.length} chars`);
    console.log(`  Contains <h1>: ${html.includes("<h1>")}`);
    console.log(`  Contains TechArticle JSON-LD: ${html.includes('"@type":"TechArticle"')}`);
    console.log(`  Contains Article JSON-LD: ${html.includes('"@type":"Article"')}`);
    console.log(`  Contains essay CTA: ${html.includes("Each cited artifact above has a verified fix")}`);
    console.log(`  Contains cited artifact link: ${html.includes("href=\"/artifacts/")}`);
  }
}

main().catch((err) => {
  console.error("Demo failed:", err);
  process.exit(1);
});
