// Pato cron (Cloudflare Worker "pato-cron"). Replaces the scheduled Claude tasks:
//  1. Stock prices (market, pre-market, after-hours) -> Firestore users/{OWNER}/invest/ibkr  (port of investing/tools/stock_update.py)
//  2. Loan reminders -> Web Push to Marco's phone at 8:42am DR (the app's Reminders box has the Spanish text and the Remind button)
// Variables (Worker > Settings > Variables and Secrets):
//   BOT_PASSWORD (secret)   password of the sync robot sync-1f6e51ca@stakd-bot.app (same as STAKD_BOT_PASSWORD in the Claude environment)
//   FLEX_TOKEN (secret) + FLEX_QUERY (query id): IBKR Flex Web Service, read-only; syncs positions and cash
//   VAPID_PRIVATE (secret)  full text of vapid_private.pem (BEGIN/END PRIVATE KEY lines included), only needed for the push
// KV binding LIMITS (shared). Keys used here start with "cron:".
// GET /run?job=stocks|loans&key=... is not exposed; use "Trigger event" in the dashboard (Settings > Triggers) to test.
import { ingest } from "./ingest.js";
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

// Store for ingest.js (bank alert auto-logging): queries with a single filter only, so no Firestore index is needed
const flt = (f, op, v) => ({ fieldFilter: { field: { fieldPath: f }, op, value: val(v) } });
async function runQuery(env, col, filters) {
  const where = filters.length === 1 ? filters[0] : { compositeFilter: { op: "AND", filters } };
  const r = await fs(env, "POST", `${BASE}/users/${OWNER}:runQuery`, { structuredQuery: { from: [{ collectionId: col }], where, limit: 300 } });
  return (r || []).filter(x => x.document).map(x => docOf(x.document));
}
const fsStore = env => ({
  get: (c, id) => getDoc(env, c, id),
  put: (c, id, data) => patchDoc(env, c, id, data),
  eq: (c, f, v) => runQuery(env, c, [flt(f, "EQUAL", v)]),
  arrayHas: (c, f, v) => runQuery(env, c, [flt(f, "ARRAY_CONTAINS", v)]),
  range: (c, f, lo, hi) => runQuery(env, c, [flt(f, "GREATER_THAN_OR_EQUAL", lo), flt(f, "LESS_THAN_OR_EQUAL", hi)]),
  list: c => listCol(env, c),
});

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
  if (!dry) await flexDaily(env);   // positions + cash from IBKR first, then prices on top
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
  if (!dry) await stockAlerts(env, pos).catch(e => console.log("stock alerts", String(e)));
  return `stocks ok ${at} value US$${v}` + (dry ? " (dry run, nothing written)" : "");
}


// ---------- 1b. IBKR Flex sync (read-only: positions + cash straight from IBKR, no trading access) ----------
// Needs two vars: FLEX_TOKEN (secret) and FLEX_QUERY (query id). Query must include Open Positions and Cash Report.
// Flex data is as of the last market close, so it runs once a morning; positions the app already shows as bought AFTER the statement date are left alone.
const attrs = tag => Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
const flexDate = s => { const m = String(s || "").match(/(\d{4})-?(\d{2})-?(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]}` : ""; };
async function flexFetch(env) {
  const base = "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/";
  const h = { "user-agent": "pato-cron" };
  const r1 = await (await fetch(`${base}SendRequest?t=${encodeURIComponent(env.FLEX_TOKEN)}&q=${encodeURIComponent(env.FLEX_QUERY)}&v=3`, { headers: h })).text();
  const ref = (r1.match(/<ReferenceCode>(\d+)</) || [])[1];
  if (!ref) throw new Error("flex request: " + ((r1.match(/<ErrorMessage>([^<]*)</) || [])[1] || r1.slice(0, 120)));
  for (let i = 0; i < 6; i++) {
    await new Promise(r => setTimeout(r, 2000 + i * 1500));
    const x = await (await fetch(`${base}GetStatement?t=${encodeURIComponent(env.FLEX_TOKEN)}&q=${ref}&v=3`, { headers: h })).text();
    if (x.includes("<FlexQueryResponse")) return x;
    if (!/1019|in progress|try again/i.test(x)) throw new Error("flex statement: " + ((x.match(/<ErrorMessage>([^<]*)</) || [])[1] || x.slice(0, 120)));
  }
  throw new Error("flex statement not ready");
}
function flexParse(xml) {
  const st = attrs((xml.match(/<FlexStatement\b[^>]*>/) || [""])[0]);
  const toDate = flexDate(st.toDate);
  const pos = [...xml.matchAll(/<OpenPosition\b[^>]*>/g)].map(m => attrs(m[0]))
    .filter(a => (a.assetCategory || "STK") === "STK" && a.levelOfDetail !== "LOT" && Number(a.position) > 0)
    .map(a => ({ t: a.symbol, sh: Math.round(Number(a.position) * 1e6) / 1e6, costo: Number(a.costBasisPrice) || 0, invertido: Number(a.costBasisMoney) || 0, mark: Number(a.markPrice) || 0 }));
  const cr = [...xml.matchAll(/<CashReportCurrency\b[^>]*>/g)].map(m => attrs(m[0]));
  const c = cr.find(a => a.currency === "USD") || cr.find(a => a.currency === "BASE_SUMMARY");
  return { toDate, pos, cash: c && c.endingCash !== undefined ? Math.round(Number(c.endingCash) * 100) / 100 : null };
}
const appLast = p => [p.fecha, ...(p.compras || []).map(c => c.fecha)].filter(Boolean).sort().pop() || "";
async function flexSync(env, dry) {
  if (!env.FLEX_TOKEN || !env.FLEX_QUERY) return "flex: FLEX_TOKEN / FLEX_QUERY not set";
  const f = flexParse(await flexFetch(env));
  if (!f.toDate || !f.pos.length) return "flex: statement has no open positions, nothing changed";
  const d = await getDoc(env, "invest", "ibkr"); if (!d) return "flex: no ibkr doc";
  if (!dry) await env.LIMITS.put("cron:ibkr-backup-flex", JSON.stringify(d), { expirationTtl: 14 * 86400 });
  const log = [], mine = d.posiciones || [], seen = new Set();
  const out = [];
  for (const p of mine) {
    const x = f.pos.find(y => y.t === p.t); seen.add(p.t);
    if (appLast(p) > f.toDate) { out.push(p); log.push(`${p.t} kept (app newer than ${f.toDate})`); continue; }
    if (!x) { log.push(`${p.t} gone from IBKR, removed`); continue; }
    if (Math.abs(x.sh - p.sh) < 1e-5) { out.push(p); continue; }
    const q2 = { ...p, sh: x.sh }; if (!p.regalo && x.costo) { q2.costo = x.costo; q2.invertido = Math.round(x.invertido * 100) / 100; delete q2.comision; delete q2.comisionPagada; }
    out.push(q2); log.push(`${p.t} shares ${p.sh} -> ${x.sh}`);
  }
  for (const x of f.pos) if (!seen.has(x.t)) { out.push({ t: x.t, sh: x.sh, costo: x.costo, invertido: Math.round(x.invertido * 100) / 100, precio: x.mark, fecha: f.toDate }); log.push(`${x.t} added ${x.sh}`); }
  const patch = { posiciones: out, flex: { at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), toDate: f.toDate } };
  if (f.cash !== null && f.cash !== d.cash) { patch.cash = f.cash; log.push(`cash ${d.cash} -> ${f.cash}`); }
  if (!dry) await patchDoc(env, "invest", "ibkr", patch);
  return `flex ${f.toDate}: ` + (log.join("; ") || "no changes") + (dry ? " (dry run)" : "");
}
async function flexDaily(env) {   // at most once per 6 hours, only on the first tick of the day's market session
  if (!env.FLEX_TOKEN || (await env.LIMITS.get("cron:flex:last"))) return;
  await env.LIMITS.put("cron:flex:last", "1", { expirationTtl: 6 * 3600 });
  console.log(await flexSync(env, false).catch(e => "flex ERROR " + String(e)));
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


// ---------- Alert options (Settings > Alerts; every one is on unless Marco switched it off) ----------
async function pref(env, key) { const p = (await getDoc(env, "prefs", "alerts")) || {}; return p[key] !== false; }
const normS = x => String(x || "").trim().toLowerCase();

// "A stock hits a new high or drops 10% from your buy price": checked on every price update, once per event.
async function stockAlerts(env, pos) {
  if (!(await pref(env, "hl"))) return "hl off";
  const kv = env.LIMITS, day = iso(new Date(Date.now() - 4 * 3600e3)); let sent = 0;
  for (const p of pos) {
    const sym = p.t, px = Number(p.precio), cost = Number(p.costo);
    if (!sym || !(px > 0) || p.regalo) continue;
    // drop: price is 10% or more below your average buy price; one alert per fall, re-armed once it climbs back above -5%
    if (cost > 0) {
      const dk = "cron:dn:" + sym, armed = await kv.get(dk);
      if (px <= cost * 0.9 && !armed) { await push(env, `${sym} is down 10%`, `US$${px.toFixed(2)} vs your US$${cost.toFixed(2)} average buy (${((px / cost - 1) * 100).toFixed(1)}%)`, APP + "#stocks", "dn-" + sym); await kv.put(dk, "1"); sent++; }
      else if (px > cost * 0.95 && armed) await kv.delete(dk);
    }
    // new high: price beats the highest price this worker has seen since you bought (starts from your buy price, first run only records it); at most one per stock per day
    const hk = "cron:hi:" + sym, prev = Number(await kv.get(hk));
    if (!(prev > 0)) { await kv.put(hk, String(Math.max(px, cost || 0))); continue; }
    if (px > prev) {
      await kv.put(hk, String(px));
      if (!(await kv.get("cron:hisent:" + sym + ":" + day))) { await push(env, `${sym} hits a new high`, `US$${px.toFixed(2)}, your highest since you bought`, APP + "#stocks", "hi-" + sym); await kv.put("cron:hisent:" + sym + ":" + day, "1", { expirationTtl: 2 * 86400 }); sent++; }
    }
  }
  return "stock alerts sent: " + sent;
}

// "Expected income is late": an expected date (config fijos) passed with no matching payment logged. Once per date, checked every morning with the loan reminders.
async function lateIncome(env, dry) {
  if (!(await pref(env, "late"))) return "late off";
  const today = iso(new Date(Date.now() - 4 * 3600e3)), cfg = (await getDoc(env, "config", "main")) || {};
  const entries = (await listCol(env, "entries")).filter(e => e.type !== "out" && !e.extra);
  const lines = [], keys = [];
  for (const f of cfg.fijos || []) {
    if (!Array.isArray(f.dias) || f.pausado || f.semanal) continue;
    for (let back = 1; back <= 10; back++) {
      const d = addDays(today, -back), dt = new Date(d + "T12:00:00Z"), day = dt.getUTCDate();
      const hit = f.dias.some(x => x === "fin" ? day === lastDay(dt.getUTCFullYear(), dt.getUTCMonth()) : Number(x) === day);
      if (!hit || (f.hasta && d > f.hasta) || (f.omitir || []).includes(d)) continue;
      const k = "cron:late:" + normS(f.fuente) + ":" + d;
      if (await env.LIMITS.get(k)) continue;
      const got = entries.some(e => normS(e.source) === normS(f.fuente) && e.date && Math.abs(daysBetween(d, e.date)) <= 7);
      if (got) continue;
      const amt = (f.montos && f.montos[d]) || f.monto;
      lines.push(`${f.fuente}${amt ? " · " + (f.aprox ? "~" : "") + rd(amt) : ""} · expected ${d.slice(5)}`); keys.push(k);
    }
  }
  if (!lines.length) return "no late income";
  if (dry) return "WOULD SEND: " + lines.join(" | ");
  const n = await push(env, "Expected income is late", lines.join("\n"), APP + "#savings", "late-income");
  for (const k of keys) await env.LIMITS.put(k, "1", { expirationTtl: 20 * 86400 });
  return `late income push to ${n} phone(s): ${lines.length}`;
}
async function daily(env, dry) { const a = await loans(env, dry).catch(e => "loans ERROR " + String(e)); const b = await lateIncome(env, dry).catch(e => "late ERROR " + String(e)); return a + " | " + b; }

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
  if (h && h.pub) { const dk = "cron:dropsent:" + idx; if (!(await env.LIMITS.get(dk)) && await pref(env, "drop")) {
    const E = await env.LIMITS.get("ed9n:" + idx, "json").catch(() => null), top = E && E.b && E.b.big && (E.b.big.h || E.b.big.title);
    if (top) { await env.LIMITS.put(dk, "1", { expirationTtl: 2 * 86400 }); await push(env, "New Pato drop", String(top).slice(0, 140), "./", "pato-drop"); } } }
  if (!body) return "edition ok";
  await env.LIMITS.put(sent, "1", { expirationTtl: 2 * 86400 });
  const n = await push(env, "Pato Daily", body, "./", "pato-daily-health"); return "alert sent to " + n + " device(s): " + body;
}
export { flexSync, flexParse, stocks, loans, daily, lateIncome, stockAlerts, dueOf, dueDates, editionHealth };
export default {
  async scheduled(ev, env, ctx) {
    const job = ev.cron === "42 12 * * *" ? daily : stocks;
    ctx.waitUntil(job(env, false).then(m => console.log(m)).catch(e => console.log("ERROR", String(e))));
  },
  async fetch(req, env) {
    // called by the pato-ai worker (service binding) 35 minutes after each Pato Daily drop; the free plan allows only 5 cron triggers, so pato-ai's 5-minute cron does the timing
    if (new URL(req.url).pathname === "/health" && req.headers.get("x-edition-check") === "1") return new Response(await editionHealth(env).catch(e => "error " + String(e).slice(0, 100)), { status: 200 });
    const u = new URL(req.url);
    if (req.method === "POST" && u.pathname === "/notify") {   // instant bank alert from pato-mail (shared key in KV, so only our own workers can use it)
      const key = await env.LIMITS.get("gm:notifykey");
      if (!key || req.headers.get("x-notify-key") !== key) return new Response("no", { status: 403 });
      const b = await req.json().catch(() => ({})); if (!b.title) return new Response("missing title", { status: 400 });
      if (!(await pref(env, "bank").catch(() => true))) return new Response("off", { status: 200 });
      let logged = "", body = String(b.body || "");
      if (b.alert && await pref(env, "autolog").catch(() => true)) {   // auto-logging (Nov 17): a failure never blocks the push, it says so in it
        try { logged = await ingest(fsStore(env), b.alert); } catch (e) { logged = "error"; console.log("ingest failed", String(e).slice(0, 200)); await env.LIMITS.put("cron:ingesterr", String(e).slice(0, 300) + " @" + new Date().toISOString(), { expirationTtl: 7 * 86400 }).catch(() => 0); body += " · not logged"; } }
      try { return new Response("ok " + await push(env, String(b.title).slice(0, 80), body.slice(0, 160), "./", String(b.tag || "bank").slice(0, 60)) + (logged ? " | " + logged : ""), { status: 200 }); }
      catch (e) { return new Response("error " + String(e).slice(0, 120), { status: 500 }); }
    }
    if (u.pathname === "/flex" && env.BOT_PASSWORD && u.searchParams.get("pw") === env.BOT_PASSWORD)   // open once to preview, add &apply=1 to write
      return new Response(await flexSync(env, u.searchParams.get("apply") !== "1").catch(e => "ERROR " + String(e).slice(0, 200)), { status: 200 });
    return new Response("pato-cron: runs on a schedule (stocks, loan reminders)", { status: 200 });
  },
};
