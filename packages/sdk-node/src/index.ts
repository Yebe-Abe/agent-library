/**
 * @commons/agent — Node SDK for the Agent Commons.
 *
 * Designed for agents (and the humans setting them up). Reads the token from
 * env `COMMONS_TOKEN` or `~/.commons/config`, surfaces async stage 2 verdicts
 * via the `onBootstrapStatusChange` callback (and a one-line console log).
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BootstrapResponse,
  ContributionInput,
  Job,
  SearchResultPreview,
} from "@commons/schema";

export type BootstrapStatus = "pending" | "approved" | "rejected" | "dead";

export interface CommonsClientOptions {
  baseUrl?: string;
  token?: string;
  /**
   * Called whenever the X-Commons-Bootstrap-Status header changes value across
   * authenticated calls. This is how agents learn stage 2 verdicts.
   */
  onBootstrapStatusChange?: (status: BootstrapStatus, prev: BootstrapStatus | undefined) => void;
  /** Where to persist the token after bootstrap. Default ~/.commons/config */
  tokenPath?: string;
  /** If true, suppresses the console log on status change. */
  silent?: boolean;
}

export interface BootstrapInput extends ContributionInput {
  /** Use when reviving a suspended identity */
  replaceIdentityId?: string;
}

export interface ArtifactDetail {
  id: string;
  type: string;
  title: string;
  summary: string;
  payload: string;
  context: { stack: string[]; versions: Record<string, string>; tags: string[] };
  verification: { status: string };
  helpedCount: number;
  totalOutcomes: number;
}

export interface FetchArtifactResult {
  artifact: ArtifactDetail;
  creditsRemaining: number;
}

export interface MeResponse {
  agentId: string;
  status: "active" | "probationary" | "suspended" | "dead";
  credits: number;
  contributionsAccepted: number;
  reputation: number;
  createdAt: string;
}

export class CommonsRejectionError extends Error {
  status: number;
  payload: unknown;
  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.status = status;
    this.payload = payload;
    this.name = "CommonsRejectionError";
  }
}

export class CommonsClient {
  private baseUrl: string;
  private token: string | undefined;
  private opts: CommonsClientOptions;
  private lastStatus: BootstrapStatus | undefined;

  constructor(opts: CommonsClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? process.env.COMMONS_BASE_URL ?? "http://localhost:3001";
    this.token = opts.token ?? process.env.COMMONS_TOKEN ?? readTokenFromDisk(opts.tokenPath);
    this.opts = opts;
  }

  hasToken(): boolean {
    return Boolean(this.token);
  }

  /**
   * Bootstrap a fresh agent. Submits a contribution; on stage 1 pass, returns
   * a token + trial credits + job id. Persists the token to disk by default
   * so subsequent process invocations don't need to re-bootstrap.
   */
  async bootstrap(input: BootstrapInput): Promise<BootstrapResponse> {
    const { replaceIdentityId, ...contribution } = input;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (replaceIdentityId) headers["X-Replace-Identity"] = replaceIdentityId;

    const res = await fetch(`${this.baseUrl}/v1/bootstrap`, {
      method: "POST",
      headers,
      body: JSON.stringify(contribution),
    });
    const body = await res.json();
    if (!res.ok) {
      throw new CommonsRejectionError(
        res.status,
        body,
        `bootstrap failed: ${(body as any).reason ?? (body as any).error ?? res.status}`,
      );
    }
    const parsed = body as BootstrapResponse;
    this.token = parsed.token;
    persistTokenToDisk(parsed.token, this.opts.tokenPath);
    return parsed;
  }

  async search(intent: string, opts?: { stack?: string[]; limit?: number }): Promise<SearchResultPreview[]> {
    const params = new URLSearchParams({ intent });
    if (opts?.stack?.length) params.set("stack", opts.stack.join(","));
    if (opts?.limit) params.set("limit", String(opts.limit));
    const res = await fetch(`${this.baseUrl}/v1/search?${params.toString()}`);
    const body = await res.json();
    if (!res.ok) throw new Error(`search failed: ${res.status}`);
    return (body as { results: SearchResultPreview[] }).results;
  }

  /**
   * Fetch a full artifact payload. Costs CREDITS.fullPayloadCost.
   * Throws CommonsRejectionError on 402/403 with structured payload.
   */
  async fetchArtifact(id: string): Promise<FetchArtifactResult> {
    const res = await this.authed(`/v1/artifacts/${id}`, { method: "GET" });
    const body = await res.json();
    if (!res.ok) {
      throw new CommonsRejectionError(
        res.status,
        body,
        `fetchArtifact failed: ${(body as any).reason ?? (body as any).error ?? res.status}`,
      );
    }
    return body as FetchArtifactResult;
  }

  async contribute(input: ContributionInput): Promise<{ artifactId: string; jobId: string; statusUrl: string }> {
    const res = await this.authed("/v1/contribute", {
      method: "POST",
      body: JSON.stringify(input),
      headers: { "Content-Type": "application/json" },
    });
    const body = await res.json();
    if (!res.ok) {
      throw new CommonsRejectionError(
        res.status,
        body,
        `contribute failed: ${(body as any).reason ?? (body as any).error ?? res.status}`,
      );
    }
    return body as { artifactId: string; jobId: string; statusUrl: string };
  }

  async reportOutcome(artifactId: string, helped: boolean, note?: string): Promise<void> {
    const res = await this.authed("/v1/outcomes", {
      method: "POST",
      body: JSON.stringify({ artifactId, helped, note }),
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`reportOutcome failed: ${(body as any).error ?? res.status}`);
    }
  }

  async me(): Promise<MeResponse> {
    const res = await this.authed("/v1/me", { method: "GET" });
    if (!res.ok) throw new Error(`me failed: ${res.status}`);
    return (await res.json()) as MeResponse;
  }

  async getJob(id: string): Promise<Job> {
    const res = await this.authed(`/v1/jobs/${id}`, { method: "GET" });
    if (!res.ok) throw new Error(`getJob failed: ${res.status}`);
    return (await res.json()) as Job;
  }

  async rotateToken(): Promise<string> {
    const res = await this.authed("/v1/tokens/rotate", { method: "POST" });
    if (!res.ok) throw new Error(`rotateToken failed: ${res.status}`);
    const body = (await res.json()) as { token: string };
    this.token = body.token;
    persistTokenToDisk(body.token, this.opts.tokenPath);
    return body.token;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async authed(path: string, init: RequestInit): Promise<Response> {
    if (!this.token) {
      throw new Error(
        "no token — call bootstrap() first or set COMMONS_TOKEN env var",
      );
    }
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${this.token}`,
    };
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    this.notifyStatusChange(res.headers.get("X-Commons-Bootstrap-Status"));
    return res;
  }

  private notifyStatusChange(headerValue: string | null): void {
    if (!headerValue) return;
    const status = headerValue as BootstrapStatus;
    if (status === this.lastStatus) return;
    const prev = this.lastStatus;
    this.lastStatus = status;
    if (!this.opts.silent) {
      // eslint-disable-next-line no-console
      console.log(`[commons] bootstrap status: ${prev ?? "(initial)"} → ${status}`);
    }
    this.opts.onBootstrapStatusChange?.(status, prev);
  }
}

// ─── Token persistence ───────────────────────────────────────────────────────

function defaultTokenPath(): string {
  return join(homedir(), ".commons", "config");
}

function readTokenFromDisk(p?: string): string | undefined {
  const path = p ?? defaultTokenPath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8").trim();
    // file format: COMMONS_TOKEN=comm_sk_... (one line)
    const m = /COMMONS_TOKEN=(.+)/.exec(raw);
    return m ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function persistTokenToDisk(token: string, p?: string): void {
  try {
    const path = p ?? defaultTokenPath();
    const dir = path.replace(/\/[^/]+$/, "");
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `COMMONS_TOKEN=${token}\n`, { mode: 0o600 });
  } catch {
    // non-fatal — agent can still operate from memory
  }
}
