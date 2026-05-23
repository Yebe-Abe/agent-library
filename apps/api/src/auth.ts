/**
 * Token utilities. Tokens are opaque secrets of the form `comm_sk_<random>`.
 * We store sha256(token) only; the raw token is shown once on bootstrap/rotate.
 */

import { createHash, randomBytes } from "node:crypto";

export function mintToken(): { token: string; tokenHash: string } {
  const token = `comm_sk_${randomBytes(24).toString("base64url")}`;
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function parseBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m ? m[1].trim() : null;
}
