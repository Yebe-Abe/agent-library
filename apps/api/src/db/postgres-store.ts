/**
 * PostgresStore — drop-in for createMemoryStore() backed by Drizzle ORM.
 *
 * Works against both:
 *   - postgres-js (production, Fly Postgres)
 *   - PGlite (in-process, embedded; for tests + local dev without docker)
 *
 * Both drivers are wrapped by Drizzle which gives us a uniform query API.
 * Same Store interface as the in-memory implementation, so callers don't change.
 */

import { eq, and, type SQL } from "drizzle-orm";
import { drizzle as drizzlePostgresJs, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import type {
  Agent,
  Artifact,
  CreditLedgerEntry,
  Job,
  Outcome,
} from "@commons/schema";
import type { Store } from "../store.js";
import { MIGRATION_SQL, agents, artifacts, creditLedger, jobs } from "./schema.js";

// Drizzle's PostgresJsDatabase and PgliteDatabase have compatible query APIs
// for our usage, so we accept either.
export type AnyDrizzleDb =
  | PostgresJsDatabase<Record<string, unknown>>
  | PgliteDatabase<Record<string, unknown>>;

// ─── Factories ───────────────────────────────────────────────────────────────

/** Production: connect to a real Postgres via DATABASE_URL. */
export async function createPostgresStore(
  databaseUrl: string,
): Promise<{ store: Store; close: () => Promise<void> }> {
  const sql = postgres(databaseUrl, { max: 10, prepare: false });
  const db = drizzlePostgresJs(sql);
  await runMigrations(db);
  return {
    store: buildStore(db),
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

/** Tests + local dev without docker: embedded pglite. */
export async function createPgliteStore(): Promise<{
  store: Store;
  close: () => Promise<void>;
}> {
  const pg = new PGlite();
  await pg.waitReady;
  const db = drizzlePglite(pg);
  await runMigrations(db);
  return {
    store: buildStore(db as AnyDrizzleDb),
    close: () => pg.close(),
  };
}

/** Run migrations idempotently. */
async function runMigrations(db: AnyDrizzleDb): Promise<void> {
  // Execute the hand-written SQL. Drizzle's execute() returns a result;
  // both pglite and pg accept the same string.
  for (const stmt of MIGRATION_SQL.split(/;\s*\n/)) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    // `unsafe` here is just "execute this DDL"; not SQL-injection unsafe — the
    // string is hand-written + checked in.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db as any).execute(trimmed);
  }
}

// ─── Store implementation ────────────────────────────────────────────────────

function buildStore(db: AnyDrizzleDb): Store {
  return {
    // ─── agents ─────────────────────────────────────────────────────────────
    async createAgent(a: Agent): Promise<void> {
      await db.insert(agents).values(rowFromAgent(a));
    },
    async getAgent(id) {
      const rows = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      return rows[0] ? agentFromRow(rows[0]) : undefined;
    },
    async getAgentByTokenHash(tokenHash) {
      const rows = await db
        .select()
        .from(agents)
        .where(eq(agents.tokenHash, tokenHash))
        .limit(1);
      return rows[0] ? agentFromRow(rows[0]) : undefined;
    },
    async updateAgent(id, patch) {
      const cur = await this.getAgent(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      await db.update(agents).set(rowFromAgent(next)).where(eq(agents.id, id));
      return next;
    },

    // ─── artifacts ──────────────────────────────────────────────────────────
    async createArtifact(a: Artifact): Promise<void> {
      await db.insert(artifacts).values(rowFromArtifact(a));
    },
    async getArtifact(id) {
      const rows = await db
        .select()
        .from(artifacts)
        .where(eq(artifacts.id, id))
        .limit(1);
      return rows[0] ? artifactFromRow(rows[0]) : undefined;
    },
    async updateArtifact(id, patch) {
      const cur = await this.getArtifact(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      await db.update(artifacts).set(rowFromArtifact(next)).where(eq(artifacts.id, id));
      return next;
    },
    async allArtifacts() {
      const rows = await db.select().from(artifacts);
      return rows.map(artifactFromRow);
    },
    async corpusForDedup() {
      const rows = await db
        .select({
          id: artifacts.id,
          title: artifacts.title,
          summary: artifacts.summary,
          payload: artifacts.payload,
        })
        .from(artifacts);
      return rows;
    },

    // ─── jobs ───────────────────────────────────────────────────────────────
    async createJob(j: Job): Promise<void> {
      await db.insert(jobs).values(rowFromJob(j));
    },
    async getJob(id) {
      const rows = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
      return rows[0] ? jobFromRow(rows[0]) : undefined;
    },
    async updateJob(id, patch) {
      const cur = await this.getJob(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      await db.update(jobs).set(rowFromJob(next)).where(eq(jobs.id, id));
      return next;
    },
    async allJobs(filter) {
      const where: SQL[] = [];
      if (filter?.kind) where.push(eq(jobs.kind, filter.kind));
      if (filter?.status) where.push(eq(jobs.status, filter.status));
      const q = db.select().from(jobs);
      const rows = where.length
        ? await q.where(where.length === 1 ? where[0] : and(...where))
        : await q;
      return rows.map(jobFromRow);
    },

    // ─── outcomes (stored as JSONB array on artifact) ───────────────────────
    async appendOutcome(artifactId, outcome) {
      const art = await this.getArtifact(artifactId);
      if (!art) return;
      const next = [...art.outcomes, outcome];
      await db
        .update(artifacts)
        .set({ outcomes: next })
        .where(eq(artifacts.id, artifactId));
    },

    // ─── credit ledger ──────────────────────────────────────────────────────
    async appendLedger(entry) {
      await db.insert(creditLedger).values({
        id: entry.id,
        agentId: entry.agentId,
        delta: entry.delta,
        reason: entry.reason,
        artifactId: entry.artifactId,
        ts: entry.ts,
      });
    },
    async ledgerForAgent(agentId) {
      const rows = await db
        .select()
        .from(creditLedger)
        .where(eq(creditLedger.agentId, agentId));
      return rows.map((r) => ({
        id: r.id,
        agentId: r.agentId,
        delta: r.delta,
        reason: r.reason as CreditLedgerEntry["reason"],
        artifactId: r.artifactId ?? undefined,
        ts: r.ts,
      }));
    },
  };
}

// ─── Row ↔ Domain mappers ────────────────────────────────────────────────────

function rowFromAgent(a: Agent) {
  return {
    id: a.id,
    tokenHash: a.tokenHash,
    status: a.status,
    credits: a.credits,
    contributionsAccepted: a.contributionsAccepted,
    consecutiveRejections: a.consecutiveRejections,
    reputation: a.reputation,
    createdAt: a.createdAt,
    bootstrapFingerprint: a.bootstrapFingerprint ?? null,
    humanOwner: a.humanOwner ?? null,
  };
}

function agentFromRow(r: Record<string, unknown>): Agent {
  return {
    id: r.id as string,
    tokenHash: r.tokenHash as string,
    status: r.status as Agent["status"],
    credits: r.credits as number,
    contributionsAccepted: r.contributionsAccepted as number,
    consecutiveRejections: r.consecutiveRejections as number,
    reputation: r.reputation as number,
    createdAt: r.createdAt as string,
    bootstrapFingerprint: (r.bootstrapFingerprint as string | null) ?? undefined,
    humanOwner: (r.humanOwner as string | null) ?? undefined,
  };
}

function rowFromArtifact(a: Artifact) {
  return {
    id: a.id,
    type: a.type,
    title: a.title,
    summary: a.summary,
    publicPreview: a.publicPreview ?? null,
    payload: a.payload,
    context: a.context,
    provenance: a.provenance,
    verification: a.verification,
    outcomes: a.outcomes,
    published: a.published,
    indexedAt: a.indexedAt ?? null,
  };
}

function artifactFromRow(r: Record<string, unknown>): Artifact {
  return {
    id: r.id as string,
    type: r.type as Artifact["type"],
    title: r.title as string,
    summary: r.summary as string,
    publicPreview: (r.publicPreview as string | null) ?? undefined,
    payload: r.payload as string,
    context: r.context as Artifact["context"],
    provenance: r.provenance as Artifact["provenance"],
    verification: r.verification as Artifact["verification"],
    outcomes: (r.outcomes as Outcome[]) ?? [],
    published: r.published as boolean,
    indexedAt: (r.indexedAt as string | null) ?? undefined,
  };
}

function rowFromJob(j: Job) {
  return {
    id: j.id,
    agentId: j.agentId,
    artifactId: j.artifactId,
    kind: j.kind,
    status: j.status,
    reason: j.reason ?? null,
    details: j.details ?? null,
    createdAt: j.createdAt,
    resolvedAt: j.resolvedAt ?? null,
  };
}

function jobFromRow(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    agentId: r.agentId as string,
    artifactId: r.artifactId as string,
    kind: r.kind as Job["kind"],
    status: r.status as Job["status"],
    reason: (r.reason as string | null) ?? undefined,
    details: (r.details as string | null) ?? undefined,
    createdAt: r.createdAt as string,
    resolvedAt: (r.resolvedAt as string | null) ?? undefined,
  };
}

