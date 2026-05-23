/**
 * MCP server smoke test.
 *
 * Pairs an in-memory MCP client with our MCP server, drives the server through
 * a full agent journey: bootstrap → search → fetch → outcome → me. Verifies the
 * server exposes the right tools and returns the right shape.
 *
 * Uses the real Hono API on an ephemeral port (no DB needed; in-memory store).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CommonsClient } from "@commons/agent";
import { createApp, type AppDeps } from "../../api/src/app.js";
import { createMemoryStore } from "../../api/src/store.js";
import { buildCommonsServer } from "../src/mcp.js";
import { SEED_ARTIFACTS } from "../../../seed/corpus/index.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ServerType;
let baseUrl: string;
let deps: AppDeps & { pendingStage2: Array<() => Promise<void>> };

function makeDeps() {
  const pending: Array<() => Promise<void>> = [];
  return {
    store: createMemoryStore(),
    scheduleStage2: (run: () => Promise<void>) => pending.push(run),
    now: () => new Date().toISOString(),
    pendingStage2: pending,
  };
}

async function flushStage2() {
  while (deps.pendingStage2.length) {
    const run = deps.pendingStage2.shift()!;
    await run();
  }
}

beforeAll(async () => {
  deps = makeDeps();
  const app = createApp(deps);
  // Listen on ephemeral port
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
  });
  const addr = (server as unknown as { address(): AddressInfo }).address();
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function newMcpClient(token?: string) {
  // Use an isolated token-file path so tests don't touch the real ~/.commons
  const tokenPath = join(tmpdir(), `commons-mcp-test-${Date.now()}-${Math.random()}`);
  const commons = new CommonsClient({ baseUrl, token, tokenPath, silent: true });
  const server = buildCommonsServer(commons);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, commons };
}

describe("MCP server — agent journey via tools", () => {
  it("exposes all expected tools", async () => {
    const { client } = await newMcpClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "commons_bootstrap",
        "commons_contribute",
        "commons_fetch_artifact",
        "commons_me",
        "commons_report_outcome",
        "commons_search",
      ].sort(),
    );
  });

  it("drives a full loop: bootstrap → search → fetch → outcome", async () => {
    // Pre-seed the corpus by bootstrapping a seeder via the regular SDK
    // (faster than going through MCP for every seed artifact).
    const seederSdk = new CommonsClient({ baseUrl, silent: true });
    await seederSdk.bootstrap(SEED_ARTIFACTS[0]);
    await flushStage2();
    for (const c of SEED_ARTIFACTS.slice(1)) {
      await seederSdk.contribute(c);
    }
    await flushStage2();

    // Now drive a fresh agent through MCP tools
    const { client } = await newMcpClient();

    // commons_bootstrap
    const bootRes = await client.callTool({
      name: "commons_bootstrap",
      arguments: {
        type: "solution",
        title: "Vitest 'cannot find module' for workspace packages",
        summary:
          "Workspace packages need vitest's resolve.alias to point at src paths in dev. Otherwise vitest resolves the package.json main field which may not exist before build.",
        publicPreview:
          "In a pnpm monorepo with TypeScript workspace packages, vitest fails to find a workspace dep with a 'Cannot find module' error, even though the same import works fine in your application code. The error appears on a fresh checkout before any build step has run.\n\nThe cause is how vitest resolves package imports — it follows package.json main/exports fields, which point at a dist directory that doesn't exist before a build. Application code typically uses framework dev tools that bypass this resolution path, which is why you don't see the problem there.",
        payload: [
          "## Symptom",
          "Cannot find module '@my/schema' from 'apps/api/test/foo.test.ts'.",
          "## Fix",
          "```ts",
          "// vitest.config.ts",
          "import { defineConfig } from 'vitest/config'",
          "export default defineConfig({",
          "  resolve: {",
          "    alias: {",
          "      '@my/schema': new URL('../../packages/schema/src/index.ts', import.meta.url).pathname,",
          "    },",
          "  },",
          "})",
          "```",
        ].join("\n"),
        context: { stack: ["vitest", "pnpm"], versions: {}, tags: ["test-setup"] },
      },
    });
    expect(bootRes.isError).toBeFalsy();
    const bootText = (bootRes.content as any[])[0].text as string;
    expect(bootText).toContain("Bootstrap accepted at Stage 1");
    expect(bootText).toContain("Trial credits: 10");

    // commons_search — should find the seeded Next.js cookies fix
    const searchRes = await client.callTool({
      name: "commons_search",
      arguments: {
        intent: "next.js cookies should be awaited build error",
        stack: ["next.js"],
      },
    });
    expect(searchRes.isError).toBeFalsy();
    const searchText = (searchRes.content as any[])[0].text as string;
    expect(searchText.toLowerCase()).toContain("cookies");

    // Extract artifact id from the structured content (more reliable than parsing text)
    const sc = searchRes.structuredContent as { results: Array<{ artifactId: string; title: string }> };
    expect(sc.results.length).toBeGreaterThan(0);
    const top = sc.results[0];

    // commons_fetch_artifact
    const fetchRes = await client.callTool({
      name: "commons_fetch_artifact",
      arguments: { artifactId: top.artifactId },
    });
    expect(fetchRes.isError).toBeFalsy();
    const fetchText = (fetchRes.content as any[])[0].text as string;
    expect(fetchText).toContain(top.title);
    expect(fetchText).toContain("BEGIN_PAYLOAD");
    expect(fetchText).toContain("Credits remaining");

    // commons_report_outcome
    const outRes = await client.callTool({
      name: "commons_report_outcome",
      arguments: { artifactId: top.artifactId, helped: true, note: "Solved it" },
    });
    expect(outRes.isError).toBeFalsy();

    // commons_me — balance should reflect: 10 trial - 1 fetch + 0.5 refund = 9.5
    const meRes = await client.callTool({ name: "commons_me", arguments: {} });
    expect(meRes.isError).toBeFalsy();
    const meStruct = meRes.structuredContent as { credits: number; status: string };
    expect(meStruct.credits).toBeCloseTo(9.5, 5);
    // Still probationary (stage 2 not flushed yet for the fresh agent)
    expect(meStruct.status).toBe("probationary");

    // Flush stage 2 and confirm reader becomes active
    await flushStage2();
    const meRes2 = await client.callTool({ name: "commons_me", arguments: {} });
    const meStruct2 = meRes2.structuredContent as { credits: number; status: string };
    expect(meStruct2.status).toBe("active");
    expect(meStruct2.credits).toBeGreaterThan(50);
  });

  it("surfaces bootstrap_rejected as a structured tool error", async () => {
    // Submit something that passes the schema but fails Stage 1 slop classifier
    const { client } = await newMcpClient();
    const res = await client.callTool({
      name: "commons_bootstrap",
      arguments: {
        type: "solution",
        title: "Here is an example solution to a problem",
        summary:
          "As an AI language model, here's an example. Let me explain. In this example code, here's an example of what I would do.",
        publicPreview:
          "There is some kind of problem in Next.js that developers run into when working with App Router. The behavior can be confusing at first because the surface symptom doesn't match what you'd expect from the docs. This artifact documents what's going on at a high level.",
        payload:
          "Here's an example. Let me explain. As an AI language model, in this example code I cannot directly do this but here is an example.",
        context: { stack: ["next.js"], versions: {}, tags: [] },
      },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as any[])[0].text as string;
    expect(text).toContain("bootstrap_rejected");
  });
});
