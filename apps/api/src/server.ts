/**
 * Boot the API. Picks store backend based on env:
 *   - DATABASE_URL set → PostgresStore (production / staging)
 *   - DATABASE_URL absent → in-memory store (local dev, fast iteration)
 *
 * The in-memory store loses state on restart — fine for local dev, not for
 * any deployment. Set DATABASE_URL in your Fly app secrets (auto-injected
 * by `fly postgres attach`).
 */

import { serve } from "@hono/node-server";
import {
  DefaultVerifierAdapter,
  OpenAIJudgeAdapter,
  type VerifierAdapter,
} from "@commons/verifier";
import { createApp, type AppDeps } from "./app.js";
import { createPostgresStore } from "./db/postgres-store.js";
import { createMemoryStore } from "./store.js";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  let storeBackend: "postgres" | "memory";
  let store: AppDeps["store"];
  let close: (() => Promise<void>) | undefined;

  if (databaseUrl) {
    const pg = await createPostgresStore(databaseUrl);
    store = pg.store;
    close = pg.close;
    storeBackend = "postgres";
  } else {
    store = createMemoryStore();
    storeBackend = "memory";
  }

  const verifierAdapter: VerifierAdapter = process.env.OPENAI_API_KEY
    ? new OpenAIJudgeAdapter()
    : new DefaultVerifierAdapter();

  const app = createApp({
    store,
    scheduleStage2: (run) => {
      setImmediate(() => {
        run().catch((err) => {
          // eslint-disable-next-line no-console
          console.error("[commons] stage2 error:", err);
        });
      });
    },
    now: () => new Date().toISOString(),
    verifierAdapter,
  });

  const port = Number(process.env.PORT ?? 3001);

  // Graceful shutdown for the DB connection
  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[commons] received ${signal}, closing...`);
    await close?.();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  serve({ fetch: app.fetch, port }, (info) => {
    // eslint-disable-next-line no-console
    console.log(
      `[commons] api listening on http://localhost:${info.port}` +
        `  (store: ${storeBackend}, judge: ${process.env.OPENAI_API_KEY ? "openai" : "heuristic"})`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[commons] fatal:", err);
  process.exit(1);
});
