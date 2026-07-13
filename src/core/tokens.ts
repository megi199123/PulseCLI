// ============================================================
// PulseCLI — src/core/tokens.ts
// Personal Access Token minting against /api/me/tokens.
//
// The endpoint is cookie-session only BY DESIGN (a bearer token must never be
// able to mint itself a replacement/broader token), so callers need a client
// carrying a logged-in cookie jar — bearer-only clients will get a 401.
// ============================================================

import { type PulseClient } from "./client.js";

/** Response shape of POST /api/me/tokens (201). */
export interface MintedApiToken {
  id: string;
  name: string;
  /** First characters of the raw token, for later identification in lists. */
  tokenPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  /**
   * The raw bearer token (`pulse_pat_…`). The server returns it exactly once,
   * at mint time — it is stored hashed and can never be recovered again.
   */
  token: string;
}

export interface MintTokenOptions {
  name: string;
  /**
   * Scopes to grant. May be empty for a read-only token. The server rejects
   * any scope the minting user does not currently hold (except token-only
   * scopes like CODE_REF_WRITE, which every user may grant).
   */
  scopes?: string[];
  /** ISO date string, or omit for a non-expiring token. */
  expiresAt?: string | null;
}

/** Mint a Personal Access Token as the currently logged-in (cookie) user. */
export function mintApiToken(
  client: PulseClient,
  opts: MintTokenOptions,
): Promise<MintedApiToken> {
  return client.post<MintedApiToken>("/api/me/tokens", {
    name: opts.name,
    scopes: opts.scopes ?? [],
    expiresAt: opts.expiresAt ?? null,
  });
}
