/**
 * Nbyula Investor Portal — Cloudflare Worker (two-tier auth + GitHub commits)
 *
 * Endpoints (all JSON, all CORS):
 *   POST /api/auth      → { password } → { role:"editor", token, expiresAt } | { role:"viewer" } | 401
 *   POST /api/snapshot  → { token }    → { state, sha }              (editor only)
 *   POST /api/commit    → { token, state, message? } → { ok:true,... } (editor only)
 *   GET  /api/health    → { ok:true }
 *
 * Secrets (Cloudflare dashboard → Workers → Settings → Variables & Secrets):
 *   EDITOR_PASSWORD   — plaintext editor passphrase (unlocks live editing)
 *   VIEWER_PASSWORD   — plaintext read-only passphrase (also = snapshot AES password)
 *   JWT_SECRET        — any 32+ char random string; signs editor tokens
 *   GITHUB_TOKEN      — fine-grained PAT, "Contents: Read & Write" on the repo
 *   GITHUB_REPO       — "ankitk-wq/nbyula-investor-portal"
 *   ALLOWED_ORIGIN    — e.g. "https://ankitk-wq.github.io" (comma-sep for multiple)
 *
 * Crypto stays byte-compatible with publish/publish.sh and the browser runtime:
 *   AES-256-CBC, PBKDF2-HMAC-SHA256, 100000 iters, openssl "Salted__" framing.
 *
 * Single self-contained file — paste into the Cloudflare dashboard editor.
 */

const SECONDS_24H = 24 * 3600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    try {
      if (url.pathname === "/api/auth"     && request.method === "POST") return await handleAuth(request, env, cors);
      if (url.pathname === "/api/snapshot" && request.method === "POST") return await handleSnapshot(request, env, cors);
      if (url.pathname === "/api/commit"   && request.method === "POST") return await handleCommit(request, env, cors);
      if (url.pathname === "/api/health"   && request.method === "GET")  return json({ ok: true, ts: Date.now() }, 200, cors);
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      console.error("[worker] unhandled:", e && e.message ? e.message : String(e));
      return json({ error: e && e.message ? e.message : String(e) }, 500, cors);
    }
  }
};

/* ---------- CORS ---------- */
function corsHeaders(env, request) {
  const allow = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get("Origin") || "";
  const ok = allow.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : (allow[0] || "*"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}

/* ---------- base64 ---------- */
function b64urlEncode(bytes) {
  let s = ""; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}
function b64StdEncode(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function b64StdDecode(s) {
  const bin = atob(s.replace(/\s+/g, "")); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;
}

/* ---------- constant-time compare ---------- */
function constantTimeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* ---------- HMAC tokens ---------- */
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function signToken(env, payload) {
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(env.JWT_SECRET);
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(sigBuf))}`;
}
async function verifyToken(env, token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const key = await hmacKey(env.JWT_SECRET);
    const ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig), new TextEncoder().encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

/* ---------- /api/auth ---------- */
async function handleAuth(request, env, cors) {
  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad json" }, 400, cors); }
  const password = body && body.password;
  if (typeof password !== "string" || !password) return json({ error: "password required" }, 400, cors);
  if (constantTimeEq(password, env.EDITOR_PASSWORD || "")) {
    const exp = Math.floor(Date.now() / 1000) + SECONDS_24H;
    const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
    const token = await signToken(env, { role: "editor", exp, nonce });
    return json({ role: "editor", token, expiresAt: exp }, 200, cors);
  }
  if (constantTimeEq(password, env.VIEWER_PASSWORD || "")) return json({ role: "viewer" }, 200, cors);
  await new Promise(r => setTimeout(r, 250));
  return json({ error: "invalid password" }, 401, cors);
}

/* ---------- /api/snapshot ---------- */
async function handleSnapshot(request, env, cors) {
  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad json" }, 400, cors); }
  const payload = await verifyToken(env, body && body.token);
  if (!payload || payload.role !== "editor") return json({ error: "unauthorized" }, 401, cors);

  const gh = await ghGet(env, "docs/data/snapshot.enc");
  if (!gh.ok) return json({ error: `github fetch failed: ${gh.status}` }, 502, cors);
  let plaintext;
  try {
    const outerBytes = b64StdDecode((gh.content || "").replace(/\s+/g, ""));
    const innerB64 = new TextDecoder().decode(outerBytes);
    plaintext = await decryptOpenSSLPBKDF2(innerB64.replace(/\s+/g, ""), env.VIEWER_PASSWORD || "");
  } catch (e) {
    return json({ error: "snapshot decrypt failed — check VIEWER_PASSWORD matches publish/.publish-password", detail: e && e.message ? e.message : String(e) }, 500, cors);
  }
  let state; try { state = JSON.parse(plaintext); } catch (_) { return json({ error: "snapshot decrypted to invalid JSON" }, 500, cors); }
  return json({ state, sha: gh.sha }, 200, cors);
}

/* ---------- /api/commit ---------- */
async function handleCommit(request, env, cors) {
  let body; try { body = await request.json(); } catch (_) { return json({ error: "bad json" }, 400, cors); }
  const payload = await verifyToken(env, body && body.token);
  if (!payload || payload.role !== "editor") return json({ error: "unauthorized" }, 401, cors);

  const state = body && body.state;
  if (typeof state !== "object" || state === null) return json({ error: "state required" }, 400, cors);

  const plaintext = JSON.stringify(state);
  const innerB64 = await encryptOpenSSLPBKDF2(plaintext, env.VIEWER_PASSWORD || "");
  const fileBytes = new TextEncoder().encode(innerB64);
  const ghContent = b64StdEncode(fileBytes);

  const [existingEnc, existingMeta] = await Promise.all([
    ghGet(env, "docs/data/snapshot.enc"),
    ghGet(env, "docs/data/snapshot.meta.json"),
  ]);
  const encSha = existingEnc.ok ? existingEnc.sha : undefined;
  const metaSha = existingMeta.ok ? existingMeta.sha : undefined;

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const digestBuf = await crypto.subtle.digest("SHA-256", fileBytes);
  const hex = Array.from(new Uint8Array(digestBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  const meta = { publishedAt: now, snapshotSha256Prefix: hex.slice(0, 12), snapshotBytes: fileBytes.length, via: "cloudflare-worker" };
  const metaContent = b64StdEncode(new TextEncoder().encode(JSON.stringify(meta, null, 2) + "\n"));

  const msg = (body.message && String(body.message).trim()) ? String(body.message).trim() : `publish: snapshot ${now} (sha=${meta.snapshotSha256Prefix})`;

  const r1 = await ghPut(env, "docs/data/snapshot.enc", ghContent, msg, encSha);
  if (!r1.ok) return json({ error: "commit snapshot.enc failed", status: r1.status, body: r1.body }, 502, cors);
  const r2 = await ghPut(env, "docs/data/snapshot.meta.json", metaContent, msg + " (meta)", metaSha);
  if (!r2.ok) return json({ error: "commit meta failed", status: r2.status, body: r2.body }, 502, cors);

  return json({ ok: true, publishedAt: now, sha: meta.snapshotSha256Prefix, bytes: meta.snapshotBytes }, 200, cors);
}

/* ---------- GitHub Contents API ---------- */
async function ghGet(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}?ref=main`;
  const r = await fetch(url, {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "nbyula-investor-portal-worker",
      "X-GitHub-Api-Version": "2022-11-28",
    }
  });
  if (!r.ok) { console.error(`[ghGet] ${path} → HTTP ${r.status}`); return { ok: false, status: r.status }; }
  const j = await r.json();
  let content = (j.content || "").replace(/\s+/g, "");
  if (!content && j.download_url) {
    const raw = await fetch(j.download_url, { headers: { "Authorization": `Bearer ${env.GITHUB_TOKEN}` } });
    if (!raw.ok) return { ok: false, status: raw.status };
    content = b64StdEncode(new Uint8Array(await raw.arrayBuffer()));
  }
  return { ok: true, sha: j.sha, content };
}
async function ghPut(env, path, contentB64, message, sha) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${encodeURI(path)}`;
  const body = { message, content: contentB64, branch: "main" };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "nbyula-investor-portal-worker",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, body: text };
}

/* ---------- AES-256-CBC + PBKDF2 (openssl-compatible, 100k) ---------- */
async function deriveKeyIv(password, salt) {
  const passKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, passKey, 48 * 8);
  return { key: new Uint8Array(bits, 0, 32), iv: new Uint8Array(bits, 32, 16) };
}
async function encryptOpenSSLPBKDF2(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const { key, iv } = await deriveKeyIv(password, salt);
  const aesKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, new TextEncoder().encode(plaintext));
  const ctBytes = new Uint8Array(ct);
  const out = new Uint8Array(16 + ctBytes.length);
  out.set(new TextEncoder().encode("Salted__"), 0);
  out.set(salt, 8);
  out.set(ctBytes, 16);
  return b64StdEncode(out);
}
async function decryptOpenSSLPBKDF2(b64, password) {
  const bytes = b64StdDecode(b64);
  if (bytes.length < 16) throw new Error("ciphertext too short");
  if (String.fromCharCode.apply(null, bytes.slice(0, 8)) !== "Salted__") throw new Error("missing Salted__ header");
  const salt = bytes.slice(8, 16);
  const ct = bytes.slice(16);
  const { key, iv } = await deriveKeyIv(password, salt);
  const aesKey = await crypto.subtle.importKey("raw", key, { name: "AES-CBC" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ct);
  return new TextDecoder().decode(plain);
}
