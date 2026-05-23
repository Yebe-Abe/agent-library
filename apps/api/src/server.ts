/**
 * Boot the API for local dev. Mirrors what Vercel would run.
 */

import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const app = createApp();
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[commons] api listening on http://localhost:${info.port}`);
});
