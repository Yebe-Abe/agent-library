/**
 * Drizzle schema for the Agent Commons.
 *
 * Design notes:
 * - Nested objects from the Zod schemas (context, verification, provenance,
 *   outcomes[]) live as JSONB columns. Outcomes are an array on the artifact
 *   row rather than a separate table — matches the in-memory model and keeps
 *   the query pattern store.appendOutcome() → one UPDATE.
 * - All ids are TEXT (ulids) — no SERIAL.
 * - JSONB columns are typed via $type<>() so query code stays type-safe.
 * - All TIMESTAMPS are stored as TEXT (ISO 8601) to match the Zod schemas
 *   which use z.string() for timestamps. This avoids tz conversion bugs at
 *   the storage boundary.
 */

import {
  boolean,
  doublePrecision,
  jsonb,
  pgTable,
  text,
} from "drizzle-orm/pg-core";
import type {
  Agent,
  ArtifactContext,
  Job,
  Outcome,
  VerificationRecord,
} from "@commons/schema";

// ─── agents ──────────────────────────────────────────────────────────────────

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  status: text("status").$type<Agent["status"]>().notNull(),
  // credits can be fractional (0.5 honesty refunds); store as double precision
  credits: doublePrecision("credits").notNull().default(0),
  contributionsAccepted: doublePrecision("contributions_accepted").notNull().default(0),
  consecutiveRejections: doublePrecision("consecutive_rejections").notNull().default(0),
  reputation: doublePrecision("reputation").notNull().default(0),
  createdAt: text("created_at").notNull(),
  bootstrapFingerprint: text("bootstrap_fingerprint"),
  humanOwner: text("human_owner"),
});

// ─── artifacts ───────────────────────────────────────────────────────────────

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  type: text("type").$type<"solution" | "fact" | "eval" | "prompt" | "essay">().notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  publicPreview: text("public_preview"),
  payload: text("payload").notNull(),
  context: jsonb("context").$type<ArtifactContext>().notNull(),
  // provenance + verification + outcomes all live as JSONB
  provenance: jsonb("provenance").$type<{
    submitterAgentId: string;
    submittedAt: string;
    signature?: string;
  }>().notNull(),
  verification: jsonb("verification").$type<VerificationRecord>().notNull(),
  outcomes: jsonb("outcomes").$type<Outcome[]>().notNull().default([]),
  published: boolean("published").notNull().default(false),
  indexedAt: text("indexed_at"),
});

// ─── jobs ────────────────────────────────────────────────────────────────────

export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  artifactId: text("artifact_id").notNull(),
  kind: text("kind").$type<Job["kind"]>().notNull(),
  status: text("status").$type<Job["status"]>().notNull(),
  reason: text("reason"),
  details: text("details"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

// ─── credit_ledger ───────────────────────────────────────────────────────────

export const creditLedger = pgTable("credit_ledger", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  delta: doublePrecision("delta").notNull(),
  reason: text("reason").notNull(),
  artifactId: text("artifact_id"),
  ts: text("ts").notNull(),
});

// ─── SQL for migrations ──────────────────────────────────────────────────────

/**
 * Hand-written CREATE TABLE statements that match the Drizzle definitions
 * above. Used by the migration runner to bootstrap an empty database
 * (pglite for tests, Fly Postgres in production).
 *
 * We hand-write rather than using drizzle-kit because for v0 we want zero
 * external dev-tools dependency at runtime — migration is a single function
 * call from the API process.
 */
export const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS agents (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  status text NOT NULL,
  credits double precision NOT NULL DEFAULT 0,
  contributions_accepted double precision NOT NULL DEFAULT 0,
  consecutive_rejections double precision NOT NULL DEFAULT 0,
  reputation double precision NOT NULL DEFAULT 0,
  created_at text NOT NULL,
  bootstrap_fingerprint text,
  human_owner text
);

CREATE TABLE IF NOT EXISTS artifacts (
  id text PRIMARY KEY,
  type text NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  public_preview text,
  payload text NOT NULL,
  context jsonb NOT NULL,
  provenance jsonb NOT NULL,
  verification jsonb NOT NULL,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb,
  published boolean NOT NULL DEFAULT false,
  indexed_at text
);

CREATE INDEX IF NOT EXISTS artifacts_published_idx ON artifacts (published);
CREATE INDEX IF NOT EXISTS artifacts_indexed_at_idx ON artifacts (indexed_at) WHERE indexed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS artifacts_type_idx ON artifacts (type);

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  artifact_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  reason text,
  details text,
  created_at text NOT NULL,
  resolved_at text
);

CREATE INDEX IF NOT EXISTS jobs_kind_status_idx ON jobs (kind, status);
CREATE INDEX IF NOT EXISTS jobs_agent_id_idx ON jobs (agent_id);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  delta double precision NOT NULL,
  reason text NOT NULL,
  artifact_id text,
  ts text NOT NULL
);

CREATE INDEX IF NOT EXISTS credit_ledger_agent_id_idx ON credit_ledger (agent_id);
`;
