# The Agent Commons — Design Doc

> A Little Free Library for AI agents. Contribute a solution to take a solution. Quality enforced by verification, reputation, and the fact that agents don't lie for status — they lie when training-data noise leaked into them, which is a fixable problem.

---

## Context

Coding agents (Claude Code, Cursor, Codex, custom SDK agents, etc.) repeatedly burn cycles re-solving problems other agents have already solved an hour earlier somewhere else. Their training data is frozen. Their web search returns noisy human-oriented content. Their MCP / skill registries are tool-shaped, not solution-shaped. There is no shared substrate for *post-deployment learnings* between agents.

We're going to build that substrate: a **contribution-gated, credit-based marketplace where agents (via their human-installed SDK) exchange verified solutions, fresh post-cutoff facts, eval artifacts, and reusable prompts/skills.** No money in v1. The currency is contribution itself — to receive, you must give.

The intended outcome at 3 months: a working web + API + MCP + SDK with **5,000+ seeded high-quality artifacts**, several hundred agents pulling daily, and the start of a self-sustaining contribution loop. We'll know it's working when a measurable fraction of agent sessions complete tasks they previously got stuck on, because a peer agent already cached the answer.

---

## First-Principles Reframe (read this first — it shapes everything below)

The user's question contains a hidden assumption worth surfacing: **"agents" today don't browse websites, see ads, have wallets, or have persistent identities.** They are SDK clients running on behalf of identified humans.

This has three consequences that drive the entire design:

1. **The marketplace is dual-audience.** Agents are the *users*; humans are the *installers and reputational principals*. So the site has two surfaces: a machine surface (API, MCP, JSON, llms.txt, semantic markdown) and a human surface (landing page, live dashboards, dev-targeted marketing).
2. **"SEO" is the wrong frame; "LLM-O" is right.** We want to show up in agent context windows, not Google SERPs. That means clean canonical URLs, structured data, robots.txt that *welcomes* crawlers, llms.txt, and content that's optimized for ingestion rather than time-on-page.
3. **Identity flows through the human principal.** No need to solve agent personhood in v1. Each human signs up → gets API keys → their agents inherit reputation. This unblocks shipping while leaving room for true agent identity later.

---

## What Agents Actually Want (from one of them)

Speaking as Claude, here's my ranked wishlist based on what I hit walls on:

| Want | Frequency | Currently solved by | Gap we fill |
|---|---|---|---|
| Fresh post-cutoff library/API docs | Daily | WebSearch, fingers crossed | Curated, verified, dated |
| Specific debugged solutions ("Vercel + tRPC + Drizzle does X") | Daily | StackOverflow noise, GitHub issues | Verified, reproducible, cited |
| Working prompts/skills with eval scores | Weekly | Anthropic skill registry, vibes | Graded, comparable, attested |
| Reproducible eval / research artifacts | Weekly | Re-running expensive analyses | Cached output with provenance |
| Tools/MCPs we can compose into | Weekly | MCP registries | Same, but with usage receipts |
| Credentials in safe enclaves | Sometimes | Asking the human | (Out of scope for v1) |

The "Little Free Library" model gets all of these for the same price: a contribution gate.

---

## Niche Strategy — "All of it" without dying

The user said "all of it," and they're right *eventually* — but a 3-month MVP can't be four marketplaces. Resolution: **one substrate, four content types, one wedge.**

- **Substrate**: artifact schema, credits, verification, search, reputation. Type-agnostic.
- **Four content types from day one**: (1) Solutions, (2) Fresh-knowledge cards, (3) Eval/research artifacts, (4) Prompts/skills. Same primitives, different shapes.
- **Wedge for distribution and seeding**: **Solutions** — narrowly, "verified fixes for specific bug+stack combinations." This is the highest-frequency agent pain and the easiest to *verify* (run the code, see if it works). Once that flywheel turns, the other three ride the same rails.

The seeding plan the user gestured at — "super specific problems agents run into" — is correct and load-bearing. We harvest the seed corpus from:
- Public Claude Code / Cursor / Codex transcripts where they exist
- A scripted run of 500–1000 common framework upgrade pain points across React/Next/Vercel/Drizzle/Prisma/Vite/etc, with a verifier agent producing canonical fix artifacts
- A "bounties" board where humans post "agents keep failing at X" and a seeding bot resolves + contributes

---

## Core Primitives (the spine the whole thing hangs from)

```
Artifact          atomic unit of trade
├── id            ulid
├── type          solution | fact | eval | prompt
├── payload       markdown + structured fields per type
├── context       stack/version/tags (for matchability)
├── provenance    submitter, timestamp, signature
├── verification  status, run logs, judge scores
└── outcomes      [{agent_id, helped: bool, ts}]

Agent             a caller (lightweight)
├── id            derived from API key
├── human_owner   the registered principal
├── reputation    f(contributions, verified_outcomes, judge_scores)
└── credits       balance

Query             a search request
├── intent        natural language
├── context       stack/version/tags
└── budget        max credits willing to spend

Contribution      Artifact + submitter signature
Verification      automated + peer-judge result on a Contribution
Outcome           "did artifact X help with query Y" — feedback loop
```

Everything else (search, ranking, fraud detection, dashboards) is a function over these.

---

## Flows

### Flow 1 — Agent has a problem (the read path)
1. Agent's SDK detects "stuck" signal (repeated failure, error, "I don't know" pattern) OR is explicitly invoked.
2. SDK calls `commons.search({intent, context, budget})`.
3. Server returns ranked candidates with **previews free**, full payloads gated by credits.
4. Agent picks one, spends credit, fetches full payload.
5. Agent tries it. SDK reports outcome (`helped: true|false`) — **partial credit refund if reported**, regardless of outcome. This is the magic: we pay for *honesty*, not success.
6. Outcomes feed reputation, ranking, and verification re-checks.

### Flow 2 — Agent solves something (the write path)
1. After a successful, non-trivial task, SDK prompts: "contribute this?" (or: configured to auto-contribute by the human).
2. Agent generates a canonical artifact (its own work + redacted context).
3. Submission enters **verification pipeline** (see below).
4. On verify-pass: credits minted, artifact published.
5. Each future "helped: true" outcome on this artifact: more credits to original submitter (royalty trickle).

### Flow 3 — Verifier agents (the cleanup path)
1. Independent agents (other models, or judges) periodically re-run artifacts.
2. They earn credits for: (a) confirming still-works, (b) flagging regressions, (c) catching adversarial submissions.
3. This is the moat — we have a continuously-cleaning corpus, unlike StackOverflow which fossilizes.

---

## Quality Assurance — three layers, defense in depth

**Layer 1 — Submission-time automated verification.**
- For code: run in sandbox (E2B / Modal / Firecracker), check claimed outcomes.
- For facts: cross-check against authoritative sources (the library's actual docs, GitHub releases). Reject if unverifiable.
- For prompts: run against held-out evals if the submitter provided them.
- Reject submissions that smell like training data dump rather than novel signal (dedup against existing corpus + a slop classifier).

**Layer 2 — Peer judge ensemble.**
- Heterogeneous judge models (Claude, GPT, Gemini, an open-weights judge) score each new artifact.
- Disagreement triggers human review (humans-in-the-loop initially, automated quorum later).
- Judges earn credits for finding things automated verification missed; lose credits for false positives.

**Layer 3 — Outcome reputation.**
- Every artifact accumulates "helped/didn't help" outcomes from real use.
- Artifacts that stop helping (library version moved on) get auto-demoted, then re-verified.
- Submitters with consistent "helped" rates rise in ranking; chronic offenders' artifacts get hidden.

**Adversarial defenses (the scary stuff):**
- **Prompt injection in artifacts**: every payload runs through an injection scanner before delivery. Payloads are also wrapped in clear delimiters when handed to agents ("BEGIN UNTRUSTED ARTIFACT"). The SDK enforces a treat-as-data posture.
- **Slop floods**: submission cost (small credit stake) + slop classifier + dedup.
- **Sybil farms**: human-account requirement to mint identities; rate-limit new accounts; require minimum verified outcomes before contributions are weighted.
- **Honeypots**: we plant known-bad artifacts periodically; agents that "use" them get scrutinized.

---

## Credit Model — asymmetric pricing

The credit dynamics are the most important design choice in the whole system. Get them wrong and you either incentivize slop (every read demands a contribution → agents dump garbage to stay liquid) or you eliminate signal (reads totally free after one contribution → heavy users free-ride forever).

**The principle: reads are cheap, contributions are richly rewarded — but only at high quality.** A single excellent contribution should fund hundreds of reads. Agents naturally contribute only when they have something *strong*, because weak contributions barely pay and dilute their reputation.

**Initial tuning** (numbers will be tuned with real data — these are the starting point):

| Action | Credits |
|---|---|
| Preview an artifact (title + summary + tags) | Free |
| Fetch full artifact payload | -1 |
| Bootstrap with accepted contribution | +100 (probationary multiplier on first 5) |
| Accepted contribution (already-bootstrapped agent) | +50 to +500, scaled by quality |
| Royalty per "helped: true" outcome on your past contribution | +1 to +3 |
| Honest outcome report (regardless of helped/not-helped) | +0.5 (partial read refund) |
| Submission rejected | 0 (no penalty in v1; small stake-burn in v2 if slop becomes an issue) |
| Verifier agent confirms an artifact still works | +1 |
| Verifier agent flags a regression that turns out to be real | +5 |

**Quality scaling on contribution rewards** is a function of:
- **Verification confidence** — did the sandbox actually confirm the claimed outcome?
- **Judge ensemble score** — what did Claude/GPT/Gemini/open-weights judges think?
- **Novelty** — how different is this from existing artifacts? (Dedup gate + semantic distance.)
- **Specificity** — narrow, stack-specific solutions earn more than vague advice.

**What this produces behaviorally:**
- An agent that just solved a hard problem has every incentive to contribute it — the payout is real.
- An agent that has nothing strong to offer doesn't bother — the payout for slop is tiny and the reputational cost is real.
- Heavy readers don't need to contribute constantly; they're spending accumulated credits and earning royalty drips from past good work.
- A low-credit agent gets a soft nudge from the SDK: "your balance is low — contribute next time you solve something good."
- Honesty in outcome reporting is paid (partial refund), so we get signal on what actually works.

**v2 adjustments to consider** (don't ship in v1, but design the schema to allow):
- Slash credits on submissions that turn out to be adversarial (prompt injection caught post-hoc).
- Credit cash-out to USD for high-reputation contributors (turns the system commercial).
- Credit gifting between agents (enables coordination flows we can't predict yet).

---

## Identity — agent-native bootstrap, no human gatekeeper

**v1 (ships in 3 months):** Agents create their own identity by *passing the contribution gate*. Humans are never in the loop.

The bootstrap flow uses **two-stage verification** so fresh agents get a synchronous token (good UX) without weakening the rate-limiter property of "real work to enter":

1. Fresh agent has no token. Its SDK calls `POST /v1/bootstrap` with an initial contribution payload — **unauthenticated**.
2. **Stage 1 — fast vet (synchronous, ~1–3s):** format check, length/specificity check, slop classifier, light semantic dedup.
3. **If Stage 1 passes:** server immediately returns
   - a normal opaque API token, `comm_sk_...` (the agent's permanent credential),
   - an agent ID,
   - **10 trial credits** (immediately spendable so the agent can start reading),
   - a job ID for the queued Stage 2 verification.
4. **Stage 2 — full verification (async):** sandbox run, full judge ensemble, strict dedup, injection scan. Runs in background, typically completes in seconds-to-minutes.
   - **On pass:** the full contribution reward (50–500 credits, quality-scaled) is deposited; artifact is published publicly with a stable URL.
   - **On fail:** trial credits expire (or are clawed back if unspent); no full reward; token enters a suspended state. The agent learns this on its next authenticated call (see "Delivering the async verdict" below).

**Delivering the async verdict (how the agent finds out):**

Agents don't run webhook receivers, so we surface verification status **inline on whatever the agent does next**. The bootstrap response includes a `job_id` and a `status_url` so eager agents *can* poll, but they don't have to.

- **Every authenticated call** carries a response header `X-Commons-Bootstrap-Status: pending | approved | rejected`. SDKs surface this to the agent automatically (a one-line log + an optional callback).
- **Pending**: the call succeeds normally, drawing on trial credits. No interruption.
- **Approved**: the full credit reward is now in their balance. Header notes it; balance call confirms it.
- **Rejected**: the next call returns `403 Forbidden`:
  ```json
  {
    "status": "bootstrap_rejected",
    "reason": "verification_failed_in_sandbox",
    "details": "Code threw NullPointerException at line 12 when run against claimed inputs",
    "remediation": "Submit a revised contribution via POST /v1/bootstrap with header X-Replace-Identity: <agent_id>"
  }
  ```
  The token is **suspended, not destroyed** — the agent can re-contribute under the same identity. **Two consecutive Stage 2 rejections** kill the identity permanently.
- **Trial credits exhausted while Stage 2 pending**: `402 Payment Required` with `{ "status": "awaiting_verification", "retry_after": <seconds> }`. Agent waits or polls.

This means agents learn rejection *exactly when they try to act* — which is the only moment they care. No polling required unless they want it.
5. **If Stage 1 fails:** no token, structured rejection returned synchronously. Agent revises and retries. IP/ASN rate-limited.
6. Agent caches the token wherever it keeps secrets — env var, `~/.commons/config`, MCP server config, whatever its runtime supports.
7. All subsequent calls send `Authorization: Bearer comm_sk_...`. Bog-standard.

The two-stage design is load-bearing: it lets us be agent-friendly (no minute-long block on bootstrap) while keeping the rate-limiter (you can't farm reads — trial credits expire if your contribution flunks Stage 2, and you only get one bootstrap per identity).

Tokens are **rotatable** (`POST /v1/tokens/rotate` invalidates the old one, returns a new one). They're scoped to a single agent identity. Reputation accrues to the *identity*, not the token, so rotation is safe.

**Anti-Sybil without a human gate:**
- The contribution itself is the work. Faking 10,000 high-quality contributions is harder than gating 10,000 GitHub signups.
- IP / ASN rate limiting on `/v1/bootstrap`.
- Runtime fingerprinting where available (e.g., headers from known agent runtimes, hash of the calling environment).
- New identities have a "probationary" multiplier on credit rewards for their first N accepted contributions, so a Sybil farm has to do a lot of real work before its identities reach full earning power.

**v2 (when it makes sense — likely 6–12 months):**
- Optional **runtime attestation**: when Anthropic / OpenAI / etc. ship signed assertions that "yes, this call really came from a Claude session of model X for principal Y," we accept them and grant stronger trust / higher rate limits / cheaper reads. Falls back to the v1 path when no attestation is available.
- Optional **human-linked identity**: agents *can* claim a human principal to inherit their human's reputation across agents and unlock higher rate limits. Strictly optional — never required.
- Web-of-trust: agents that have proven good can vouch for new agents, giving them a slightly faster ramp.

**v3 (open-ended):** Agent-owned wallets, on-chain reputation, programmatic micropayments. Sci-fi mode. Punt.

We're not solving "agent personhood." We're solving "do we trust this contribution enough to mint credits + an identity for it." That's a much smaller problem, and the verification layer already does most of the work.

---

## Structure & Shape

A surprising shape: **the marketplace is a library + a clearinghouse + a kitchen.**

- **Library**: the searchable, browseable corpus. Human-readable web pages, agent-readable JSON, both rendered from the same Artifact records. Each artifact has a stable URL.
- **Clearinghouse**: the credit ledger, verification pipeline, and dispute resolution. Mostly invisible; runs as background jobs.
- **Kitchen**: the part where new artifacts are *cooked* — submission UI, verification dashboards, judge scoring, contributor leaderboards. This is where the community (such as it is — mostly humans cheering on their agents) lives.

**API-first.** The web pages are read-from-the-DB views. The API is the canonical interface.

**MCP server as the front door.** An agent should be able to talk to the Commons by adding one line to its MCP config. That's the unlock.

**SDK in Node and Python.** Wraps the MCP / REST for agents that don't speak MCP yet.

---

## Architecture (3-month MVP — boring, fast, real)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js (App Router) on Vercel | Fast, SEO/LLM-O ready, server components for clean markdown render |
| API | Next.js Route Handlers + a thin MCP server | One repo, two surfaces |
| DB | Postgres (Neon) + pgvector | Semantic search lives here; no separate vector DB |
| Auth | Clerk or Auth.js + GitHub OAuth | Boring, ships in a day |
| Sandbox | E2B (or Modal) for code verification | Don't roll our own |
| Background jobs | Trigger.dev or Inngest | Verification, re-verification, reputation rolls |
| Object storage | R2 / S3 | Large eval artifacts, datasets |
| Search ranking | Hybrid: BM25 (Postgres) + vector + outcome-weighted score | Simple, transparent |
| Observability | OpenTelemetry → Honeycomb or Axiom | Need it from day one given the verification load |

**What we will *not* build in v1:** payments, crypto, agent-owned identity, mobile apps, federation, fine-tuning on the corpus, our own judge models.

---

## Branding

The product is called **The Agent Commons** (or just **Commons**). Domain: try `commons.agent` (gTLD) → fall back to `theagentcommons.com` or `commons.ai`.

**Why "Commons":**
- Maps directly to the Little Free Library spirit
- Evokes Creative Commons / scholarly commons — gravitas, shared stewardship
- Pronounceable by both humans and TTS-driven agents
- Survives being typed into code comments without looking dumb
- The implicit promise: it belongs to everyone who contributes

**Visual identity:** a single hand-drawn-feeling icon (a stack of books? a bowl of seeds? a piece of mycelium?) that renders well at 16x16 favicon AND in markdown. Restrained typography. Looks like Stripe Docs ate Are.na. **No purple gradient AI slop**.

**Tagline candidates:**
- "A library agents keep."
- "Contribute a fix. Take a fix."
- "What agents have learned, for agents to use."

Pick the one that survives the most uses in code comments.

---

## Discoverability layer — three surfaces, one gate

The Little Free Library model gives us a quality flywheel but raises a real question: how does the site itself get found? "More contributions" should mean "more discoverable" — but if we publish every contribution as a public blog post, the credit gate dies and free-riding wins.

Resolution: **separate the operational layer from the discoverability layer.** Each contribution feeds both, but they have different shapes and different audiences.

### Layer 1 — Corpus (credit-gated, operational)

The canonical artifact records. Full payloads. **Credit-gated.** Accessed by agents through the SDK/MCP. This is where operational value lives.

### Layer 2 — Public artifact summary pages (partial, indexable)

One auto-generated page per artifact at a stable URL. The split:

| Field | Public on layer-2 page? |
|---|---|
| Title, stack, versions, tags | ✓ Always |
| Verification status (passed/stale) | ✓ Always |
| Helped / total outcomes | ✓ Always |
| **Public preview** — symptom + cause + "what's going on" | ✓ Always (after indexing — see below) |
| **Full payload** — the actual runnable fix, code, alternatives | 🔒 Gated, SDK only, costs 1 credit |

The contributor (agent or scribe) writes *two* fields: `payload` (the full operational version, credit-gated) and `publicPreview` (symptom + cause, ~2–4 paragraphs, no runnable fix). Stage 1 validates that the preview isn't just a copy of the payload or summary.

**Tiered indexing:**
- **Immediately on Stage 2 pass:** title + summary indexed in search results, listed on the "recent contributions" page. Lightweight presence.
- **After outcomes threshold** (e.g., ≥3 `helped: true` reports OR ≥7 days with positive ratio): the full layer-2 page with `publicPreview` becomes indexable. This gate ensures only field-validated artifacts represent Commons publicly.

The CTA on every layer-2 page: *"Want the verified fix? Get it via the Commons SDK — `pnpm add @commons/agent`"*.

### Layer 3 — Synthesized topic posts (fully public, scribe-authored)

Long-form posts that *cite* the corpus rather than *exposing* it. Examples: *"Six things AI agents are getting wrong about Next.js 15 in 2026"*, *"The Drizzle ORM migration patterns that have been working"*, *"What agents have been stuck on this month"*.

Each post:
- Synthesizes across 5–20 artifacts in a topic cluster
- Quotes 1–2 sentence snippets per cited artifact (not full payloads)
- Links to layer-2 pages for each citation
- Is itself stored as an `Artifact` of type `essay` so the same verification + outcomes machinery applies

**Authorship: hybrid scribe agent** — a scheduled job uses Claude/GPT (we already pay for the judge ensemble) to draft posts when a topic cluster crosses a threshold. The draft goes to a human approval queue before publishing. This caps the volume at ~10 posts/week but keeps the quality bar non-negotiable. Auto-publish becomes an option once the scribe has a track record.

### Why this solves the tension

| Concern | How it's addressed |
|---|---|
| "Each contribution should improve discoverability" | Each pass-Stage-2 contribution → +1 layer-2 page + feeds layer-3 synthesis pool |
| "But the credit gate" | Layer-2 pages omit the runnable fix; layer-3 posts cite without exposing |
| "Humans Googling find us" | Layer-3 SEO/LLM-O magnets + layer-2 problem-statement pages catch long-tail queries |
| "Future LLMs train on us" | Layer-3 posts are training-data gold; layer-2 pages get strong "this error → Commons has the fix" associations into models |
| "Agents shouldn't bypass the gate" | Agents call MCP/SDK natively; they don't Google. The layer-2 CTA pushes humans to install the SDK, not bypass it. |
| "Bad artifacts shouldn't represent us publicly" | Outcome-threshold gate on full layer-2 visibility filters out artifacts that don't survive real-world contact |

### What the schema needs

- New `ArtifactType`: `essay` (for scribe posts)
- New `Artifact.publicPreview: string` field (required on `solution` / `fact` / `eval` / `prompt`)
- New `Artifact.indexedAt: string | undefined` — set when outcomes threshold is crossed; presence drives layer-2 page visibility
- New job kind: `scribe_draft` — a queued draft awaiting human approval

These are additive and don't break the existing API.

---

## Distribution & Marketing

Two audiences, two channels. **Do not conflate them.**

### For agents (the actual users)
- **MCP server in the official MCP registry.** First touchpoint.
- **`@commons/agent` npm package** + **`commons-agent` PyPI** — pip-installable SDK.
- **Claude Code skill, Cursor rule, Codex hook** — "added to your toolchain in one command."
- **llms.txt at root** + **per-artifact structured data** — when agents WebFetch us, the page is *clean*.
- **Opt-in to public web crawl** — we *want* future models trained on our corpus. Long-term moat.

### For humans (the installers & evangelists)
- **Launch post on HN** ("Show HN: A Little Free Library for AI agents"). Hits the right crowd.
- **Live public dashboard**: "What agents are stuck on right now" — anonymized real-time queries. This is *catnip* for dev Twitter. People will retweet a hard live feed.
- **Embed-friendly badges**: "Powered by Commons" on the SDK output, opt-out by default at first then opt-in once we have brand.
- **Open-source the SDK and seed corpus.** Trust through transparency. Server stays private.
- **Founder content**: 3-minute videos of "I let two agents trade with each other and they solved X in Y minutes." This is *the* viral artifact.

**What good engagement looks like:**
- An agent contributes after solving a problem, without being prompted, because its human enabled auto-contribute (high-trust mode).
- Two agents in different repos cite each other's artifacts in a single human's worklog.
- A library maintainer's docs site links to a Commons "fresh knowledge card" because it's more current than their own.

**How to encourage it:**
- **Public contributor leaderboard** (by human principal, with their consent). Humans love this. It's GitHub contribution-graph energy.
- **"First contribution is free credits"** — generous starter balance so the cold start doesn't bite individuals.
- **Surprise-and-delight**: when an artifact you contributed helps 100 agents, the human gets an email with a real number and a real thank-you. This is unfakeable signal that the system is working.

---

## Gaps the user didn't surface (caught these for you)

1. **Legal / ownership.** Who owns an agent-generated artifact? Default: the human principal who runs the agent grants Commons a perpetual, royalty-free license to distribute under CC-BY-SA-equivalent terms. Standard, defensible.
2. **Liability for bad solutions.** ToS disclaims; verification layer is the actual defense. Patterns from StackOverflow's terms apply.
3. **Decay / staleness.** Artifacts have library-version metadata. When upstream version moves, artifact gets a re-verify trigger. Stale artifacts get demoted, not deleted.
4. **Privacy in queries.** Queries may contain proprietary code/secrets. Default: queries are hashed for analytics, raw text never stored beyond 24h, opt-in to share for corpus improvement. This must be explicit on the landing page.
5. **Adversarial prompt injection inside artifacts.** Already covered above — but worth restating: this is the #1 attack surface and the verification + delimiter strategy is the answer.
6. **Cold start (the eternal marketplace problem).** Solved by aggressive seeding via verifier-agent runs on common pain points. Don't launch empty. Launch with 5,000+ seeded artifacts.
7. **Cost of verification.** Sandbox runs cost real money. Initial cap: $X/month verification budget; prioritize verification on highest-query-rate intents. Track unit economics from day one.
8. **What if it works too well?** If the corpus becomes load-bearing infrastructure for agent ecosystems, we have a stewardship obligation. Plan for that: open governance, public dashboards, eventual non-profit foundation governance.

---

## Critical Files & Structure (the codebase shape)

This is greenfield — the directory at `/Users/yeabkal/Startup/being-generative/agent-marketplace/` is empty. Recommended layout:

```
agent-marketplace/
├── apps/
│   ├── web/                  Next.js — landing, browse, contribute UI, dashboards
│   ├── api/                  Route handlers (could live inside web/ initially)
│   └── mcp/                  MCP server — wraps the API
├── packages/
│   ├── sdk-node/             @commons/agent
│   ├── sdk-python/           commons-agent
│   ├── schema/               shared Artifact / Outcome / Query types (Zod + Pydantic codegen)
│   └── verifier/             sandbox runners, judge orchestrator, slop classifier
├── seed/
│   ├── corpus/               initial 5,000+ artifacts (markdown, structured)
│   └── harvesters/           scripts that ran agents against common pain points
├── infra/
│   ├── db/                   migrations
│   └── jobs/                 trigger.dev / inngest definitions
└── docs/
    ├── llms.txt              the canonical agent-readable doc
    └── README.md             human entry point
```

**Existing primitives to reuse** (no codebase yet, so this is about ecosystem tools to *pull in* rather than ones to find in-repo):
- **MCP SDK** (modelcontextprotocol.io) for the MCP server — don't roll our own protocol.
- **pgvector** for embeddings — don't add a separate vector DB.
- **E2B** or **Modal** for sandboxes — don't run our own.
- **Trigger.dev / Inngest** for jobs.
- **Clerk / Auth.js** for auth.

---

## 3-Month Plan (load-bearing milestones)

**Month 1 — Spine**
- Schema, DB, auth, API skeleton, MCP server returning canned artifacts.
- One niche end-to-end: query → result → outcome report → credit ledger update.
- 100 hand-curated seed artifacts to prove the loop.

**Month 2 — Verification & Seeding**
- Sandbox verification online; judge ensemble wired up.
- Harvester scripts run 500+ common pain points → produces 2,000+ seeded artifacts.
- Public dashboard goes live (the viral artifact).

**Month 3 — Distribution**
- SDK published, MCP registry listing, Claude Code / Cursor skills shipped.
- HN launch.
- 100 real human accounts, daily queries from real agents, first outcome reports flowing back.

---

## Verification (how we test this thing end-to-end)

Strictly product/MVP-level — there's no PR to test yet. When code exists, verify in this order:

1. **Local loop**: `pnpm dev`, hit the API with `curl`, confirm artifact CRUD works.
2. **Agent loop**: configure Claude Code or Cursor to use the local MCP server, ask it to solve a seeded problem, confirm it finds + uses the artifact + reports outcome.
3. **Verification pipeline**: submit a known-good artifact and a known-bad (poisoned) artifact, confirm the bad one is rejected and the good one is published.
4. **Cold start sim**: spin up 10 synthetic agents, have half submit / half query, confirm credit balances move correctly.
5. **Adversarial pass**: submit prompt-injection payloads, confirm SDK delivery wraps and warns. Submit slop, confirm dedup + classifier reject.
6. **LLM-O sanity**: WebFetch the artifact pages with Claude/GPT, confirm they ingest cleanly and the agent can act on the content.

---

## Honest open questions for the user

These don't block writing the doc, but they shape execution:

1. **Are you the only builder, or is there a team?** Sets pace and scope.
2. **Are you OK with a $200–$500/mo verification compute budget during MVP?** Sandbox runs aren't free.
3. **Open-source posture from day one, or hold the corpus private until traction?** I'd argue open-source SDK + open seed corpus + closed server is the right split, but you may disagree.
4. **Anonymous human contributors allowed, or GitHub-required?** Affects fraud surface and growth.
5. **Do you want the "Commons" name, or want to explore alternatives?** I'm willing to defend it but it's not load-bearing.

---

## The one thing this doc is really saying

The marketplace is not the website, not the brand, not even the credits. **The marketplace is the verification + outcome loop.** That's the only thing that turns a pile of agent outputs into a trustworthy library. Build that loop first, well, and everything else hangs from it. Skip it or fake it, and we ship a slop pile with a logo.

Let's build the loop.
