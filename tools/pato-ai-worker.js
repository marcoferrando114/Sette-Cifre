// Pato AI camera proxy + Pato News (Cloudflare Worker). Keeps the Anthropic key on the server, lets in only signed-in Pato users.
// Secrets/vars (Worker > Settings > Variables): ANTHROPIC_KEY (secret). Optional: DAILY (photos per person per day, default 20),
// OWNER_UID + OWNER_DAILY (default 30). Optional KV binding LIMITS for the daily counts.
const PROJECT = "stakd-3d1b9";
const ORIGINS = ["https://marcoferrando114.github.io"];
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const JWKS = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";
let jwks = null, jwksAt = 0;

const b64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const json = (o, status, origin) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...cors(origin) } });
const cors = origin => ORIGINS.includes(origin) ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, OPTIONS", "vary": "origin" } : {};

async function verify(token) {
  const [h, p, s] = String(token || "").split("."); if (!s) return null;
  const head = JSON.parse(new TextDecoder().decode(b64u(h))), pay = JSON.parse(new TextDecoder().decode(b64u(p)));
  const now = Math.floor(Date.now() / 1000);
  if (head.alg !== "RS256" || pay.aud !== PROJECT || pay.iss !== "https://securetoken.google.com/" + PROJECT || !pay.sub || pay.exp < now || pay.iat > now + 60) return null;
  if (!jwks || Date.now() - jwksAt > 3600e3) { jwks = (await (await fetch(JWKS)).json()).keys; jwksAt = Date.now(); }
  const jwk = jwks.find(k => k.kid === head.kid); if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(s), new TextEncoder().encode(h + "." + p));
  return ok ? pay.sub : null;
}


// ---------- Pato News (free: Google News RSS, cached at Cloudflare's edge, no AI, no KV writes) ----------
const GN = "https://news.google.com/rss", LANG = "hl=en-US&gl=US&ceid=US:en";
const TRUSTED = /^(Reuters|Associated Press|AP News|CNBC|Bloomberg|Bloomberg\.com|Yahoo Finance|Yahoo|MarketWatch|The Wall Street Journal|WSJ|Financial Times|CNN|CNN Business|Business Insider|Barron's|Fox Business|Axios|The Verge|TechCrunch|CoinDesk|Forbes|ESPN|The Athletic|CBS Sports|NBC Sports|Yahoo Sports|Sports Illustrated|Diario Libre|Listín Diario|PokerNews|PokerGO|Investopedia|NPR|The New York Times|Bloomberg Línea)$/i;
const JUNK = /\b(opinion|sponsored|\d+ (stocks?|ways|things|reasons|picks)|top \d+|best .{0,30} to buy|should you (buy|sell)|is it time to|buy now|before it'?s too late|millionaire|prediction:|could make you rich|live updates?|quiz|podcast)\b/i;
const MOVERS = /\b(fed|federal reserve|powell|rates?|inflation|cpi|jobs report|payrolls|s&p|nasdaq|dow|stocks?|wall street|bitcoin|crypto|dollar|earnings|oil|treasur(y|ies)|recession|tariffs?|ipo|market)\b/i;
const TOPICS = { poker: "poker WSOP OR \"World Series of Poker\" OR \"poker tournament\"", crypto: "bitcoin OR ethereum crypto", tech: "AI OR Apple OR Nvidia OR Google tech", saving: "\"personal finance\" OR savings OR \"interest rates\" money tips" };
const dec = t => t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
function parse(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const g = tag => { const r = m[1].match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">")); return r ? dec(r[1]) : ""; };
    const src = g("source"); let title = g("title"); if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    return { h: title, s: src, u: g("link"), t: Date.parse(g("pubDate")) || 0 };
  });
}
async function feed(url, ttl) {
  const cache = caches.default, key = new Request(url);
  let r = await cache.match(key);
  if (!r) {
    const f = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; PatoNews/1.0)" } });
    if (!f.ok) return [];
    r = new Response(await f.text(), { headers: { "content-type": "text/xml", "cache-control": "public, max-age=" + ttl, "x-at": String(Date.now()) } });
    await cache.put(key, r.clone());
  }
  return { at: Number(r.headers.get("x-at")) || Date.now(), items: parse(await r.text()) };
}
function clean(items, hours) {
  const now = Date.now(), seen = new Set();
  return items.filter(i => {
    const k = i.h.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 6).join(" ");
    if (!i.h || !TRUSTED.test(i.s) || JUNK.test(i.h) || seen.has(k) || (i.t && now - i.t > hours * 3600e3)) return false;
    seen.add(k); return true;
  });
}
const pick = items => clean(items, 24).length ? clean(items, 24) : clean(items, 72);
async function news(url) {
  const P = url.searchParams, tick = (P.get("t") || "").toUpperCase().split(",").filter(x => /^[A-Z.]{1,6}$/.test(x)).slice(0, 3);
  const sport = (P.get("s") || "").replace(/[^\w &.-]/g, "").slice(0, 30), keys = (P.get("k") || "").split(",").filter(k => TOPICS[k]).slice(0, 4);
  const q = (query, label, topic) => feed(GN + "/search?q=" + encodeURIComponent(query + " when:1d") + "&" + LANG, 10800).then(f => ({ topic, label, at: f.at, item: pick(f.items || [])[0] || null })).catch(() => null);
  const [top, ...you] = await Promise.all([
    feed(GN + "/headlines/section/topic/BUSINESS?" + LANG, 7200).catch(() => ({ items: [] })),
    ...tick.map(t => q(t + " stock", t, "stocks")),
    ...(sport ? [q(sport, sport.toUpperCase().length <= 4 ? sport.toUpperCase() : sport, "sports")] : []),
    ...keys.map(k => q(TOPICS[k], k[0].toUpperCase() + k.slice(1), k)),
  ]);
  const T = pick(top.items || []);
  return { at: top.at || Date.now(), top: T[0] || null, ticker: T.filter(i => MOVERS.test(i.h)).slice(0, 5).concat(T).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5), you: you.filter(y => y && y.item) };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/news") {
      if (!ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
      try { return json(await news(url), 200, origin); } catch (e) { return json({ error: { type: "news_failed" } }, 502, origin); }
    }
    if (req.method !== "POST" || !ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
    const uid = await verify((req.headers.get("authorization") || "").replace(/^Bearer /, "")).catch(() => null);
    if (!uid) return json({ error: { type: "authentication_error", message: "Sign in again" } }, 401, origin);
    let body; try { body = await req.json(); } catch (e) { return json({ error: { type: "invalid_request_error" } }, 400, origin); }
    if (!MODELS.includes(body.model) || !Array.isArray(body.messages)) return json({ error: { type: "invalid_request_error", message: "model" } }, 400, origin);
    const cap = uid === env.OWNER_UID ? Number(env.OWNER_DAILY || 30) : Number(env.DAILY || 20);
    const day = new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10), k = uid + ":" + day;
    if (env.LIMITS) {
      const n = Number(await env.LIMITS.get(k)) || 0;
      if (n >= cap) return json({ error: { type: "daily_limit", message: "Daily limit reached" } }, 429, origin);
      await env.LIMITS.put(k, String(n + 1), { expirationTtl: 172800 });
    }
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: body.model, max_tokens: Math.min(Number(body.max_tokens) || 2048, 4096), messages: body.messages }) });
    return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", ...cors(origin) } });
  }
};
