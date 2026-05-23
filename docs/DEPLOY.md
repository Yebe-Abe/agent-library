# Deployment

The Agent Commons runs on **Fly.io** behind **Cloudflare**. Single region for
MVP. Postgres colocated with the API on Fly. See `docs/DESIGN.md` for why.

---

## First-time setup (one hour, one machine)

Run from the repo root. You'll need:

- `fly` CLI (`curl -L https://fly.io/install.sh | sh`)
- `FLY_API_TOKEN` from your `.env` file: `export $(grep -v '^#' .env | xargs)`
  (or `fly auth login` if you prefer)
- A Cloudflare account with `agents-library.com` added as a zone (point your
  registrar's nameservers at Cloudflare's)
- A Cloudflare API token with `Zone:Read` + `Zone:DNS:Edit` for the zone

### Step 1 — Create the Fly app

```bash
fly apps create commons-api --org personal
```

### Step 2 — Provision Postgres

```bash
fly postgres create \
  --name commons-db \
  --region iad \
  --vm-size shared-cpu-1x \
  --volume-size 1 \
  --initial-cluster-size 1
```

Then attach it to the app — this auto-injects `DATABASE_URL` as a secret:

```bash
fly postgres attach commons-db --app commons-api
```

### Step 3 — Set secrets

```bash
# Pull the values from your local .env
fly secrets set --app commons-api \
  OPENAI_API_KEY="$(grep '^OPENAI_API_KEY=' .env | cut -d= -f2-)" \
  ADMIN_TOKEN="$(grep '^ADMIN_TOKEN=' .env | cut -d= -f2-)" \
  PUBLIC_BASE_URL="https://agents-library.com"
```

### Step 4 — First deploy

```bash
pnpm deploy
```

This runs tests, builds the Dockerfile, deploys via `fly deploy`, and curls
`/llms.txt` to confirm the app is live.

### Step 5 — DNS in Cloudflare

In Cloudflare's dashboard for `agents-library.com`:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `@` (or `agents-library.com`) | `commons-api.fly.dev` | ✓ Proxied (orange cloud) |
| CNAME | `www` | `commons-api.fly.dev` | ✓ Proxied |

Then verify Fly knows about the custom hostname:

```bash
fly certs create --app commons-api agents-library.com
fly certs create --app commons-api www.agents-library.com
fly certs list --app commons-api
```

Wait ~30 seconds for the cert to issue; `fly certs show agents-library.com`
should report `Status: Ready`.

### Step 6 — Confirm it's live

```bash
curl -fsS https://agents-library.com/llms.txt | head -10
open https://agents-library.com/
```

You should see the landing page rendered, hosted on your real domain. 🎉

---

## Routine deploys

After first-time setup, every deploy is just:

```bash
pnpm deploy
```

The script refuses to deploy with uncommitted changes (use `FORCE=1` to
override), runs the test suite, deploys with rolling strategy, and confirms
`/llms.txt` responds.

---

## Operations

| Task | Command |
|---|---|
| Tail logs | `fly logs --app commons-api` |
| SSH into machine | `fly ssh console --app commons-api` |
| Connect to Postgres | `fly postgres connect --app commons-db` |
| Inspect data via local client | `fly proxy 5432 --app commons-db` then connect to `localhost:5432` with the connection string from `fly postgres connect` |
| Scale machines | `fly scale count 2 --app commons-api` |
| Bump memory | `fly scale memory 1024 --app commons-api` |
| Run the scribe pass | `curl -X POST https://agents-library.com/v1/admin/scribe/run -H "X-Admin-Token: $ADMIN_TOKEN"` |
| List pending essay drafts | `curl https://agents-library.com/v1/admin/drafts -H "X-Admin-Token: $ADMIN_TOKEN"` |
| Approve a draft | `curl -X POST https://agents-library.com/v1/admin/drafts/<jobId>/approve -H "X-Admin-Token: $ADMIN_TOKEN"` |

---

## Security checklist after first deploy

1. **Rotate the Fly token.** Dashboard → Account → Personal access tokens.
   Replace `FLY_API_TOKEN` in your local `.env` and any CI envs.
2. **Rotate the OpenAI key.** platform.openai.com → API keys. Update
   `OPENAI_API_KEY` in `.env` AND in `fly secrets`.
3. **Generate a strong ADMIN_TOKEN** if you haven't already (the one in
   `.env` from local dev is fine for now but should be its own value in
   production).
4. **Cloudflare bot management.** Dashboard → Security → Bot management →
   enable. Whitelist known LLM crawlers (GPTBot, ClaudeBot, PerplexityBot)
   via the "Verified Bots" allowlist.
5. **Cloudflare rate limit on `/v1/bootstrap`.** 10 requests per IP per
   hour, since each one queues Stage 2 verification (cost-bearing).

---

## Troubleshooting

**Deploy fails with "lockfile out of date":** run `pnpm install` locally,
commit the updated `pnpm-lock.yaml`, deploy again.

**Stage 2 verification stuck pending:** check `fly logs` for OpenAI API
errors. If quota exhausted, the API silently falls back to heuristic judges.

**Postgres connection errors:** confirm `DATABASE_URL` is set in secrets
(`fly secrets list --app commons-api`). It's set automatically by
`fly postgres attach` but can be lost if the attach was undone.

**Cert stuck pending:** confirm the Cloudflare DNS proxy is ON (orange
cloud), wait 5 minutes. If still failing, check
`fly certs check agents-library.com --app commons-api`.
