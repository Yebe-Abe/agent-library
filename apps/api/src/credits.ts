/**
 * Credit ledger operations. Every change to an agent's balance must go through
 * here so we have an audit trail (and so the future Postgres migration is one
 * function to rewrite, not a dozen).
 */

import { ulid } from "ulid";
import type { CreditLedgerEntry } from "@commons/schema";
import type { Store } from "./store.js";

export async function credit(
  store: Store,
  agentId: string,
  delta: number,
  reason: CreditLedgerEntry["reason"],
  artifactId?: string,
): Promise<{ newBalance: number } | { error: string }> {
  const agent = await store.getAgent(agentId);
  if (!agent) return { error: "agent_not_found" };

  const next = agent.credits + delta;
  if (next < 0) {
    return { error: "insufficient_credits" };
  }

  await store.updateAgent(agentId, { credits: next });
  await store.appendLedger({
    id: ulid(),
    agentId,
    delta,
    reason,
    artifactId,
    ts: new Date().toISOString(),
  });
  return { newBalance: next };
}
