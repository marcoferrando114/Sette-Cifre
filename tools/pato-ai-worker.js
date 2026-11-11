// Pato AI camera proxy + Pato Daily news (Cloudflare Worker). Keeps the Anthropic key on the server, lets in only signed-in Pato users.
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


// ---------- Pato Daily (Google News RSS + ESPN schedules, cached at Cloudflare's edge; one Haiku call per user per day for Pato's take) ----------
const GN = "https://news.google.com/rss", EN = "hl=en-US&gl=US&ceid=US:en", ES = "hl=es-419&gl=DO&ceid=DO:es-419";
const TRUSTED = /^(Reuters|Associated Press|AP News|CNBC|Bloomberg|Bloomberg\.com|Yahoo Finance|Yahoo|MarketWatch|The Wall Street Journal|WSJ|Financial Times|CNN|CNN Business|Business Insider|Barron's|Fox Business|Axios|The Verge|TechCrunch|Wired|Ars Technica|Engadget|CoinDesk|Cointelegraph|Decrypt|Forbes|ESPN|The Athletic|CBS Sports|NBC Sports|Yahoo Sports|Sports Illustrated|BBC|BBC News|The Guardian|NPR|The New York Times|The Washington Post|Politico|The Hill|NBC News|ABC News|CBS News|Al Jazeera|Variety|Billboard|Rolling Stone|The Hollywood Reporter|Deadline|IGN|Polygon|GameSpot|Kotaku|STAT|Healthline|Medical News Today|Car and Driver|MotorTrend|Road & Track|Top Gear|Vogue|GQ|Hypebeast|Highsnobiety|Business of Fashion|WWD|Elle|Diario Libre|Listín Diario|Listin Diario|El Día|El Dia|Hoy Digital|Periódico Hoy|N Digital|CDN|El Nuevo Diario|Noticias SIN|Acento|De Último Minuto|Diario Libre RD|PokerNews|Investopedia|Bloomberg Línea)$/i;
const JUNK = /\b(opinion|sponsored|\d+ (stocks?|ways|things|reasons|picks|best)|top \d+|best .{0,30} to buy|should you (buy|sell)|is it time to|buy now|before it'?s too late|millionaire|prediction:|could make you rich|live updates?|quiz|podcast|horoscope|deal alert|% off|coupon|review:)\b/i;
const MOVERS = /\b(fed|federal reserve|powell|rates?|inflation|cpi|jobs report|payrolls|s&p|nasdaq|dow|stocks?|wall street|bitcoin|crypto|dollar|earnings|oil|treasur(y|ies)|recession|tariffs?|ipo|market)\b/i;
const HUGE = /\b(dead|dies|died|killed|deaths?|crash(es|ed)?|earthquake|hurricane|tsunami|wildfire|flood|war|invasion|invades|attack|explosion|shooting|terror|ceasefire|assassinat|resigns|impeach|coup|elected|wins (the )?election|state of emergency|pandemic|outbreak)\b/i;
const sec = t => GN + "/headlines/section/topic/" + t + "?" + EN, srch = (q, l) => GN + "/search?q=" + encodeURIComponent(q + " when:1d") + "&" + (l || EN);
const CATS = {
  rd: GN + "?" + ES, business: sec("BUSINESS"), tech: sec("TECHNOLOGY"), politics: srch("politics OR Congress OR White House OR election"),
  crypto: srch("bitcoin OR ethereum OR crypto"), ent: sec("ENTERTAINMENT"), gaming: srch("video games OR PlayStation OR Xbox OR Nintendo OR esports"),
  health: sec("HEALTH"), cars: srch("cars OR Tesla OR Ferrari OR automaker OR Formula 1"), fashion: srch("luxury OR Rolex OR \"Patek Philippe\" OR \"Audemars Piguet\" OR Hermès OR \"Louis Vuitton\" OR Goyard OR sneakers OR streetwear"),
  poker: srch("poker WSOP OR \"World Series of Poker\" OR \"poker tournament\""), saving: srch("\"personal finance\" OR savings OR \"interest rates\""),
};
const LEAGUES = [["football/nfl", "NFL", 9], ["soccer/uefa.champions", "Champions League", 9], ["basketball/nba", "NBA", 8], ["mma/ufc", "UFC", 8], ["soccer/fifa.world", "World Cup", 10],
  ["soccer/esp.1", "LaLiga", 7], ["soccer/eng.1", "Premier League", 7], ["baseball/mlb", "MLB", 6], ["tennis/atp", "Tennis", 6], ["tennis/wta", "Tennis", 5], ["soccer/usa.1", "MLS", 4], ["hockey/nhl", "NHL", 4], ["football/college-football", "College football", 5], ["racing/f1", "F1", 6]];
const dec = t => t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").trim();
function parse(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const g = tag => { const r = m[1].match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">")); return r ? dec(r[1]) : ""; };
    const src = g("source"); let title = g("title"); if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    const desc = g("description"), cover = new Set([src, ...[...desc.matchAll(/<font[^>]*>([^<]+)<\/font>/g)].map(x => dec(x[1]))].filter(s => TRUSTED.test(s)));
    return { h: title, s: src, u: g("link"), t: Date.parse(g("pubDate")) || 0, n: cover.size, by: [...cover].slice(0, 3) };
  });
}
async function cached(url, ttl, kind) {
  const cache = caches.default, key = new Request(url);
  let r = await cache.match(key);
  if (!r) {
    const f = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; PatoDaily/1.0)" } });
    if (!f.ok) return { at: Date.now(), body: kind === "json" ? {} : "" };
    r = new Response(await f.text(), { headers: { "cache-control": "public, max-age=" + ttl, "x-at": String(Date.now()) } });
    await cache.put(key, r.clone());
  }
  const txt = await r.text(); let body = txt; if (kind === "json") { try { body = JSON.parse(txt); } catch (e) { body = {}; } }
  return { at: Number(r.headers.get("x-at")) || Date.now(), body };
}
const feed = (url, ttl) => cached(url, ttl).then(f => ({ at: f.at, items: parse(f.body) })).catch(() => ({ at: Date.now(), items: [] }));
function clean(items, hours) {
  const now = Date.now(), seen = new Set();
  return items.filter(i => {
    const k = i.h.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 6).join(" ");
    if (!i.h || !TRUSTED.test(i.s) || JUNK.test(i.h) || seen.has(k) || (i.t && now - i.t > hours * 3600e3)) return false;
    seen.add(k); return true;
  });
}
const pick = items => clean(items, 14);   // Marco: anything over 14h drops
const CO = { GOOGL: "google|alphabet", GOOG: "google|alphabet", NVDA: "nvidia", META: "meta|facebook|instagram|whatsapp", AVGO: "broadcom", AAPL: "apple|iphone", MSFT: "microsoft", AMZN: "amazon", TSLA: "tesla|musk", IBKR: "interactive brokers", AMD: "\\bamd\\b", TSM: "tsmc", NFLX: "netflix", VUAA: "s&p 500" };
// Importance: trusted outlets covering it x10 + freshness (0-14) + 25 if it names your stocks. 2nd story only if 5+ outlets or about you.
function top2(items, tick) {
  const now = Date.now(), me = new RegExp("\\b(" + tick.map(t => t.toLowerCase() + (CO[t] ? "|" + CO[t] : "")).join("|") + ")", "i");
  const a = pick(items).map(i => { const mine = tick.length ? me.test(i.h) : false; return Object.assign({}, i, { mine, sc: (i.n || 1) * 10 + Math.max(0, 14 - (now - i.t) / 36e5) + (mine ? 25 : 0) }); }).sort((x, y) => y.sc - x.sc);
  return a.slice(0, 1).concat(a.slice(1).filter(i => i.n >= 5 || i.mine).slice(0, 1));
}
const drDay = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10), edDay = () => new Date(Date.now() - 11 * 3600e3).toISOString().slice(0, 10); // edition starts 7am DR
async function games() {
  const d = drDay().replace(/-/g, ""), out = [];
  await Promise.all(LEAGUES.map(([path, name, w]) => cached("https://site.api.espn.com/apis/site/v2/sports/" + path + "/scoreboard?dates=" + d, 3600, "json").then(f => {
    (f.body.events || []).forEach(e => {
      const st = e.status && e.status.type && e.status.type.state; if (st === "post") return;
      const c = (e.competitions || [])[0] || {}, tv = (c.broadcasts || []).flatMap(b => b.names || []), note = ((c.notes || [])[0] || {}).headline || "";
      const ranked = (c.competitors || []).filter(x => x.curatedRank && x.curatedRank.current && x.curatedRank.current <= 10).length;
      const nat = tv.some(n => /ESPN|ABC|TNT|NBC|CBS|FOX|Prime|Netflix|Peacock|TBS|Paramount/i.test(n));
      out.push({ league: name, name: e.name || e.shortName, short: e.shortName, t: Date.parse(e.date) || 0, tv: tv.slice(0, 2), note, live: st === "in",
        score: w + (nat ? 2 : 0) + ranked + (/final|championship|playoff|semifinal|title|main event|derby|clasico|clásico/i.test(note + " " + e.name) ? 4 : 0) });
    });
  }).catch(() => null)));
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}
async function bundle(P) {
  const tick = (P.get("t") || "").toUpperCase().split(",").filter(x => /^[A-Z.]{1,6}$/.test(x)).slice(0, 5);
  const want = (P.get("k") || "rd,business,tech").split(",").filter(k => CATS[k]).slice(0, 8);
  const [top, world, ...rest] = await Promise.all([feed(sec("BUSINESS"), 7200), feed(sec("WORLD"), 3600),
    ...want.map(k => feed(CATS[k], 7200)), ...tick.map(t => feed(srch(t + " stock"), 10800)), P.get("g") === "0" ? Promise.resolve([]) : games()]);
  const cats = {}; want.forEach((k, i) => { const it = top2(rest[i].items || [], tick); if (it.length) cats[k] = it; });
  const stocks = {}; tick.forEach((t, i) => { const it = pick(rest[want.length + i].items || [])[0]; if (it) stocks[t] = it; });
  const WL = clean(world.items || [], 14), WH = WL.filter(i => i.n >= 3 && HUGE.test(i.h))[0];
  const W = WH ? Object.assign({}, WH, { huge: true }) : (WL.slice().sort((x, y) => (y.n || 0) - (x.n || 0))[0] || null);   // Big news every day; huge = red
  const T = pick(top.items || []);
  return { at: top.at || Date.now(), day: edDay(), big: W, cats, stocks, games: rest[rest.length - 1] || [],
    ticker: T.filter(i => MOVERS.test(i.h)).concat(T).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5) };
}
const TAKE = `You are Pato, the money buddy inside a finance app for young Dominicans. Write today's "Pato's take" for ONE user from the facts below.
Return ONLY JSON: {"happened":{"text":"","src":""},"you":{"text":"","src":""},"watch":{"text":"","src":""},"game":0,"rd":"","notes":{}}
Rules:
- happened: the one news story that matters most for this user's money today (their stocks first, then markets). src = the outlet name given.
- you: what it means for THEM using ONLY the numbers in USER. "Today" numbers come ONLY from TODAY_* fields. SINCE_BOUGHT_gainPct is the total gain since they bought; never call it today's move. If nothing moved much, say it was a quiet day and give their real total.TODAY change. src = "From your stocks" (or "From your bets").
- watch: one concrete thing coming up (an earnings date, a game they bet on, a Fed meeting) that appears in the facts. If none, a short useful money habit. src = outlet or "Pato".
- Never invent numbers, dates, or events. Never tell them to buy or sell. No emojis. Max 22 words per line. Plain, friendly English, like texting a smart friend.
- game: index (0-based) of the biggest match in GAMES for a young Dominican audience (stakes, stars, rivalry, playoffs; MLB/NBA/soccer stars from DR count extra). If the user has an open bet on one, prefer it unless another is clearly bigger. -1 if GAMES is empty.
- rd: the RD headline translated to short natural English (keep names), or "" if none.
- notes: for each key in CARDS, one line (max 14 words) on whether that story touches THIS user's money (their stocks, bets, savings in RD$). Be honest: if it doesn't, say so briefly ("No effect on your money today."). Never invent effects.`;
// Every number in "For you" must be one of the user's real numbers; otherwise use a plain line built from the numbers.
function check(out, body) {
  const today = new Set(), since = new Set(), other = new Set(), put = (S, v) => { if (typeof v === "number" && isFinite(v)) { const a = Math.abs(v); [0, 1, 2].forEach(d => S.add(a.toFixed(d))); } };
  (body.stocks || []).forEach(s => { put(today, s.TODAY_changeUsd); put(today, s.TODAY_changePct); put(since, s.SINCE_BOUGHT_gainPct); put(other, s.shares); });
  if (body.total) { put(today, body.total.TODAY_changeUsd); put(today, body.total.TODAY_changePct); }
  (body.bets || []).forEach(x => put(other, x.stakeRD));
  const t = out && out.you && out.you.text || "", says = /today/i.test(t), sinceWords = /since|bought|overall|in total|all.?time/i.test(t);
  const nums = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)].map(m => m[1].replace(/,/g, "")).filter(n => Number(n) > 1 && !/^(19|20)\d\d$/.test(n));
  const key = n => Number(n).toFixed(n.includes(".") ? Math.min(2, n.split(".")[1].length) : 0);
  const bad = nums.some(n => { const k = key(n); if (!today.has(k) && !since.has(k) && !other.has(k)) return true; return says && !sinceWords && since.has(k) && !today.has(k); });
  if (bad && body.total) { const u = body.total.TODAY_changeUsd, p = body.total.TODAY_changePct;
    out.you = { text: Math.abs(u) < 1 ? "Quiet day: your stocks barely moved." : "Your stocks are " + (u > 0 ? "up" : "down") + " US$" + Math.abs(u).toFixed(2) + " (" + Math.abs(p).toFixed(2) + "%) today.", src: "From your stocks" }; }
  return out;
}
async function take(env, uid, body, b) {
  const key = "daily2:" + uid + ":" + b.day;
  if (env.LIMITS) { const hit = await env.LIMITS.get(key); if (hit) return JSON.parse(hit); }
  const user = JSON.stringify({ stocks: (body.stocks || []).slice(0, 8), total: body.total || null, bets: (body.bets || []).slice(0, 8), currency: "USD for stocks, RD$ for bets" }).slice(0, 3000);
  const facts = JSON.stringify({ stockNews: b.stocks, marketTop: b.ticker.slice(0, 4).map(i => ({ h: i.h, s: i.s })), rd: b.cats.rd ? { h: b.cats.rd[0].h, s: b.cats.rd[0].s } : null,
    games: b.games.map(g => ({ league: g.league, name: g.name, note: g.note, tv: g.tv })),
    cards: Object.fromEntries(Object.entries(b.cats).concat(b.big ? [["big", b.big]] : []).map(([k, v]) => [k, Array.isArray(v) ? v[0].h : v.h])) }).slice(0, 6000);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 800, messages: [{ role: "user", content: TAKE + "\n\nUSER: " + user + "\n\nFACTS: " + facts + "\n\nGAMES are FACTS.games in order. CARDS are FACTS.cards." }] }) });
  if (!r.ok) return null;
  const j = await r.json(), txt = ((j.content || []).find(c => c.type === "text") || {}).text || "", m = txt.match(/\{[\s\S]*\}/);
  let out = null; try { out = JSON.parse(m[0]); } catch (e) { return null; }
  out = check(out, body);
  if (env.LIMITS) await env.LIMITS.put(key, JSON.stringify(out), { expirationTtl: 172800 });
  return out;
}

// Story photos (Nov 11): Bing News RSS finds the same story -> Bing's thumbnail, else the outlet's own preview photo (og:image).
// Honest user agent only; if an outlet refuses, try another outlet covering the story, else the page stays text-only.
const PUA = { "user-agent": "PatoDaily/1.0 (news link preview; +https://marcoferrando114.github.io/Sette-Cifre/)", "accept-language": "en-US,en;q=0.9,es;q=0.8" };
const BADIMG = /logo|default|placeholder|blank|favicon|sprite|\.svg(\?|$)|google\.com\/images|gstatic/i;
async function ogImg(src, log) {
  const r = await fetch(src, { headers: { ...PUA, accept: "text/html,*/*" }, redirect: "follow" });
  if (!r.ok) { log.push("article " + r.status + " (outlet refused)"); return ""; }
  const html = (await r.text()).slice(0, 400000);
  const meta = n => { const a = html.match(new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]*content=["\']([^"\']+)', "i")) || html.match(new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + n + '["\']', "i")); return a ? dec(a[1]) : ""; };
  let img = meta("og:image:secure_url") || meta("og:image") || meta("twitter:image") || meta("twitter:image:src");
  if (img) img = new URL(img, r.url || src).href.replace(/^http:/, "https:");
  log.push("article 200 img:" + (img ? img.slice(0, 60) : "none"));
  return img && !BADIMG.test(img) ? img : "";
}
// Bing News: find the same story (best headline match), then use the outlet's own photo, else Bing's thumbnail.
const words = t => String(t).toLowerCase().replace(/[^a-z0-9áéíóúñü ]/g, " ").split(/\s+/).filter(w => w.length > 3);
async function bingImg(h, log) {
  const r = await fetch("https://www.bing.com/news/search?q=" + encodeURIComponent(h.slice(0, 120)) + "&format=rss&setlang=en", { headers: { ...PUA, accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } }), x = await r.text();
  const items = [...x.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => { const g = t => { const a = m[1].match(new RegExp("<" + t + "[^>]*>([\\s\\S]*?)</" + t + ">", "i")); return a ? dec(a[1]) : ""; }; return { t: g("title"), l: g("link"), i: g("News:Image") }; });
  log.push("bing " + r.status + " " + (r.headers.get("content-type") || "").slice(0, 20) + " " + x.length + " items:" + items.length + " " + (items.length ? "" : x.slice(0, 60).replace(/\s+/g, " ")));
  const want = new Set(words(h)), score = it => words(it.t).filter(v => want.has(v)).length / Math.max(want.size, 1);
  const good = items.map(it => Object.assign(it, { sc: score(it) })).filter(it => it.sc >= 0.5).sort((x, y) => y.sc - x.sc);
  const th = good.find(it => it.i);   // Bing's own thumbnail for the story, if it has one
  if (th) { const u = th.i.replace(/^http:/, "https:"); if (!BADIMG.test(u)) return u + (u.includes("?") ? "&" : "?") + "w=800&h=450&c=7"; }
  for (const it of good.slice(0, 3)) {   // else the outlet's own preview photo, trying up to 3 outlets covering it
    const real = (() => { try { return new URL(it.l).searchParams.get("url") || it.l; } catch (e) { return it.l; } })();
    log.push("match " + it.sc.toFixed(2) + " " + real.slice(0, 60));
    try { const og = real && !/bing\.com/.test(real) ? await ogImg(real, log) : ""; if (og) return og; } catch (e) { log.push("og err " + e.message); }
  }
  if (!items.length) {   // got the web page instead of RSS: use its first news thumbnail
    const m = x.match(/\/th\?id=(OVFT\.[A-Za-z0-9_\-.]+)/); log.push("html thumb " + (m ? "yes" : "no"));
    if (m) return "https://www.bing.com/th?id=" + m[1] + "&w=800&h=450&c=7";
  }
  return "";
}
async function storyImg(u, h, debug) {
  const key = new Request("https://pato-img.cache/v4?u=" + encodeURIComponent(u)), hit = debug ? null : await caches.default.match(key);
  if (hit) return hit.json();
  const log = []; let img = "", src = "";
  if (h) { try { img = await bingImg(h, log); } catch (e) { log.push("bing err " + e.message); } }
  const out = { img };
  await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + (img ? 86400 : 3600) } }));
  return debug ? { img, src, log } : out;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/news") {
      if (!ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
      try { return json(await bundle(url.searchParams), 200, origin); } catch (e) { return json({ error: { type: "news_failed" } }, 502, origin); }
    }
    if (req.method === "GET" && url.pathname === "/img") {
      if (url.searchParams.get("debug") === "1") {   // test link: tries today's top world story and shows each step
        const w = (await feed(sec("WORLD"), 3600)).items.filter(i => TRUSTED.test(i.s))[0] || {};
        return json({ story: w.h || "", ...(await storyImg(w.u || "", w.h || "", true)) }, 200, origin);
      }
      if (!ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
      const u = url.searchParams.get("u") || "", h = (url.searchParams.get("h") || "").slice(0, 200);
      if (!/^https:\/\/news\.google\.com\//.test(u)) return json({ img: "" }, 200, origin);   // only our own story links
      return json(await storyImg(u, h), 200, origin);
    }
    if (req.method !== "POST" || !ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
    const uid = await verify((req.headers.get("authorization") || "").replace(/^Bearer /, "")).catch(() => null);
    if (!uid) return json({ error: { type: "authentication_error", message: "Sign in again" } }, 401, origin);
    let body; try { body = await req.json(); } catch (e) { return json({ error: { type: "invalid_request_error" } }, 400, origin); }
    if (url.pathname === "/daily") {
      try { const b = await bundle(url.searchParams); return json({ ...b, take: await take(env, uid, body, b).catch(() => null) }, 200, origin); }
      catch (e) { return json({ error: { type: "news_failed" } }, 502, origin); }
    }
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
