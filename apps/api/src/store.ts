/**
 * Store interface — async because Postgres is async, and the in-memory impl
 * trivially wraps in Promise.resolve(). Two implementations:
 *   - createMemoryStore()   — fast, for tests + local dev sans DB
 *   - createPostgresStore() — the production path (see ./db/postgres-store.ts)
 *
 * Both implement this interface. Callers should never care which is in use.
 */

import type {
  Agent,
  Artifact,
  CreditLedgerEntry,
  Job,
  Outcome,
} from "@commons/schema";

export interface Store {
  // agents
  createAgent(agent: Agent): Promise<void>;
  getAgent(id: string): Promise<Agent | undefined>;
  getAgentByTokenHash(tokenHash: string): Promise<Agent | undefined>;
  updateAgent(id: string, patch: Partial<Agent>): Promise<Agent | undefined>;

  // artifacts
  createArtifact(a: Artifact): Promise<void>;
  getArtifact(id: string): Promise<Artifact | undefined>;
  updateArtifact(id: string, patch: Partial<Artifact>): Promise<Artifact | undefined>;
  allArtifacts(): Promise<Artifact[]>;
  corpusForDedup(): Promise<Pick<Artifact, "id" | "title" | "summary" | "payload">[]>;

  // jobs
  createJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | undefined>;
  updateJob(id: string, patch: Partial<Job>): Promise<Job | undefined>;
  allJobs(filter?: { kind?: Job["kind"]; status?: Job["status"] }): Promise<Job[]>;

  // outcomes
  appendOutcome(artifactId: string, outcome: Outcome): Promise<void>;

  // credit ledger
  appendLedger(entry: CreditLedgerEntry): Promise<void>;
  ledgerForAgent(agentId: string): Promise<CreditLedgerEntry[]>;
}

export function createMemoryStore(): Store {
  const agents = new Map<string, Agent>();
  const agentsByToken = new Map<string, string>(); // tokenHash → agentId
  const artifacts = new Map<string, Artifact>();
  const jobs = new Map<string, Job>();
  const ledger: CreditLedgerEntry[] = [];

  return {
    async createAgent(agent) {
      agents.set(agent.id, agent);
      agentsByToken.set(agent.tokenHash, agent.id);
    },
    async getAgent(id) {
      return agents.get(id);
    },
    async getAgentByTokenHash(tokenHash) {
      const id = agentsByToken.get(tokenHash);
      return id ? agents.get(id) : undefined;
    },
    async updateAgent(id, patch) {
      const cur = agents.get(id);
      if (!cur) return undefined;
      if (patch.tokenHash && patch.tokenHash !== cur.tokenHash) {
        agentsByToken.delete(cur.tokenHash);
        agentsByToken.set(patch.tokenHash, id);
      }
      const next = { ...cur, ...patch };
      agents.set(id, next);
      return next;
    },

    async createArtifact(a) {
      artifacts.set(a.id, a);
    },
    async getArtifact(id) {
      return artifacts.get(id);
    },
    async updateArtifact(id, patch) {
      const cur = artifacts.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      artifacts.set(id, next);
      return next;
    },
    async allArtifacts() {
      return Array.from(artifacts.values());
    },
    async corpusForDedup() {
      return Array.from(artifacts.values()).map((a) => ({
        id: a.id,
        title: a.title,
        summary: a.summary,
        payload: a.payload,
      }));
    },

    async createJob(job) {
      jobs.set(job.id, job);
    },
    async getJob(id) {
      return jobs.get(id);
    },
    async updateJob(id, patch) {
      const cur = jobs.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      jobs.set(id, next);
      return next;
    },
    async allJobs(filter) {
      let xs = Array.from(jobs.values());
      if (filter?.kind) xs = xs.filter((j) => j.kind === filter.kind);
      if (filter?.status) xs = xs.filter((j) => j.status === filter.status);
      return xs;
    },

    async appendOutcome(artifactId, outcome) {
      const a = artifacts.get(artifactId);
      if (!a) return;
      artifacts.set(artifactId, {
        ...a,
        outcomes: [...a.outcomes, outcome],
      });
    },

    async appendLedger(entry) {
      ledger.push(entry);
    },
    async ledgerForAgent(agentId) {
      return ledger.filter((e) => e.agentId === agentId);
    },
  };
}
