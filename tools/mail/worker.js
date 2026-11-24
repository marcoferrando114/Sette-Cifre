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
const PAGE = 10;            // emails per call: small, so real-size HTML emails stay inside the free plan CPU limit (10 ms) and 50-call limit
const DAILY_CALLS = 200;    // sync calls per friend per day (2,000 emails; protects the Anthropic credit)
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
  .replace(/&nbsp;/g, " ").replace(/&([aeiou])acute;/gi, (m, v) => ({ a: "á", e: "é", i: "í", o: "ó", u: "ú" })[v.toLowerCase()]).replace(/&ntilde;/gi, "ñ").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/gi, " ");
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
      text: bodyText(m.payload).slice(0, 1000) || String(m.snippet || "") }; });
  run.pmax = list.reduce((a, e) => Math.max(a, Math.floor(e.ts / 1000)), run.max);
  const items = list.length ? await readEmails(env, list) : [];
  await env.LIMITS.put(rk, JSON.stringify(run), { expirationTtl: 30 * 86400 });
  return { connected: true, email: t.email, items, read: list.length, next: l.nextPageToken || "END", first: !t.since, lastRunAt: t.lastRunAt || 0 };
}


// ---- Instant bank alerts for Marco (Nov 17): pato-ai's 5-minute timer calls /watch; new bank emails become a push within minutes ----
// Reads only the alert emails from BHD and Popular, with plain text rules (no AI, no cost). The push itself is sent by pato-cron (service binding CRON).
const OWNER_UID = "e16AkFccPaRJjc5uosBXY5AGXyx1";
const BANK_Q = "from:(Alertas@bhd.com.do OR notificaciones@bhd.com.do OR notificaciones@popularenlinea.com)";
// Nov 24: receipts and subscription notices from stores Marco uses (plain text rules, no AI). Anything that is not a receipt is ignored by parseReceipt.
const RCPT_Q = "from:(noreply@uber.com OR pedidosya OR amazon.com OR amazon.it OR amazon.es OR email.apple.com OR netflix.com OR spotify.com OR openai.com OR anthropic.com OR disneyplus.com OR youtube.com OR google.com) subject:(order OR pedido OR receipt OR recibo OR trip OR viaje OR charged OR renew OR renews OR invoice OR factura OR ordered OR payment OR pago)";
const WATCH_Q = "(" + BANK_Q + " OR " + RCPT_Q.replace(/^from:/, "from:") + ")";
const nice = s => String(s || "").toLowerCase().replace(/(^|[\s,.'-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()).trim();
const money = (cur, n) => (cur === "USD" ? "US$" : cur === "EUR" ? "€" : "RD$") + n.toLocaleString("en-US", { minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 });
const num = a => Number(String(a).replace(/,/g, ""));
const isoD = d => { let m = String(d || "").match(/^(\d\d)\/(\d\d)\/(\d{4})/); if (m) return m[3] + "-" + m[2] + "-" + m[1]; m = String(d || "").match(/^(\d{4})(\d\d)(\d\d)$/); return m ? m[1] + "-" + m[2] + "-" + m[3] : ""; };
const curOf = c => /^US/i.test(c) ? "USD" : "DOP";
// One bank alert email -> {bank, kind: card|transfer|deposit|cash|in, amount, cur, detail, status, date} or null (ads, codes, anything else)
function parseAlert(from, subject, text) {
  const bank = /bhd\.com\.do/i.test(from) ? "BHD" : /popularenlinea/i.test(from) ? "Popular" : null; if (!bank) return null;
  const T = String(text || "").replace(/[­ ]/g, " ").replace(/\s+/g, " "), S = String(subject || ""); let x;
  if (/C[oó]digo Cash/i.test(S + " " + T) && (x = T.match(/RD\s*\$?\s*([\d,]+\.\d\d)\s+(\d\d\/\d\d\/\d{4})\s+(Aprobada|Declinada|Rechazada)/i)))
    return { bank, kind: "cash", amount: num(x[1]), cur: "DOP", detail: "", status: x[3], date: isoD(x[2]) };
  if (/Dep[oó]sito/i.test(S) && (x = T.match(/RD\s*\$?\s*([\d,]+\.\d\d)\s+(\d{8})\s+(.+?)\s+En caso/i)))
    return { bank, kind: "deposit", amount: num(x[1]), cur: "DOP", detail: /ATM/i.test(S) ? "ATM" : nice(x[3].replace(/_/g, " ")), raw: S, status: "Aprobada", date: isoD(x[2]) };
  if (bank === "BHD" && /Beneficiario/i.test(T) && (x = T.match(/Monto:?\s*(RD|US)\s*\$?\s*([\d,]+\.\d\d)/i))) {
    const b = (T.match(/Beneficiario:?\s*(.+?)\s+N.{1,3}mero de confirmaci/i) || [])[1] || "";
    return { bank, kind: "transfer", amount: num(x[2]), cur: curOf(x[1]), detail: /MARCO/i.test(b) && /FERRANDO/i.test(b) ? "to yourself" : "to " + nice(b), bene: b, status: "Aprobada", date: isoD((T.match(/transacci.{1,3}n:?\s*(\d\d\/\d\d\/\d{4})/i) || [])[1]) };
  }
  if (bank === "BHD" && (x = T.match(/(\d\d\/\d\d\/\d{4})\s+\d{1,2}:\d\d\s*[ap]m\s+(RD|US)\s*\$?\s*([\d,]+\.\d\d)\s+(.+?)\s+(Aprobada|Declinada|Rechazada|Reversada)\b/i)))
    return { bank, kind: "card", amount: num(x[3]), cur: curOf(x[2]), detail: nice(x[4]), raw: x[4].trim(), status: x[5], date: isoD(x[1]) };
  if (bank === "Popular" && (x = T.match(/(RD|US)\$\s*([\d,]+\.\d\d)\s+(?:Peso dominicano|D[oó]lar[a-z ]*|Euro)\s+(\d\d\/\d\d\/\d{4})\s+(.+?)\s+(Aprobada|Declinada|Rechazada|Reversada)/i)))
    return { bank, kind: "card", amount: num(x[2]), cur: curOf(x[1]), detail: nice(x[4]), raw: x[4].trim(), status: x[5], date: isoD(x[3]) };
  if (/dep[oó]sito|cr[eé]dito|acredit|recibi|transferencia recibida/i.test(S) && !/publicidad|plazo/i.test(S) && (x = T.match(/(RD|US)\s*\$?\s*([\d,]+\.\d\d)/i)))   // money in: any wording the bank may use
    return { bank, kind: "in", amount: num(x[2]), cur: curOf(x[1]), detail: "", status: "Aprobada", date: "" };
  return null;
}
const numL = t => { let n = String(t || "").replace(/[^\d.,]/g, ""); if (/,\d{1,2}$/.test(n) && !/\.\d{1,2}$/.test(n)) n = n.replace(/\./g, "").replace(",", "."); else n = n.replace(/,/g, ""); return Math.round(Number(n) * 100) / 100 || 0; };
const curL = t => /US\$|USD/i.test(t) ? "USD" : /€|EUR/i.test(t) ? "EUR" : "DOP";
const BRAND = [[/uber/i, "Uber"], [/pedidosya/i, "PedidosYa"], [/amazon/i, "Amazon"], [/apple/i, "Apple"], [/netflix/i, "Netflix"], [/spotify/i, "Spotify"], [/openai/i, "OpenAI"], [/anthropic/i, "Claude"], [/disney/i, "Disney+"], [/youtube/i, "YouTube"], [/google/i, "Google"]];
const addDaysISO = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
// One store email -> {kind:"receipt", merchant, detail, amount, cur, card4, cat} | {kind:"sub", merchant, amount, cur, renews, every} | null (marketing, shipping notices, anything else)
function parseReceipt(from, subject, text, tsMs) {
  const brand = (BRAND.find(([re]) => re.test(from)) || [])[1]; if (!brand) return null;
  const T = String(text || "").replace(/[­ ]/g, " ").replace(/[ \t]+/g, " "), S = String(subject || ""), one = T.replace(/\s*\n\s*/g, " ");
  const day = new Date((tsMs || Date.now()) - 4 * 3600e3).toISOString().slice(0, 10);
  const card = (one.match(/(?:Visa|Mastercard|MasterCard|Amex|card|tarjeta)[^\d]{0,12}(\d{4})\b/i) || [])[1] || "";
  let x;
  if (brand === "Uber" && /Uber Eats/i.test(S)) {   // "Here's your receipt for <restaurant>."  Total  DOP 780.00
    const rest = (one.match(/receipt for (.+?)\.\s/i) || [])[1] || "", tot = one.match(/\bTotal\s+(DOP|RD\$|USD|US\$)\s*([\d,]+\.\d\d)/i);
    if (!tot) return null;
    return { kind: "receipt", merchant: "Uber Eats", detail: rest.trim().slice(0, 80), amount: numL(tot[2]), cur: curL(tot[1]), card4: card, cat: "food" };
  }
  if (brand === "Uber" && /trip|ride|viaje|receipt|recibo/i.test(S) && !/enjoyed|see what/i.test(S)) {   // ride: Total, pickup/drop-off lines "12:05 PM <address>"
    const tot = one.match(/\bTotal\s*:?\s*(DOP|RD\$|USD|US\$|\$)\s*([\d,]+\.\d\d)/i); if (!tot) return null;
    const stops = [...T.matchAll(/(\d{1,2}:\d\d\s?[AP]M)\s*\n?\s*([^\n]{6,90})/gi)].map(m => m[2].trim().replace(/,\s*(Santo Domingo|Distrito Nacional|Dominican Republic).*$/i, ""));
    const km = (one.match(/([\d.]+)\s?(km|mi)\b/i) || []), mins = (one.match(/(\d+)\s?min(?:utes|s)?\b/i) || [])[1];
    const route = stops.length >= 2 ? stops[0] + " → " + stops[1] : "";
    const detail = [route, km[1] ? km[1] + " " + km[2].toLowerCase() : "", mins ? mins + " min" : ""].filter(Boolean).join(" · ");
    return { kind: "receipt", merchant: "Uber", detail: detail.slice(0, 140), amount: numL(tot[2]), cur: curL(tot[1]), card4: card, cat: "rides" };
  }
  if (brand === "PedidosYa" && /pedido|order|recibo|receipt|factura/i.test(S)) {
    const tot = one.match(/\bTotal(?: a pagar| pagado)?\s*:?\s*(RD\s?\$|\$|DOP)?\s*([\d.,]+\d)/i); if (!tot) return null;
    const rest = (one.match(/(?:en|from|de)\s+([A-ZÁÉÍÓÚÑ][^.\n]{2,40}?)(?:\.|,| Total| Pedido)/) || [])[1] || "";
    const items = [...T.matchAll(/(\d+)\s?x\s+([^\n$]{3,40}?)\s*(?:RD|\$|\n|$)/gi)].slice(0, 3).map(m => m[1] + "× " + m[2].trim());
    return { kind: "receipt", merchant: "PedidosYa", detail: [rest, items.join(", ")].filter(Boolean).join(" · ").slice(0, 140), amount: numL(tot[2]), cur: "DOP", card4: card, cat: "food" };
  }
  if (brand === "Amazon" && /^Ordered:|Your Amazon.*order|Tu pedido|Il tuo ordine/i.test(S)) {
    const tot = one.match(/(?:Order Total|Total (?:del pedido|order|ordine)|Totale ordine)\s*:?\s*(EUR|USD|US\$|\$|€)?\s*([\d.,]+\d)\s*(€|EUR|USD)?/i); if (!tot) return null;
    const item = ((S.match(/^Ordered:\s*['"‘](.+?)['"’]?$/) || [])[1] || (one.match(/Order(?:ed)?:?\s+(.{10,70}?)\s+Quantity/i) || [])[1] || "").replace(/\.\.\.$/, "…");
    return { kind: "receipt", merchant: "Amazon", detail: item.trim().slice(0, 100), amount: numL(tot[2]), cur: curL((tot[1] || "") + (tot[3] || "")), card4: card, cat: "shopping" };
  }
  if (/will be charged|renews?|renovaci|subscription|suscripci/i.test(S + " " + one.slice(0, 600)) && !/receipt|recibo|invoice|factura/i.test(S)) {   // heads-up before a charge: noted with its renewal date, not spending
    const m = one.match(/renews?\s+(monthly|yearly|annually|weekly)?\s*for\s*([\d.,]+\d)\s*(€|EUR|\$|USD|US\$)?|(€|\$|US\$)\s?([\d.,]+\d)\s*(?:\/|per)\s*(month|year)/i); if (!m) return null;
    const inN = (S.match(/in (\d+) days?/i) || [])[1], plan = (S.match(/your (.+?) (?:plan|subscription)/i) || [])[1] || brand;
    return { kind: "sub", merchant: String(plan).replace(/^iCloud\+?$/i, "iCloud+").slice(0, 40), amount: numL(m[2] || m[5]), cur: curL((m[3] || m[4] || "") + one.slice(0, 0)), renews: addDaysISO(day, Number(inN) || 0), every: (m[1] || m[6] || "").replace(/annually/, "yearly").replace(/^month$/, "monthly").replace(/^year$/, "yearly") };
  }
  if (/receipt|recibo|invoice|factura|payment|pago|charged/i.test(S) && ["Netflix", "Spotify", "OpenAI", "Claude", "Disney+", "YouTube", "Google", "Apple"].includes(brand) && (x = one.match(/(?:Total|Amount|Importe|Charged|paid)\s*:?\s*(US\$|\$|€|EUR|USD|RD\$)\s?([\d.,]+\d)/i)))   // an actual subscription charge
    return { kind: "receipt", merchant: brand, detail: S.slice(0, 80), amount: numL(x[2]), cur: curL(x[1]), card4: card, cat: "subs" };
  return null;
}
function alertText(a) {
  const m = money(a.cur, a.amount), bad = /Declinada|Rechazada/i.test(a.status), rev = /Reversada/i.test(a.status);
  if (a.kind === "receipt") return [a.merchant + " receipt", m + (a.detail ? " · " + a.detail : "")];
  if (a.kind === "sub") return [a.merchant + " renews " + (a.renews || ""), m + (a.every ? " " + a.every : "")];
  if (a.kind === "card") return [a.bank + (bad ? " card declined" : rev ? " card reversed" : " card"), m + " · " + a.detail];
  if (a.kind === "transfer") return [a.bank + " transfer out", m + " · " + a.detail];
  if (a.kind === "deposit") return [a.bank + " deposit", m + (a.detail ? " · " + a.detail : "")];
  if (a.kind === "cash") return [a.bank + (bad ? " cash withdrawal declined" : " cash withdrawal"), m];
  return [a.bank + " money in", m];
}
async function notifyKey(env) { let k = await env.LIMITS.get("gm:notifykey"); if (!k) { k = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, ""); await env.LIMITS.put("gm:notifykey", k); } return k; }
async function notify(env, title, body, tag, alert) {
  if (!env.CRON) throw new Error("no CRON binding");
  const r = await env.CRON.fetch("https://pato-cron/notify", { method: "POST", headers: { "content-type": "application/json", "x-notify-key": await notifyKey(env) }, body: JSON.stringify({ title, body, tag, alert }) });
  if (!r.ok) throw new Error("notify " + r.status + " " + (await r.text()).slice(0, 80));
}
async function watch(env) {
  const uid = OWNER_UID, t = await getTok(env, uid); if (!t) {   // Nov 19: never fail silently: one nudge a day until Marco taps Connect
    if (!(await env.LIMITS.get("gm:nowarn"))) { await env.LIMITS.put("gm:nowarn", "1", { expirationTtl: 86400 }); try { await notify(env, "Pato can't read bank emails", "Open Pato > Settings > Spend and tap Connect", "bank-noconnect"); } catch (x) {} }
    return "gmail not connected"; }
  const last = Number(await env.LIMITS.get("gm:watch:last")) || 0; if (Date.now() - last < 90e3) return "too soon";
  await env.LIMITS.put("gm:watch:last", String(Date.now()), { expirationTtl: 600 });
  const wk = "gm:watch:" + uid; let st = JSON.parse((await env.LIMITS.get(wk)) || "null");
  const now = Math.floor(Date.now() / 1000);
  if (!st) { await env.LIMITS.put(wk, JSON.stringify({ since: now, seen: [] })); return "started: only emails from now on"; }   // first run after connecting: no backlog
  let at = await env.LIMITS.get("gm:at:" + uid);
  if (!at) {
    try { at = await accessToken(env, t.rt); } catch (e) {
      if (e.reconnect) { await env.LIMITS.delete("gm:tok:" + uid); try { await notify(env, "Pato lost Gmail", "Open Pato > Spend and tap Connect for instant bank alerts", "bank-reconnect"); } catch (x) {} return "reconnect needed"; }
      throw e; }
    await env.LIMITS.put("gm:at:" + uid, at, { expirationTtl: 3000 });
  }
  const G = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
  let l; try { l = await google(G + "?maxResults=15&q=" + encodeURIComponent(WATCH_Q + " after:" + Math.max(st.since, now - 48 * 3600)), at); }
  catch (e) { if (e.status === 401) await env.LIMITS.delete("gm:at:" + uid); throw e; }
  const fresh = (l.messages || []).map(m => m.id).filter(id => !st.seen.includes(id)).slice(0, 4);   // a few per run keeps each run light; the rest comes next run
  if (!fresh.length) return "nothing new";
  const log = JSON.parse((await env.LIMITS.get("gm:alerts:" + uid)) || "[]"); let sent = 0;
  for (const id of fresh.reverse()) {   // oldest first
    const m = await google(G + "/" + id + "?format=full", at).catch(() => null); if (!m) continue;
    const txt = bodyText(m.payload), a = parseAlert(head(m, "from"), head(m, "subject"), txt) || parseReceipt(head(m, "from"), head(m, "subject"), txt, Number(m.internalDate) || Date.now());
    if (a) { const [title, body] = alertText(a);
      try { await notify(env, title, body, "bank-" + id, { ...a, id, ts: Number(m.internalDate) || Date.now() }); } catch (e) { console.log("notify failed", String(e)); break; }   // not marked seen: tried again on the next run (for 3 hours)
      log.push({ id, ts: Number(m.internalDate) || Date.now(), ...a }); sent++; }
    st.seen.push(id);
  }
  st.seen = st.seen.slice(-200);
  await env.LIMITS.put(wk, JSON.stringify(st));
  if (sent) await env.LIMITS.put("gm:alerts:" + uid, JSON.stringify(log.slice(-60)));
  return sent + " alert(s) sent";
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
    if (req.method === "POST" && url.pathname === "/watch" && req.headers.get("x-watch") === "1" && env.GOOGLE_ID && env.GOOGLE_SECRET && env.LIMITS)   // called by pato-ai's 5-minute timer (service binding)
      return new Response(await watch(env).catch(e => "error " + String(e.message || e).slice(0, 100)), { status: 200 });
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
      if (url.pathname === "/paylink") {   // Apple Pay Shortcut link for Marco only: the token lives in KV (pay:token), pato-cron /pay checks it
        if (uid !== OWNER_UID) return json({ error: "forbidden" }, 403, origin);
        let k = await env.LIMITS.get("pay:token"); if (!k || body.reset) { k = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, ""); await env.LIMITS.put("pay:token", k); }
        return json({ url: "https://pato-cron.marcoferrando.workers.dev/pay?t=" + k }, 200, origin);
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
export { parseReceipt, parseAlert };
