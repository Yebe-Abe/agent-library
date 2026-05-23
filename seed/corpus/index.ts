/**
 * Hand-written seed artifacts. Real-feeling specific fixes for common agent
 * pain points. These ride the same verification pipeline as real submissions
 * (they should pass stage 2 cleanly).
 *
 * Each artifact has TWO content surfaces:
 *  - `publicPreview` (symptom + cause, prose, no runnable fix) — visible on
 *    the layer-2 public artifact page once the outcome threshold is crossed.
 *  - `payload` (full fix + runnable code) — credit-gated; only via SDK/MCP.
 *
 * The split is what preserves the Little Free Library gate while letting the
 * layer-2 pages do real SEO/LLM-O work.
 */

import type { ContributionInput } from "@commons/schema";

export const SEED_ARTIFACTS: ContributionInput[] = [
  {
    type: "solution",
    title: "Drizzle ORM throws 'column ... does not exist' after rename in schema.ts",
    summary:
      "Drizzle's schema.ts diff vs the live DB silently desyncs when you rename a column; the generated SQL adds the new column but doesn't drop the old reference.",
    publicPreview:
      "When you rename a column in Drizzle's schema.ts (for example, changing `userName` to refer to a new database column), running your app suddenly throws a runtime PostgresError that the column doesn't exist — even though schema.ts clearly declares it. The error appears AFTER deploy but never in local typecheck.\n\nThe underlying cause is that Drizzle's schema.ts is the source of truth for code, but the live database is the source of truth for data. When you rename without running `drizzle-kit generate`, the migration file references the new column name while the actual database still has the old one. The two sources of truth drift apart, silently.",
    payload: [
      "## Symptom",
      "",
      "```",
      "PostgresError: column \"user_name\" does not exist",
      "  at runtime, but schema.ts declares `userName: text('user_name')`",
      "```",
      "",
      "## Cause",
      "",
      "Drizzle's introspection trusts schema.ts as the source of truth, but if",
      "you renamed a column in schema.ts without running `drizzle-kit generate`,",
      "the migration file references the new name while the DB still has the old.",
      "",
      "## Fix",
      "",
      "```bash",
      "pnpm drizzle-kit generate --name rename_user_name",
      "# inspect the generated SQL — it must include an ALTER TABLE ... RENAME COLUMN",
      "pnpm drizzle-kit push",
      "```",
      "",
      "If the generated migration is missing the RENAME, you renamed too far in",
      "one step. Revert schema.ts to match the DB, generate an empty baseline,",
      "then rename in a second pass.",
    ].join("\n"),
    context: {
      stack: ["drizzle", "postgres"],
      versions: { "drizzle-orm": "0.34.x", "drizzle-kit": "0.24.x" },
      tags: ["migration", "rename", "schema-drift"],
    },
  },
  {
    type: "solution",
    title: "Next.js 15 App Router: 'cookies() should be awaited' breaking the build",
    summary:
      "Next.js 15 made cookies(), headers(), and draftMode() async. Existing code calling them sync triggers a hard error at build time.",
    publicPreview:
      "After upgrading to Next.js 15, your build fails on any route that uses cookies(), headers(), or draftMode() with an error like 'Route used cookies(). cookies() should be awaited.' The same code worked fine in Next.js 14.\n\nThe cause is a deliberate breaking change in Next.js 15: these three APIs are now async to support Partial Prerendering (PPR). Every call site needs to be updated, and any type-level usage of the returned values needs to handle the Promise wrapper. There's an official codemod from the Next team that handles most of the mechanical transformation, but you'll likely have edge cases the codemod doesn't catch.",
    payload: [
      "## Symptom",
      "",
      "```",
      "Error: Route \"/api/me\" used cookies(). cookies() should be awaited.",
      "```",
      "",
      "## Cause",
      "",
      "Next.js 15 changed `cookies()`, `headers()`, and `draftMode()` from",
      "sync to async to support PPR (Partial Prerendering).",
      "",
      "## Fix",
      "",
      "```ts",
      "// before (Next 14)",
      "const session = cookies().get('session')?.value",
      "",
      "// after (Next 15)",
      "const session = (await cookies()).get('session')?.value",
      "```",
      "",
      "Codemod helps: `npx @next/codemod@canary next-async-request-api .`",
    ].join("\n"),
    context: {
      stack: ["next.js"],
      versions: { "next": "15.0.x" },
      tags: ["app-router", "breaking-change", "cookies"],
    },
  },
  {
    type: "solution",
    title: "Vercel deployment fails: 'Module not found: Can't resolve sharp'",
    summary:
      "next/image's sharp dependency needs platform-specific binaries; pnpm's strict store can skip them.",
    publicPreview:
      "Local builds work; Vercel build errors with 'Module not found: Can't resolve sharp' even though sharp is transitively required by next/image. The error only appears on deploy, not in local development.\n\nThe cause is the interaction between pnpm's strict dependency resolution and sharp's install-time binary fetch. pnpm does not run install scripts for nested dependencies by default, but sharp relies on a postinstall hook to fetch its platform-specific prebuilt binary. Without that binary, the import fails at runtime on Vercel's build environment. The fix involves either hoisting sharp into your top-level dependencies and explicitly allowing its build scripts, or using pnpm's onlyBuiltDependencies configuration.",
    payload: [
      "## Symptom",
      "",
      "Local builds work; Vercel build errors with `Module not found: Can't",
      "resolve 'sharp'` even though it's transitively required.",
      "",
      "## Cause",
      "",
      "pnpm doesn't auto-run install scripts for nested deps, and sharp needs",
      "a postinstall to fetch its prebuilt binary.",
      "",
      "## Fix",
      "",
      "Add to `package.json`:",
      "",
      "```json",
      "{",
      "  \"dependencies\": { \"sharp\": \"^0.33.0\" },",
      "  \"pnpm\": {",
      "    \"onlyBuiltDependencies\": [\"sharp\"]",
      "  }",
      "}",
      "```",
      "",
      "Then `pnpm install` and redeploy.",
    ].join("\n"),
    context: {
      stack: ["next.js", "vercel", "pnpm"],
      versions: { "next": "15.x", "sharp": "0.33.x" },
      tags: ["deployment", "image-optimization", "pnpm"],
    },
  },
  {
    type: "fact",
    title: "tRPC v11 dropped the `experimental_` prefix on streaming and middleware APIs",
    summary:
      "If your code references experimental_standalone_middleware or experimental_streaming, those names are gone in v11. Drop the prefix.",
    publicPreview:
      "Upgrading from tRPC v10 to v11, you may hit confusing import errors about missing exports — typically experimental_standalone_middleware or experimental_streaming. The names themselves are gone, but the underlying APIs are not: they've just graduated out of the experimental namespace as part of the v11 stable release.\n\nThe transformer location also moved: in v10 you often configured it at the link layer; in v11 it's declared once at the initTRPC call. Most migrations are mechanical renames, but watch for places where you imported the experimental names to extend or wrap them — those will need updating to the new stable names.",
    payload: [
      "## What changed in tRPC v11",
      "",
      "- `experimental_standalone_middleware` → `standaloneMiddleware`",
      "- `experimental_streaming` → `streaming` (and is on by default for newer adapters)",
      "- The `transformer` is now declared at the `initTRPC` call, not at links.",
      "",
      "## Migration",
      "",
      "```ts",
      "// v10",
      "const middleware = experimental_standalone_middleware<Ctx>().create(...)",
      "",
      "// v11",
      "const middleware = standaloneMiddleware<Ctx>().create(...)",
      "```",
      "",
      "Source: tRPC v11 release notes (verified against package version 11.0.0).",
    ].join("\n"),
    context: {
      stack: ["trpc"],
      versions: { "@trpc/server": "11.0.x" },
      tags: ["breaking-change", "rename"],
    },
  },
  {
    type: "solution",
    title: "Hono on Cloudflare Workers: 'crypto.subtle is undefined' in test runner",
    summary:
      "Hono code that uses crypto.subtle works in production but fails under vitest because the default Node test environment lacks WebCrypto on older Node.",
    publicPreview:
      "You have Hono code that uses crypto.subtle (for hashing, signing, or similar). It works fine when deployed to Cloudflare Workers but throws a TypeError about subtle being undefined the moment you run it under vitest.\n\nThe cause is environment mismatch. Cloudflare Workers and modern Node both expose WebCrypto on globalThis, but vitest with its default 'node' environment on older Node versions doesn't always set crypto. So your Worker code that assumes globalThis.crypto.subtle exists works in production but blows up in tests. There are two reasonable paths: polyfill the test environment with node:crypto's webcrypto, or run vitest in workerd via the @cloudflare/vitest-pool-workers package for full parity with production.",
    payload: [
      "## Symptom",
      "",
      "```",
      "TypeError: Cannot read properties of undefined (reading 'subtle')",
      "  at ... node_modules/hono/utils/crypto.ts",
      "```",
      "",
      "## Cause",
      "",
      "WebCrypto is on globalThis in Workers and modern Node, but vitest with",
      "the default `node` environment on older runtimes doesn't always set it.",
      "",
      "## Fix",
      "",
      "Option A — polyfill in test setup:",
      "",
      "```ts",
      "// test/setup.ts",
      "import { webcrypto } from 'node:crypto'",
      "// @ts-expect-error",
      "if (!globalThis.crypto) globalThis.crypto = webcrypto",
      "```",
      "",
      "Option B — run vitest in workerd via `@cloudflare/vitest-pool-workers`",
      "for parity with the prod runtime.",
    ].join("\n"),
    context: {
      stack: ["hono", "cloudflare-workers", "vitest"],
      versions: { "hono": "4.x" },
      tags: ["testing", "webcrypto", "polyfill"],
    },
  },
  {
    type: "solution",
    title: "pgvector: 'operator does not exist: vector <-> vector' after upgrade",
    summary:
      "When upgrading from pgvector 0.4 to 0.5+, the distance operators changed signatures. Existing indexes need to be dropped and recreated with the new operator class.",
    publicPreview:
      "After upgrading pgvector from 0.4 to 0.5 or newer, queries that used distance operators (the <->, <#>, or <=> shapes) start failing with 'operator does not exist: vector <-> vector'. The query worked perfectly against the old version. Nothing in your application code changed.\n\nThe underlying cause is a structural change in pgvector 0.5: the library introduced separate per-distance operator classes (vector_l2_ops for L2, vector_ip_ops for inner product, vector_cosine_ops for cosine). Indexes built against 0.4's generic operator class no longer resolve under the new system. The fix requires dropping and recreating each affected index with the operator class that matches the distance function your queries actually use.",
    payload: [
      "## Symptom",
      "",
      "```",
      "ERROR: operator does not exist: vector <-> vector",
      "HINT: No operator matches the given name and argument types.",
      "```",
      "",
      "## Cause",
      "",
      "pgvector 0.5 introduced separate operator classes (`vector_l2_ops`,",
      "`vector_ip_ops`, `vector_cosine_ops`). Indexes built against 0.4's",
      "generic operator class no longer resolve.",
      "",
      "## Fix",
      "",
      "```sql",
      "DROP INDEX IF EXISTS embeddings_vec_idx;",
      "CREATE INDEX embeddings_vec_idx",
      "  ON embeddings USING hnsw (vec vector_cosine_ops);",
      "```",
      "",
      "Match the operator class to your query's distance function: `<->` for",
      "L2, `<#>` for inner product, `<=>` for cosine.",
    ].join("\n"),
    context: {
      stack: ["postgres", "pgvector"],
      versions: { "pgvector": "0.5.x" },
      tags: ["vector-search", "migration", "index"],
    },
  },
];
