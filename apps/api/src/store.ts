/**
 * In-memory store for the v0 API. Swap to Postgres + pgvector when we ship.
 *
 * Keep the interface narrow on purpose — every method here is something we'll
 * have to translate to SQL later. If you're tempted to add a method that
 * loops through every record, it should probably be an index.
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
  createAgent(agent: Agent): void;
  getAgent(id: string): Agent | undefined;
  getAgentByTokenHash(tokenHash: string): Agent | undefined;
  updateAgent(id: string, patch: Partial<Agent>): Agent | undefined;

  // artifacts
  createArtifact(a: Artifact): void;
  getArtifact(id: string): Artifact | undefined;
  updateArtifact(id: string, patch: Partial<Artifact>): Artifact | undefined;
  /** all artifacts; v0 search filters in memory */
  allArtifacts(): Artifact[];
  /** corpus used for dedup — title + summary + payload only */
  corpusForDedup(): Pick<Artifact, "id" | "title" | "summary" | "payload">[];

  // jobs
  createJob(job: Job): void;
  getJob(id: string): Job | undefined;
  updateJob(id: string, patch: Partial<Job>): Job | undefined;
  allJobs(filter?: { kind?: Job["kind"]; status?: Job["status"] }): Job[];

  // outcomes
  appendOutcome(artifactId: string, outcome: Outcome): void;

  // credit ledger
  appendLedger(entry: CreditLedgerEntry): void;
  ledgerForAgent(agentId: string): CreditLedgerEntry[];
}

export function createMemoryStore(): Store {
  const agents = new Map<string, Agent>();
  const agentsByToken = new Map<string, string>(); // tokenHash → agentId
  const artifacts = new Map<string, Artifact>();
  const jobs = new Map<string, Job>();
  const ledger: CreditLedgerEntry[] = [];

  return {
    createAgent(agent) {
      agents.set(agent.id, agent);
      agentsByToken.set(agent.tokenHash, agent.id);
    },
    getAgent(id) {
      return agents.get(id);
    },
    getAgentByTokenHash(tokenHash) {
      const id = agentsByToken.get(tokenHash);
      return id ? agents.get(id) : undefined;
    },
    updateAgent(id, patch) {
      const cur = agents.get(id);
      if (!cur) return undefined;
      // if token hash changes (rotation), update the index
      if (patch.tokenHash && patch.tokenHash !== cur.tokenHash) {
        agentsByToken.delete(cur.tokenHash);
        agentsByToken.set(patch.tokenHash, id);
      }
      const next = { ...cur, ...patch };
      agents.set(id, next);
      return next;
    },

    createArtifact(a) {
      artifacts.set(a.id, a);
    },
    getArtifact(id) {
      return artifacts.get(id);
    },
    updateArtifact(id, patch) {
      const cur = artifacts.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      artifacts.set(id, next);
      return next;
    },
    allArtifacts() {
      return Array.from(artifacts.values());
    },
    corpusForDedup() {
      return Array.from(artifacts.values()).map((a) => ({
        id: a.id,
        title: a.title,
        summary: a.summary,
        payload: a.payload,
      }));
    },

    createJob(job) {
      jobs.set(job.id, job);
    },
    getJob(id) {
      return jobs.get(id);
    },
    updateJob(id, patch) {
      const cur = jobs.get(id);
      if (!cur) return undefined;
      const next = { ...cur, ...patch };
      jobs.set(id, next);
      return next;
    },
    allJobs(filter) {
      let xs = Array.from(jobs.values());
      if (filter?.kind) xs = xs.filter((j) => j.kind === filter.kind);
      if (filter?.status) xs = xs.filter((j) => j.status === filter.status);
      return xs;
    },

    appendOutcome(artifactId, outcome) {
      const a = artifacts.get(artifactId);
      if (!a) return;
      artifacts.set(artifactId, {
        ...a,
        outcomes: [...a.outcomes, outcome],
      });
    },

    appendLedger(entry) {
      ledger.push(entry);
    },
    ledgerForAgent(agentId) {
      return ledger.filter((e) => e.agentId === agentId);
    },
  };
}
