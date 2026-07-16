// ============================================================
// PulseCLI — src/mcp-http/index.ts
// Stateless streamable-HTTP MCP gateway for remote clients (claude.ai custom
// connectors). Serves the EXACT SAME tools as the stdio server
// (src/mcp/tools.ts) but builds a fresh PulseClient + McpServer PER REQUEST
// from the caller's `Authorization: Bearer <pulse_pat_...>` header — no
// sessions, no disk config, no state shared between requests.
//
// Security invariants (do not weaken):
//   - The bearer token is forwarded ONLY to PULSE_BASE_URL, fixed at boot
//     from env — never derived from the incoming request.
//   - The token must NEVER appear in a log line. Every console.* call site
//     below logs only `method path -> status` (or the startup line) — none
//     may interpolate the Authorization header or the token variable.
//   - This file never reads Config from disk — the gateway is
//     disk-config-free by design (PulseClient is constructed with
//     `persist: false`).
//
// Auth is intentionally lazy: an invalid/garbage token still gets a normal
// `initialize` response (no Pulse call happens during handshake) — the
// first `tools/call` is what surfaces Pulse's 401 through the tool result.
// This avoids adding a verification round-trip to every connection.
// ============================================================
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PulseClient } from "../core/client.js";
import { registerTools } from "../mcp/tools.js";
// Mirrors package.json / src/cli/index.ts `.version(...)` / src/mcp/index.ts
// `SERVER_VERSION` (manual-sync convention — keep all four strings identical).
const SERVER_VERSION = "0.4.1";
const baseUrl = (process.env.PULSE_BASE_URL ?? "").replace(/\/+$/, "");
if (!baseUrl) {
    console.error("[pulse-mcp-gateway] PULSE_BASE_URL is required (e.g. https://pulse.example.com) — exiting.");
    process.exit(1);
}
const port = Number(process.env.PORT ?? 8788);
/** Requests larger than this are rejected with 413 before JSON.parse runs. */
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
class BadRequestError extends Error {
}
class PayloadTooLargeError extends Error {
}
/**
 * Collects a POST body, capping at MAX_BODY_BYTES. Empty body resolves to
 * `undefined`. Malformed JSON rejects with BadRequestError; oversize rejects
 * with PayloadTooLargeError — the caller turns both into a JSON-RPC error
 * response (400 / 413) without ever crashing the process.
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new PayloadTooLargeError("Request body exceeds 5 MB limit"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf-8");
            if (!raw) {
                resolve(undefined);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch {
                reject(new BadRequestError("Malformed JSON body"));
            }
        });
        req.on("error", reject);
    });
}
function sendJson(res, status, payload) {
    if (res.headersSent)
        return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}
function jsonRpcErrorBody(code, message) {
    return { jsonrpc: "2.0", error: { code, message }, id: null };
}
async function handleRequest(req, res) {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    try {
        if (method === "GET" && pathname === "/healthz") {
            sendJson(res, 200, { ok: true, name: "pulse-mcp-gateway", version: SERVER_VERSION });
            return;
        }
        if (pathname === "/mcp") {
            if (method !== "GET" && method !== "POST" && method !== "DELETE") {
                sendJson(res, 405, jsonRpcErrorBody(-32601, "Method not allowed"));
                return;
            }
            // Reject unless a well-formed bearer is present — never call Pulse
            // without one. Deliberately not logging the header value anywhere.
            const auth = req.headers.authorization;
            if (!auth || !/^Bearer .+/.test(auth)) {
                sendJson(res, 401, jsonRpcErrorBody(-32001, "Missing or invalid Authorization: Bearer token"));
                return;
            }
            const token = auth.slice("Bearer ".length).trim();
            let parsedBody;
            if (method === "POST") {
                try {
                    parsedBody = await readBody(req);
                }
                catch (err) {
                    if (err instanceof PayloadTooLargeError) {
                        sendJson(res, 413, jsonRpcErrorBody(-32001, "Request body too large"));
                    }
                    else {
                        sendJson(res, 400, jsonRpcErrorBody(-32700, "Malformed JSON body"));
                    }
                    return;
                }
            }
            // Fresh, isolated instances per request — no shared mutable state, no
            // disk config. `persist: false` guarantees this client never touches
            // ~/.pulse-cli or PULSE_CONFIG_DIR.
            const client = new PulseClient({ baseUrl, cookies: {}, token }, { persist: false });
            const mcp = new McpServer({ name: "pulse-mcp-gateway", version: SERVER_VERSION });
            registerTools(mcp, client);
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined, // stateless mode — no session tracking
                enableJsonResponse: true, // plain JSON for single-POST flows; SSE still negotiated when asked
            });
            res.on("close", () => {
                transport.close().catch(() => { });
                mcp.close().catch(() => { });
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res, parsedBody);
            return;
        }
        sendJson(res, 404, { error: "Not found" });
    }
    catch {
        // Never leak internals (which could echo request contents) — fixed,
        // generic message only.
        if (!res.headersSent) {
            sendJson(res, 500, jsonRpcErrorBody(-32000, "Internal server error"));
        }
    }
    finally {
        // The ONLY per-request log line: method, path, and final status. Never
        // the Authorization header, never the token.
        console.error(`[pulse-mcp-gateway] ${method} ${pathname} -> ${res.statusCode}`);
    }
}
const server = http.createServer((req, res) => {
    void handleRequest(req, res);
});
server.listen(port, () => {
    console.error(`[pulse-mcp-gateway] listening on :${port} -> ${baseUrl}`);
});
function shutdown(signal) {
    console.error(`[pulse-mcp-gateway] ${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Railway sends SIGTERM on redeploy; don't let a lingering SSE connection
    // block the process from exiting.
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
