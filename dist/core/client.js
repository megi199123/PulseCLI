// ============================================================
// PulseCLI — src/core/client.ts
// HTTP client with cookie-jar persistence.
// Uses Node built-in fetch, FormData, Blob, File — NO extra deps.
// ============================================================
import fs from "fs";
import path from "path";
import { saveConfig } from "./config.js";
// ---- Error type ----
export class PulseApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "PulseApiError";
    }
}
// ---- PulseClient ----
export class PulseClient {
    config;
    shouldPersist;
    /**
     * @param config  the resolved config (baseUrl may be a per-invocation override)
     * @param opts.persist  when false, cookies/user are NOT written to disk.
     *   Pass false whenever `--base` overrides the stored baseUrl, so an ephemeral
     *   target never clobbers the saved URL or mixes cross-server session cookies.
     */
    constructor(config, opts = {}) {
        // Work with a mutable copy so we can update cookies in place
        this.config = { ...config, cookies: { ...config.cookies } };
        this.shouldPersist = opts.persist ?? true;
    }
    get baseUrl() {
        return this.config.baseUrl;
    }
    // ---- Cookie jar helpers ----
    cookieHeader() {
        return Object.entries(this.config.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join("; ");
    }
    /**
     * Apply the cookie header and, when configured, an `Authorization: Bearer`
     * header to a Headers instance. Bearer is sent IN ADDITION TO the cookie
     * header (never instead of it) so a cookie-only Pulse keeps working.
     */
    applyAuthHeaders(headers) {
        const cookieVal = this.cookieHeader();
        if (cookieVal)
            headers.set("Cookie", cookieVal);
        if (this.config.token) {
            headers.set("Authorization", `Bearer ${this.config.token}`);
        }
    }
    mergeSetCookies(res) {
        // getSetCookie() is available in Node 18.14+ / v22
        const setCookies = res.headers.getSetCookie
            ? res.headers.getSetCookie()
            : [];
        for (const raw of setCookies) {
            // Format: "name=value; Path=/; HttpOnly; ..."
            const firstPart = raw.split(";")[0] ?? "";
            const eqIdx = firstPart.indexOf("=");
            if (eqIdx === -1)
                continue;
            const name = firstPart.slice(0, eqIdx).trim();
            const value = firstPart.slice(eqIdx + 1).trim();
            if (name) {
                this.config.cookies[name] = value;
            }
        }
    }
    persist() {
        if (!this.shouldPersist)
            return;
        saveConfig(this.config);
    }
    /**
     * Persist the current cookie jar + the authenticated user to disk.
     * Honors the persist flag (no-op under a `--base` override). The cookie jar
     * has already been updated in-place by prior requests, so this writes the
     * stored baseUrl + current cookies + user together.
     */
    saveSession(user) {
        if (!this.shouldPersist)
            return;
        this.config.user = user;
        saveConfig(this.config);
    }
    // ---- Raw fetch that participates in the cookie jar ----
    // Used by auth-flow for non-JSON calls (csrf, credentials POST).
    async rawFetch(urlOrPath, init = {}) {
        const url = urlOrPath.startsWith("http")
            ? urlOrPath
            : `${this.config.baseUrl}${urlOrPath}`;
        const headers = new Headers(init.headers);
        this.applyAuthHeaders(headers);
        const res = await fetch(url, { ...init, headers });
        this.mergeSetCookies(res);
        this.persist();
        return res;
    }
    // ---- Core request method ----
    async request(method, apiPath, opts = {}) {
        let url = `${this.config.baseUrl}${apiPath}`;
        // Build query string, skipping undefined/null; booleans → "1"
        if (opts.query) {
            const params = new URLSearchParams();
            for (const [key, val] of Object.entries(opts.query)) {
                if (val === undefined || val === null)
                    continue;
                if (typeof val === "boolean") {
                    if (val)
                        params.set(key, "1");
                }
                else {
                    params.set(key, String(val));
                }
            }
            const qs = params.toString();
            if (qs)
                url += `?${qs}`;
        }
        const headers = new Headers();
        this.applyAuthHeaders(headers);
        let body;
        if (opts.jsonBody !== undefined) {
            headers.set("Content-Type", "application/json");
            body = JSON.stringify(opts.jsonBody);
        }
        const res = await fetch(url, { method, headers, body });
        this.mergeSetCookies(res);
        this.persist();
        if (!res.ok) {
            if (res.status === 401) {
                throw new PulseApiError(401, this.config.token
                    ? "Unauthorized — PULSE_TOKEN is invalid, revoked, or expired"
                    : "Not logged in — run `pulse login`");
            }
            let message = res.statusText;
            try {
                const errBody = (await res.json());
                if (typeof errBody.error === "string")
                    message = errBody.error;
            }
            catch {
                // ignore parse errors
            }
            throw new PulseApiError(res.status, message);
        }
        // Handle empty body (e.g. 204 No Content)
        const text = await res.text();
        if (!text)
            return undefined;
        return JSON.parse(text);
    }
    // ---- Convenience wrappers ----
    get(apiPath, query) {
        return this.request("GET", apiPath, { query });
    }
    post(apiPath, jsonBody, query) {
        return this.request("POST", apiPath, { jsonBody, query });
    }
    put(apiPath, jsonBody) {
        return this.request("PUT", apiPath, { jsonBody });
    }
    del(apiPath) {
        return this.request("DELETE", apiPath);
    }
    // ---- File upload (multipart/form-data) ----
    async uploadFile(apiPath, filePath, fields) {
        const buf = fs.readFileSync(filePath);
        const basename = path.basename(filePath);
        const mimeType = guessMimeType(basename);
        const form = new FormData();
        // Use File so the filename is included in the multipart headers
        form.append("file", new File([buf], basename, { type: mimeType }));
        for (const [k, v] of Object.entries(fields)) {
            form.append(k, v);
        }
        const url = `${this.config.baseUrl}${apiPath}`;
        const headers = new Headers();
        this.applyAuthHeaders(headers);
        // Do NOT set Content-Type manually — let fetch set multipart boundary
        const res = await fetch(url, { method: "POST", headers, body: form });
        this.mergeSetCookies(res);
        this.persist();
        if (!res.ok) {
            if (res.status === 401) {
                throw new PulseApiError(401, this.config.token
                    ? "Unauthorized — PULSE_TOKEN is invalid, revoked, or expired"
                    : "Not logged in — run `pulse login`");
            }
            let message = res.statusText;
            try {
                const errBody = (await res.json());
                if (typeof errBody.error === "string")
                    message = errBody.error;
            }
            catch {
                // ignore
            }
            throw new PulseApiError(res.status, message);
        }
        const text = await res.text();
        if (!text)
            return undefined;
        return JSON.parse(text);
    }
    // ---- File download ----
    async downloadFile(apiPath, destPath) {
        const url = `${this.config.baseUrl}${apiPath}`;
        const headers = new Headers();
        this.applyAuthHeaders(headers);
        const res = await fetch(url, { headers });
        this.mergeSetCookies(res);
        if (!res.ok) {
            if (res.status === 401) {
                throw new PulseApiError(401, this.config.token
                    ? "Unauthorized — PULSE_TOKEN is invalid, revoked, or expired"
                    : "Not logged in — run `pulse login`");
            }
            throw new PulseApiError(res.status, res.statusText);
        }
        // Parse Content-Disposition for filename
        let filename = path.basename(destPath);
        const cd = res.headers.get("content-disposition") ?? "";
        const fnMatch = cd.match(/filename\*=UTF-8''([^;]+)/i) ??
            cd.match(/filename="([^"]+)"/i) ??
            cd.match(/filename=([^;]+)/i);
        if (fnMatch?.[1]) {
            filename = decodeURIComponent(fnMatch[1].trim());
        }
        const arrayBuf = await res.arrayBuffer();
        fs.writeFileSync(destPath, Buffer.from(arrayBuf));
        return { filename };
    }
}
// ---- Internal helpers ----
function guessMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const map = {
        ".txt": "text/plain",
        ".log": "text/plain",
        ".ps1": "text/plain",
        ".py": "text/x-python",
        ".sql": "application/sql",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".zip": "application/zip",
        ".rar": "application/x-rar-compressed",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".svg": "image/svg+xml",
    };
    return map[ext] ?? "application/octet-stream";
}
