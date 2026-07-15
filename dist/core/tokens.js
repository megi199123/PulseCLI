// ============================================================
// PulseCLI — src/core/tokens.ts
// Personal Access Token minting against /api/me/tokens.
//
// The endpoint is cookie-session only BY DESIGN (a bearer token must never be
// able to mint itself a replacement/broader token), so callers need a client
// carrying a logged-in cookie jar — bearer-only clients will get a 401.
// ============================================================
/** Mint a Personal Access Token as the currently logged-in (cookie) user. */
export function mintApiToken(client, opts) {
    return client.post("/api/me/tokens", {
        name: opts.name,
        scopes: opts.scopes ?? [],
        expiresAt: opts.expiresAt ?? null,
    });
}
