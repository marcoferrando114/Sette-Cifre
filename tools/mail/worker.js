// Pato mail (Cloudflare Worker "pato-mail"): one-tap Gmail for Pato friends.
// The app sends the friend to Google once (read-only Gmail). This worker keeps the Gmail key (encrypted), reads ONLY
// bank alert emails when the app asks, turns them into spending rows with Haiku and hands them back; the app saves them
// in the friend's own space. Email text is never stored here.
// Variables (Worker > Settings > Variables and Secrets): GOOGLE_ID (text), GOOGLE_SECRET (secret), ANTHROPIC_KEY (secret).
// KV binding LIMITS (shared with pato-ai, keys start with "gm:").
const PROJECT = "stakd-3d1b9";
const APP = "https://marcoferrando114.github.io/Sette-Cifre/";
const ORIGINS = ["https://marcoferrando114.github.io"];
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MODEL = "claude-haiku-5-5";
const PAGE = 25;            // emails per call (Cloudflare allows 50 outside calls per request)
const DAILY_CALLS = 80;     // sync calls per friend per day (protects the Anthropic credit)
// Bank senders in the Dominican Republic (Gmail matches these against the sender address and name)
const BANKS = ["bhd", "popularenlinea", "bpd.com.do", "banreservas", "scotiabank", "qik", "apap", "banesco", "lafise", "bsc.com.do",
  "promerica", "bancocaribe", "vimenca", "bdi.com.do", "bellbank", "ademi", "acap", "alaver", "bancamerica", "asociacioncibao", "blh.com.do"];
const Q = "from:(" + BANKS.join(" OR ") + ")";
const RATE = { DOP: 1, USD: 60, EUR: 73 };
const JWKS = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";
let jwks = null, jwksAt = 0;

const enc = new TextEncoder(), dec = new TextDecoder();
const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const b64 = u8 => btoa(String.fromCharCode(...u8));
const cors = origin => ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "POST, OPTIONS", "vary": "origin" } : {};
const json = (o, status, origin) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors(origin) } });
const redirectUri = req => new URL(req.url).origin + "/callback";

async function verify(token) {   // Firebase sign-in check (same as pato-ai)
  const [h, p, s] = String(token || "").split("."); if (!s) return null;
  const head = JSON.parse(dec.decode(b64u(h))), pay = JSON.parse(dec.decode(b64u(p)));
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== "RS256" || pay.aud !== PROJECT || pay.iss !== "https://securetoken.google.com/" + PROJECT || !pay.sub || pay.exp < now || pay.iat > now + 60) return null;
  if (!jwks || Date.now() - jwksAt > 3600e3) { jwks = (await (await fetch(JWKS)).json()).keys; jwksAt = Date.now(); }
  const jwk = jwks.find(k => k.kid === head.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return (await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), enc.encode(h + "." + p))) ? pay.sub : null;
}

// ---- Gmail key, encrypted at rest ----
async function aes(env) { return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("pato-mail:" + env.GOOGLE_SECRET)), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(env, o) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aes(env), enc.encode(JSON.stringify(o)))); return b64(iv) + "." + b64(ct); }
async function unseal(env, s) { if (!s) return null; try { const [iv, ct] = s.split(".").map(x => Uint8Array.from(atob(x), c => c.charCodeAt(0))); return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await aes(env), ct))); } catch (e) { return null; } }
const getTok = (env, uid) => env.LIMITS.get("gm:tok:" + uid).then(s => unseal(env, s));
const putTok = async (env, uid, t) => env.LIMITS.put("gm:tok:" + uid, await seal(env, t));

async function google(url, at) {
  const r = await fetch(url, { headers: { authorization: "Bearer " + at } });
  if (!r.ok) throw Object.assign(new Error("gmail " + r.status), { status: r.status });
  return r.json();
}
async function accessToken(env, rt) {
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_ID, client_secret: env.GOOGLE_SECRET, refresh_token: rt, grant_type: "refresh_token" }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw Object.assign(new Error("refresh"), { reconnect: j.error === "invalid_grant" || j.error === "unauthorized_client" });
  return j.access_token;
}

// ---- email text ----
const unb = s => { try { return dec.decode(b64u(s)); } catch (e) { return ""; } };
const strip = h => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|td|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/gi, " ");
function bodyText(p) {
  let plain = "", html = "";
  (function walk(x) { if (!x) return; const d = x.body && x.body.data;
    if (d && x.mimeType === "text/plain" && !plain) plain = unb(d); else if (d && x.mimeType === "text/html" && !html) html = unb(d);
    (x.parts || []).forEach(walk); })(p);
  return (plain || strip(html)).replace(/[ \t\r]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
const head = (m, n) => ((m.payload && m.payload.headers) || []).find(h => h.name.toLowerCase() === n)?.value || "";

async function readEmails(env, list) {
  const P = `These are emails from a person's banks in the Dominican Republic. Return one object for each email that is a card purchase, a cash withdrawal, or a transfer or payment the person SENT. Skip everything else: money received, verification codes, statements, balances, logins, marketing.
Answer with a JSON array only:
[{"id":"<email id>","kind":"consumo" (card purchase) | "retiro" (cash withdrawal) | "transfer" (sent),"date":"YYYY-MM-DD" (transaction date in the email),"merchant":"readable Title Case name; for transfers: Transfer to <name>","raw":"merchant or recipient text as written","amount":number,"currency":"DOP"|"USD"|"EUR","status":"Aprobada"|"Declinada","cat":"<key>"}]
Category keys: food (restaurants, cafés, fast food, delivery apps, supermarkets, colmados), gas (gas stations, parking, tolls, car wash, car repairs), sport (gyms, clubs, sports gear), out (bars, clubs, cinemas, events, hotels, flights, trips), subs (streaming, apps, software, memberships), rides (Uber, InDrive, taxis), health (pharmacies, doctors, labs, clinics), family (money sent to relatives), needs (government fees, utilities, insurance, repairs), shopping (clothes, shoes, electronics, gifts, video games, stores), fees (bank commissions and charges), cash (cash withdrawals), other (anything else or unclear).

Emails:
` + list.map(e => `--- id: ${e.id} | received: ${e.date} | from: ${e.from} | subject: ${e.subject}\n${e.text}`).join("\n");
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: P }] }) });
  if (!r.ok) throw new Error("ai " + r.status);
  const t = ((await r.json()).content || []).map(c => c.text || "").join("");
  const a = t.indexOf("["), b = t.lastIndexOf("]");
  let out = []; try { out = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error("ai json"); }
  const byId = Object.fromEntries(list.map(e => [e.id, e]));
  return out.filter(x => x && byId[x.id] && ["consumo", "retiro", "transfer"].includes(x.kind) && Number(x.amount) > 0).map(x => {
    const cur = RATE[x.currency] ? x.currency : "DOP", amt = Math.round(Number(x.amount) * 100) / 100;
    return { id: x.id, date: /^\d{4}-\d\d-\d\d$/.test(x.date) ? x.date : byId[x.id].date, merchant: String(x.merchant || x.raw || "Bank charge").slice(0, 80),
      raw: String(x.raw || "").slice(0, 120), amount: amt, currency: cur, rd: Math.round(amt * RATE[cur] * 100) / 100, kind: x.kind,
      status: x.status === "Declinada" ? "Declinada" : "Aprobada", cat: x.kind === "retiro" ? "cash" : String(x.cat || "other"), source: "gmail", excluded: false, ts: byId[x.id].ts };
  });
}

// One page of emails. The app saves the rows, then asks for the next page (so nothing is lost if the app closes midway).
async function sync(env, uid, body) {
  const t = await getTok(env, uid); if (!t) return { connected: false };
  const day = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10), ck = "gm:n:" + uid + ":" + day, n = Number(await env.LIMITS.get(ck)) || 0;
  if (n >= DAILY_CALLS) return { connected: true, email: t.email, items: [], next: null, limit: true };
  await env.LIMITS.put(ck, String(n + 1), { expirationTtl: 172800 });
  const rk = "gm:run:" + uid; let run = JSON.parse((await env.LIMITS.get(rk)) || "null");
  if (body.page === "END") {   // the app saved the last page: next time only newer emails
    if (run) { t.since = Math.max(run.max, run.pmax, t.since || 0); t.lastRunAt = Date.now(); await putTok(env, uid, t); await env.LIMITS.delete(rk); }
    return { connected: true, email: t.email, items: [], next: null, lastRunAt: t.lastRunAt };
  }
  if (run && body.page && body.page !== run.page) { run.max = Math.max(run.max, run.pmax); run.page = body.page; }
  if (!run) { const after = Math.max(0, (t.since || t.start) - 60); run = { q: Q + " after:" + after, page: "", max: after, pmax: after }; }
  let at; try { at = await accessToken(env, t.rt); }
  catch (e) { if (e.reconnect) { await env.LIMITS.delete("gm:tok:" + uid); await env.LIMITS.delete(rk); return { connected: false, reconnect: true }; } throw e; }
  const G = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  const l = await google(G + "?maxResults=" + PAGE + "&q=" + encodeURIComponent(run.q) + (run.page ? "&pageToken=" + encodeURIComponent(run.page) : ""), at);
  const ids = (l.messages || []).map(m => m.id);
  const msgs = await Promise.all(ids.map(id => google(G + "/" + id + "?format=full", at).catch(() => null)));
  const list = msgs.filter(Boolean).map(m => { const ts = Number(m.internalDate) || 0;
    return { id: m.id, ts, date: new Date(ts - 4 * 3600e3).toISOString().slice(0, 10), from: head(m, "from").slice(0, 80), subject: head(m, "subject").slice(0, 120),
      text: bodyText(m.payload).slice(0, 700) || String(m.snippet || "") }; });
  run.pmax = list.reduce((a, e) => Math.max(a, Math.floor(e.ts / 1000)), run.max);
  const items = list.length ? await readEmails(env, list) : [];
  await env.LIMITS.put(rk, JSON.stringify(run), { expirationTtl: 30 * 86400 });
  return { connected: true, email: t.email, items, read: list.length, next: l.nextPageToken || "END", first: !t.since, lastRunAt: t.lastRunAt || 0 };
}

const page = (title, line, ok) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pato</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f1e7;color:#1d2a22;font:16px -apple-system,system-ui,sans-serif;text-align:center;padding:24px}
@media (prefers-color-scheme:dark){body{background:#13201a;color:#f1ead9}}h1{font:600 1.6rem Georgia,serif;margin:12px 0 6px}p{opacity:.75;margin:0 0 22px}
a{display:inline-block;background:#1f5c3d;color:#fff;text-decoration:none;padding:13px 26px;border-radius:999px;font-weight:600}</style></head>
<body><div><div style="font-size:2.6rem">${ok ? "🦆" : "⚠️"}</div><h1>${title}</h1><p>${line}</p><a href="${APP}">Back to Pato</a></div></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "", url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (req.method === "GET" && url.pathname === "/callback") {   // Google sends the friend back here
      const st = url.searchParams.get("state") || "", s = st && JSON.parse((await env.LIMITS.get("gm:state:" + st)) || "null");
      if (!s) return page("Link expired", "Open Pato and tap Connect again.");
      await env.LIMITS.delete("gm:state:" + st);
      if (url.searchParams.get("error") || !url.searchParams.get("code")) return page("Not connected", "Nothing was shared. You can try again from Pato.");
      const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ code: url.searchParams.get("code"), client_id: env.GOOGLE_ID, client_secret: env.GOOGLE_SECRET, redirect_uri: redirectUri(req), grant_type: "authorization_code" }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.refresh_token) return page("Not connected", "Google didn’t finish. Try again from Pato.");
      if (!String(j.scope || "").includes(SCOPE)) return page("One more tap", "Tick the Gmail box on Google’s screen so Pato can see your bank emails.");
      let email = ""; try { email = (await google("https://gmail.googleapis.com/gmail/v1/users/me/profile", j.access_token)).emailAddress || ""; } catch (e) {}
      await putTok(env, s.uid, { rt: j.refresh_token, email, months: s.months, start: Math.floor(Date.now() / 1000) - s.months * 30 * 86400, since: 0, at: Date.now() });
      await env.LIMITS.delete("gm:run:" + s.uid);
      return page("Gmail connected", "Pato is reading your bank emails now.", true);
    }
    if (req.method !== "POST" || !ORIGINS.includes(origin)) return json({ error: "forbidden" }, 403, origin);
    if (!env.GOOGLE_ID || !env.GOOGLE_SECRET || !env.LIMITS) return json({ error: "not_set_up" }, 503, origin);
    const uid = await verify((req.headers.get("authorization") || "").replace(/^Bearer /, "")).catch(() => null);
    if (!uid) return json({ error: "sign_in" }, 401, origin);
    let body = {}; try { body = await req.json(); } catch (e) {}
    try {
      if (url.pathname === "/start") {
        const months = [1, 3, 6].includes(Number(body.months)) ? Number(body.months) : 3, st = b64(crypto.getRandomValues(new Uint8Array(18))).replace(/[+/=]/g, "");
        await env.LIMITS.put("gm:state:" + st, JSON.stringify({ uid, months }), { expirationTtl: 900 });
        const q = new URLSearchParams({ client_id: env.GOOGLE_ID, redirect_uri: redirectUri(req), response_type: "code", scope: SCOPE, access_type: "offline", prompt: "consent", state: st });
        return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + q }, 200, origin);
      }
      if (url.pathname === "/status") { const t = await getTok(env, uid); return json(t ? { connected: true, email: t.email, months: t.months, lastRunAt: t.lastRunAt || 0 } : { connected: false }, 200, origin); }
      if (url.pathname === "/sync") return json(await sync(env, uid, body), 200, origin);
      if (url.pathname === "/disconnect") {
        const t = await getTok(env, uid);
        if (t) await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(t.rt), { method: "POST" }).catch(() => {});
        await env.LIMITS.delete("gm:tok:" + uid); await env.LIMITS.delete("gm:run:" + uid);
        return json({ connected: false }, 200, origin);
      }
    } catch (e) { return json({ error: "failed", detail: String(e.message || e).slice(0, 80) }, 502, origin); }
    return json({ error: "not_found" }, 404, origin);
  }
};
