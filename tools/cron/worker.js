// Pato cron (Cloudflare Worker "pato-cron"). Replaces the scheduled Claude tasks:
//  1. Stock prices (market, pre-market, after-hours) -> Firestore users/{OWNER}/invest/ibkr  (port of investing/tools/stock_update.py)
//  2. Loan reminders -> Web Push to Marco's phone at 8:42am DR (the app's Reminders box has the Spanish text and the Remind button)
// Variables (Worker > Settings > Variables and Secrets):
//   BOT_PASSWORD (secret)   password of the sync robot sync-1f6e51ca@stakd-bot.app (same as STAKD_BOT_PASSWORD in the Claude environment)
//   VAPID_PRIVATE (secret)  full text of vapid_private.pem (BEGIN/END PRIVATE KEY lines included), only needed for the push
// KV binding LIMITS (shared). Keys used here start with "cron:".
// GET /run?job=stocks|loans&key=... is not exposed; use "Trigger event" in the dashboard (Settings > Triggers) to test.
const API_KEY = "AIzaSyAMuD9zu8-MXApaHTCVsaXLi5CtV3WufY4";   // Firebase web key (public by design, same as the app)
const PROJECT = "stakd-3d1b9";
const OWNER = "e16AkFccPaRJjc5uosBXY5AGXyx1";
const BOT = "sync-1f6e51ca@stakd-bot.app";
const APP = "https://marcoferrando114.github.io/Sette-Cifre/";
const ROOT = `projects/${PROJECT}/databases/(default)/documents`;
const BASE = "https://firestore.googleapis.com/v1/" + ROOT;
const enc = new TextEncoder();

// ---------- Firestore (REST, as the sync robot) ----------
let _tok = null, _tokAt = 0;
async function token(env) {
  if (_tok && Date.now() - _tokAt < 50 * 60e3) return _tok;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: BOT, password: env.BOT_PASSWORD, returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error("sign-in failed: " + JSON.stringify(j.error || j).slice(0, 200));
  _tok = j.idToken; _tokAt = Date.now(); return _tok;
}
const val = v => v === null || v === undefined ? { nullValue: null } : typeof v === "boolean" ? { booleanValue: v }
  : typeof v === "number" ? (Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v })
  : typeof v === "string" ? { stringValue: v } : Array.isArray(v) ? { arrayValue: { values: v.map(val) } }
  : { mapValue: { fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) } };
const unv = v => { const [k, x] = Object.entries(v)[0]; return k === "integerValue" ? Number(x) : k === "doubleValue" ? x : k === "nullValue" ? null
  : k === "arrayValue" ? (x.values || []).map(unv) : k === "mapValue" ? Object.fromEntries(Object.entries(x.fields || {}).map(([a, b]) => [a, unv(b)])) : x; };
const docOf = d => ({ id: d.name.split("/").pop(), ...Object.fromEntries(Object.entries(d.fields || {}).map(([a, b]) => [a, unv(b)])) });
async function fs(env, method, url, body) {
  const r = await fetch(url, { method, headers: { authorization: "Bearer " + await token(env), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`firestore ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const path = (col, doc) => `${BASE}/users/${OWNER}/${col}` + (doc ? "/" + doc : "");
const getDoc = async (env, col, doc) => { const d = await fs(env, "GET", path(col, doc)); return d ? docOf(d) : null; };
async function listCol(env, col) {
  let out = [], page = "";
  for (;;) {
    const r = await fs(env, "GET", path(col) + `?pageSize=300${page ? "&pageToken=" + page : ""}`) || {};
    out = out.concat((r.documents || []).map(docOf)); page = r.nextPageToken; if (!page) return out;
  }
}
async function patchDoc(env, col, doc, data) {   // merge top-level fields
  const keys = Object.keys(data), mask = keys.map(k => "updateMask.fieldPaths=" + encodeURIComponent(/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : "`" + k + "`")).join("&");
  return fs(env, "PATCH", path(col, doc) + "?" + mask, { fields: Object.fromEntries(keys.map(k => [k, val(data[k])])) });
}

// ---------- 1. Stock prices ----------
async function q(sym, ext = true) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${sym.replace("^", "%5E")}?interval=5m&range=1d` + (ext ? "&includePrePost=true" : "");
  const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`yahoo ${sym} ${res.status}`);
  const r = (await res.json()).chart.result[0], m = r.meta, qq = r.indicators.quote[0], ts = r.timestamp || [];
  const reg = (m.currentTradingPeriod || {}).regular || {}, rs = reg.start || 0, re = reg.end || 0;
  const op = ts.map((t, i) => [t, qq.open[i]]).find(([t, o]) => o && rs <= t && t < re);
  let precio = m.regularMarketPrice, time = m.regularMarketTime;
  const last = ts.map((t, i) => [t, qq.close[i]]).filter(([, c]) => c);
  if (ext && last.length && last[last.length - 1][0] > time + 60) { time = last[last.length - 1][0] + 300; precio = last[last.length - 1][1]; }
  const regTs = last.filter(([t]) => rs <= t && t < re);
  let prev = m.chartPreviousClose || m.previousClose;
  // pre-market of a new day: Yahoo's meta still describes the last session, so its close is the new previous close
  const preS = ((m.currentTradingPeriod || {}).pre || {}).start || 0;
  if (ext && preS && m.regularMarketTime < preS && last.length && last[last.length - 1][0] >= preS) prev = m.regularMarketPrice;
  const r4 = x => Math.round(x * 1e4) / 1e4;
  return { precio: r4(precio), prev, open: op ? r4(op[1]) : null, time: Math.min(time, Math.floor(Date.now() / 1000)),
    ts: regTs.map(([t]) => t), close: regTs.map(([, c]) => c) };
}
async function stocks(env, dry) {
  const d = await getDoc(env, "invest", "ibkr");
  if (!d || !(d.posiciones || []).length) return "no ibkr doc";
  if (!dry) await env.LIMITS.put("cron:ibkr-backup", JSON.stringify(d), { expirationTtl: 7 * 86400 });   // last copy before each write
  let latest = 0; const pos = [];
  for (const p of d.posiciones) { const x = await q(p.t); latest = Math.max(latest, x.time); pos.push({ ...p, precio: x.precio, prev: x.prev, open: x.open }); }
  const b = { ...(d.bench || { t: "SPY" }) }, s = await q(b.t || "SPY"); latest = Math.max(latest, s.time);
  if (!b.start && b.desde) {
    const t0 = Date.parse(b.desde) / 1000, c = s.ts.map((t, i) => [t, s.close[i]]).filter(([t, cl]) => t <= t0 && cl);
    b.start = c.length ? Math.round(c[c.length - 1][1] * 1e4) / 1e4 : s.precio;
  }
  b.precio = s.precio;
  const g = await q("^GSPC", false); b.idx = g.precio; b.idxPrev = g.prev;
  const at = new Date(latest * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const v = Math.round(((d.cash || 0) + pos.reduce((t, p) => t + (p.sh || 0) * p.precio, 0)) * 100) / 100;
  let h = (d.hist || []).filter(x => x && typeof x === "object" && "t" in x && "v" in x);
  if (!h.length || latest > h[h.length - 1].t + 600) h.push({ t: latest, v });
  else if (latest >= h[h.length - 1].t) h[h.length - 1] = { t: latest, v };
  const out = { posiciones: pos, bench: b, at, hist: h.slice(-400) };
  if (!dry) await patchDoc(env, "invest", "ibkr", out);
  return `stocks ok ${at} value US$${v}` + (dry ? " (dry run, nothing written)" : "");
}

// ---------- 2. Loan reminders (push) ----------
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 864e5);
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const nCuotas = l => Math.max(1, Math.round(Number(l.cuotas) || 1));
const total = l => l.monto * (1 + (l.interes || 0) / 100);
const paidList = l => Array.isArray(l.cuotasPagadas) ? l.cuotasPagadas : [];
const paidSum = l => paidList(l).reduce((t, c) => t + (Number(c.monto) || 0), 0);
const remaining = l => l.pagado ? 0 : Math.max(0, total(l) - paidSum(l));
function dueDates(l, today) {   // same as the app's dueDates()
  const n = nCuotas(l), out = [], d0 = new Date((l.fecha || today) + "T12:00:00Z");
  for (let k = 0; k < n; k++) {
    if (l.frecuencia === "semanal") out.push(addDays(iso(d0), 7 * k));
    else if (l.frecuencia === "quincenal") out.push(addDays(iso(d0), 14 * k));
    else { const day = d0.getUTCDate(), d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1, 12)); d.setUTCDate(Math.min(day, lastDay(d.getUTCFullYear(), d.getUTCMonth()))); out.push(iso(d)); }
  }
  return out;
}
function dueOf(l, today) {
  if (l.pagado || l.pausado) return null;
  let date = l.fecha, amt = remaining(l);
  if (nCuotas(l) > 1) {
    const n = nCuotas(l), left = remaining(l); if (left < 0.5) return null;
    const each = total(l) / n, paid = paidSum(l), k = Math.min(n - 1, Math.floor((paid + 0.5) / each));
    date = dueDates(l, today)[k]; amt = k + 1 === n ? left : Math.min(each * (k + 1) - paid, left);
  }
  if (!date) return null;
  const d = daysBetween(today, date);
  return { name: String(l.nombre || "").trim(), date, d, amt, kind: d < 0 ? "late" : "pre", avisos: Array.isArray(l.avisos) ? l.avisos : [] };
}
const rd = n => "RD$" + Math.round(n).toLocaleString("en-US");
const cap = s => s.replace(/\b\w/g, c => c.toUpperCase());
async function loans(env, dry) {
  const today = iso(new Date(Date.now() - 4 * 3600e3));   // DR date
  const items = [];
  for (const l of await listCol(env, "prestamos")) { const it = dueOf(l, today); if (it) items.push(it); }
  const cfg = (await getDoc(env, "config", "main")) || {};
  for (const x of cfg.deudas || []) {
    if (x.liga || x.pausado || !x.vence) continue;
    const d = daysBetween(today, x.vence); items.push({ name: String(x.nombre || "").trim(), date: x.vence, d, amt: x.total || 0, kind: d < 0 ? "late" : "pre", avisos: [] });
  }
  const pick = items.filter(it => (it.d === 7 || it.d === 2) && !it.avisos.includes(it.kind + ":" + it.date)).sort((a, b) => a.date.localeCompare(b.date));
  const lines = pick.map(it => `${cap(it.name)} · ${rd(it.amt)} · in ${it.d} days`);
  if (!lines.length) return "loans ok, nothing due in 7 or 2 days";
  const sentKey = "cron:loans:" + today;
  if (!dry && await env.LIMITS.get(sentKey)) return "loans already sent today";
  const body = lines.join("\n");
  if (dry) return "WOULD SEND: " + body;
  const n = await push(env, "Payments coming up", body, APP + "#loans", "loans");
  await env.LIMITS.put(sentKey, "1", { expirationTtl: 2 * 86400 });
  return `loans ok, push sent to ${n} phone(s): ${lines.length} item(s)`;
}

// ---------- Web Push (RFC 8291 aes128gcm + VAPID) ----------
const b64u = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hmac(key, data) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }
async function vapid(env, endpoint) {
  const pem = String(env.VAPID_PRIVATE || "").replace(/-----[A-Z ]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", unb64(pem.replace(/\+/g, "-").replace(/\//g, "_")), { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  const pub = cat(new Uint8Array([4]), unb64(jwk.x), unb64(jwk.y));
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: APP })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims)));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(pub)}`;
}
async function encrypt(sub, data) {
  const uaPub = unb64(sub.keys.p256dh), auth = unb64(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const ua = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, as.privateKey, 256));
  const ikm = (await hmac(await hmac(auth, secret), cat(enc.encode("WebPush: info\0"), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16)), prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, cat(data, new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPub.length]), asPub, ct);
}
async function push(env, title, body, url, tag) {
  if (!env.VAPID_PRIVATE) throw new Error("VAPID_PRIVATE is not set");
  const doc = (await getDoc(env, "prefs", "push")) || {}, subs = doc.subs || [], keep = []; let ok = 0;
  const payload = enc.encode(JSON.stringify({ title, body, url, tag }));
  for (const s of subs) {
    try {
      const r = await fetch(s.endpoint, { method: "POST", body: await encrypt(s, payload), headers: {
        "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", authorization: await vapid(env, s.endpoint) } });
      if (r.status === 404 || r.status === 410) continue;   // phone unsubscribed: forget it
      if (r.ok) ok++; else console.log("push failed", r.status, (await r.text()).slice(0, 200));
      keep.push(s);
    } catch (e) { console.log("push failed", String(e)); keep.push(s); }
  }
  if (keep.length !== subs.length) await patchDoc(env, "prefs", "push", { subs: keep });
  return ok;
}

// Pato Daily health (Marco Nov 14): 35 minutes after each drop (7:35am, 1:35pm, 7:35pm DR) the pato-ai worker has either published the edition or kept the last good one.
// It leaves a note in KV ("edh:<drop>"); if the drop was not clean, push Marco's phone a one-line reason, once per drop.
async function editionHealth(env) {
  const idx = Math.floor((Date.now() - 11 * 3600e3) / (6 * 3600e3)), sent = "cron:edalert:" + idx;
  if (await env.LIMITS.get(sent)) return "already alerted";
  const h = await env.LIMITS.get("edh:" + idx, "json");
  let body = "";
  if (!h) body = "this drop was not built; the last edition is still showing";
  else if (h.level === "hard") body = "drop failed the check, last good edition kept: " + (h.reasons || []).slice(0, 2).join("; ");
  else if (h.level === "soft") body = "published with a note: " + (h.reasons || []).slice(0, 2).join("; ");
  if (!body) return "edition ok";
  await env.LIMITS.put(sent, "1", { expirationTtl: 2 * 86400 });
  const n = await push(env, "Pato Daily", body, "./", "pato-daily-health"); return "alert sent to " + n + " device(s): " + body;
}
export { stocks, loans, dueOf, dueDates, editionHealth };
export default {
  async scheduled(ev, env, ctx) {
    const job = ev.cron === "42 12 * * *" ? loans : stocks;
    ctx.waitUntil(job(env, false).then(m => console.log(m)).catch(e => console.log("ERROR", String(e))));
  },
  async fetch(req, env) {
    // called by the pato-ai worker (service binding) 35 minutes after each Pato Daily drop; the free plan allows only 5 cron triggers, so pato-ai's 5-minute cron does the timing
    if (new URL(req.url).pathname === "/health" && req.headers.get("x-edition-check") === "1") return new Response(await editionHealth(env).catch(e => "error " + String(e).slice(0, 100)), { status: 200 });
    return new Response("pato-cron: runs on a schedule (stocks, loan reminders)", { status: 200 });
  },
};
