// ============================================================
// PulseCLI — src/auth-flow.ts
// NextAuth v4 CredentialsProvider login flow.
// Flow: GET /api/auth/csrf → POST /api/auth/callback/credentials → GET /api/auth/session
// ============================================================

import { type PulseClient } from "./client.js";
import type { SessionUser, CsrfResponse, SessionResponse } from "./types.js";

/**
 * Log in to Pulse using email + password.
 * Stores session cookies in ~/.pulse-cli/config.json.
 * Returns the authenticated user on success; throws on failure.
 *
 * Implementation notes:
 * - Uses client.rawFetch() so cookies are merged into the shared jar.
 * - NextAuth callback may return 200/302 on bad creds — source of truth is
 *   the /api/auth/session response. Do NOT rely on callback status code.
 */
export async function login(
  client: PulseClient,
  email: string,
  password: string,
): Promise<SessionUser> {
  const base = client.baseUrl;

  // Step 1: GET /api/auth/csrf — captures csrfToken + sets csrf cookie
  const csrfRes = await client.rawFetch("/api/auth/csrf");
  if (!csrfRes.ok) {
    throw new Error(
      `Failed to fetch CSRF token (HTTP ${csrfRes.status}). Is Pulse running at ${base}?`,
    );
  }
  const { csrfToken } = (await csrfRes.json()) as CsrfResponse;

  // Step 2: POST /api/auth/callback/credentials (form-encoded, redirect:manual)
  const callbackUrl = `${base}/`;
  const formBody = new URLSearchParams({
    csrfToken,
    email,
    password,
    callbackUrl,
    json: "true",
  });

  await client.rawFetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formBody.toString(),
    redirect: "manual",
  });
  // We deliberately ignore the response status (200 or 302 — NextAuth does not
  // reliably signal bad creds here). The session endpoint is the source of truth.

  // Step 3: Verify session — GET /api/auth/session
  const user = await getSession(client);
  if (!user) {
    throw new Error("Login failed — check email/password");
  }

  // Persist cookies + user together (honors the client's persist flag, so a
  // `--base` override stays ephemeral). Cookies were already merged into the
  // jar by rawFetch during the flow above.
  client.saveSession(user);

  return user;
}

/**
 * Fetch the current session.
 * Returns the authenticated user, or null if not logged in.
 */
export async function getSession(
  client: PulseClient,
): Promise<SessionUser | null> {
  const res = await client.rawFetch("/api/auth/session");
  if (!res.ok) return null;

  let body: SessionResponse;
  try {
    body = (await res.json()) as SessionResponse;
  } catch {
    return null;
  }

  if (!body.user) return null;

  const u = body.user;
  if (!u.id || !u.email) return null;

  return {
    id: String(u.id),
    name: String(u.name ?? ""),
    email: String(u.email),
    role: String(u.role ?? ""),
  };
}
