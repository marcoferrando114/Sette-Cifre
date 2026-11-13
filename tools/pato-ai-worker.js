// Pato AI camera proxy + Pato Daily news (Cloudflare Worker). Keeps the Anthropic key on the server, lets in only signed-in Pato users.
// Secrets/vars (Worker > Settings > Variables): ANTHROPIC_KEY (secret). Optional: DAILY (photos per person per day, default 20),
// OWNER_UID + OWNER_DAILY (default 30). Optional KV binding LIMITS for the daily counts.
const PROJECT = "stakd-3d1b9";
const ORIGINS = ["https://marcoferrando114.github.io"];
const MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"];
const JWKS = "https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com";
let jwks = null, jwksAt = 0;
// Cloudflare stops a request after 50 outside calls; a cold /news (12 feeds + ESPN + Polymarket) went over and came back nearly empty (Nov 12). Count them and keep news first.
let SUBN = 0; const xf = (u, o) => (++SUBN > 42 ? Promise.reject(new Error("budget")) : fetch(u, o));

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
const TRUSTED = /^(The Economist|The Atlantic|Foreign Affairs|Foreign Policy|Vox|MIT Technology Review|Harvard Business Review|The New Yorker|Noema|Reuters|Associated Press|The Associated Press|USA TODAY|USA Today|Yahoo News|Fortune|Newsweek|Sky News|The Independent|TIME|Time|Los Angeles Times|Investing\.com|AP News|CNBC|Bloomberg|Bloomberg\.com|Yahoo Finance|Yahoo|MarketWatch|The Wall Street Journal|WSJ|Financial Times|CNN|CNN Business|Business Insider|Barron's|Fox Business|Axios|The Verge|TechCrunch|Wired|Ars Technica|Engadget|CoinDesk|Cointelegraph|Decrypt|Forbes|ESPN|The Athletic|CBS Sports|NBC Sports|Yahoo Sports|Sports Illustrated|BBC|BBC News|The Guardian|NPR|The New York Times|The Washington Post|Politico|The Hill|NBC News|ABC News|CBS News|Al Jazeera|Variety|Billboard|Rolling Stone|The Hollywood Reporter|Deadline|IGN|Polygon|GameSpot|Kotaku|STAT|Healthline|Medical News Today|Car and Driver|MotorTrend|Road & Track|Top Gear|Vogue|GQ|Hypebeast|Highsnobiety|Business of Fashion|WWD|Elle|Diario Libre|Listín Diario|Listin Diario|El Día|El Dia|Hoy Digital|Periódico Hoy|N Digital|CDN|El Nuevo Diario|Noticias SIN|Acento|De Último Minuto|Diario Libre RD|PokerNews|Investopedia|Bloomberg Línea)$/i;
const BADSRC = /youtube|tiktok|reddit|instagram|facebook|\bx\.com|twitter|msn video|benzinga|motley fool|fool\.com|seeking alpha|zacks|gurufocus|stocktwits/i;
const JUNK = /(provides (business|corporate|operational) update|announces (date|timing) (of|for) (its )?(first|second|third|fourth)? ?quarter|stock analysis|big announcement|game plan revealed|my trading|trading plan|my portfolio|everything just changed|!\)|you won'?t believe|\?{2}|\bhere'?s why\b|\bwatch:)|\b(opinion|sponsored|\d+ (stocks?|ways|things|reasons|picks|best)|top \d+|best .{0,30} to buy|should you (buy|sell)|is it time to|buy now|before it'?s too late|millionaire|prediction:|could make you rich|live updates?|quiz|podcast|horoscope|deal alert|% off|coupon|review:)\b/i;
const MOVERS = /\b(fed|federal reserve|powell|rates?|inflation|cpi|jobs report|payrolls|s&p|nasdaq|dow|stocks?|wall street|bitcoin|crypto|dollar|earnings|oil|treasur(y|ies)|recession|tariffs?|ipo|market)\b/i;
const DRAMA = /\b(affair|scandal|fired|ousted|steps? down|resign(s|ed)?|lawsuit|sued|indicted|charged|arrested|probe|investigat|fraud|leak(ed)?|recall|bankrupt|layoffs?|misconduct|accused)\b/i;
const CALLS = /\b(upgrades?|upgraded|downgrades?|downgraded|price target|buy rating|top pick|outperform|overweight|analysts? (say|see|expect|bullish))\b/i;
const HUGE = /\b(dead|dies|died|killed|deaths?|crash(es|ed)?|earthquake|hurricane|tsunami|wildfire|flood|war|invasion|invades|attack|explosion|shooting|terror|ceasefire|assassinat|resigns|impeach|coup|elected|wins (the )?election|state of emergency|pandemic|outbreak|blackout|power outage|without (power|water)|evacuat\w*|prepare for|collaps(e|es|ed))\b/i;
// Marco's taste (Nov 12, his Instagram examples): AI changing jobs and big employers, DR politics and Haiti, luxury brands + star athletes, governments warning citizens. Boosts, never filters.
const TASTE = /\b(AI|artificial intelligence|OpenAI|ChatGPT|Anthropic|Claude|Gemini|automation|robots?)\b.{0,80}\b(jobs?|workers?|employees|workforce|hiring|layoffs?|train(s|ing)?|skills)\b|\b(jobs?|workers?|employees|workforce)\b.{0,80}\b(AI|artificial intelligence)\b|\b(Abinader|Bukele|Hait[ií]|Rep[uú]blica Dominicana|Dominican Republic|Punta Cana)\b|\b(Aman|Ritz|Four Seasons|LVMH|Rolex|Herm[eè]s|Louis Vuitton|Ferrari|luxury)\b.{0,80}\b(Djokovic|Ronaldo|Messi|LeBron|Jordan|Federer|Nadal|Alcaraz|Hamilton|Beckham|Curry|athlete|star)\b|\b(urges?|tells?|warns?) (citizens|residents|people|Canadians|Americans)\b|\b(raises?|raised|funding|Series [A-F]|valued at|valuation|unicorn|IPO)\b.{0,60}\$\d|\$\d[\d.,]*\s?(billion|million|bn|B|M)\b.{0,40}\b(valuation|round|raise)\b|\b(collaps(e|es|ed)|catastroph\w*|disaster|deadliest)\b|\b(Trump|Biden|Musk|Putin|Obama|president)\b.{0,70}\b(UFC|Dana White|NFL|NBA|FIFA|World Cup|Ronaldo|Messi|LeBron|Oscars?|Netflix|Hollywood|rapper|singer)\b|\b(UFC|Dana White|Ronaldo|Messi|LeBron|Beyonc[eé]|Taylor Swift|Drake)\b.{0,70}\b(Trump|Biden|Musk|White House|press secretary|president)\b|\b(Ronaldo|Messi|LeBron|Curry|Mbapp[eé]|Haaland|Djokovic|Alcaraz|Verstappen|Hamilton|Ohtani|Mahomes|Juan Soto|Vladimir Guerrero)\b.{0,60}\b(retires?|retirement|signs?|record|traded|transfer|contract|returns?|injur\w+)\b|\bnext (Nvidia|Google|Apple|Amazon|Tesla)\b|\b(AI chip|HBM|memory chip|semiconductor)s?\b.{0,60}\b(stocks?|companies|winners|rally)\b|\bshort(ed|s|ing)?\b.{0,40}\b(Nvidia|NVDA|Tesla|Google|Apple)\b|\b(Jensen Huang|Sundar Pichai|Mark Zuckerberg|Elon Musk|Hock Tan|Tim Cook|Satya Nadella)\b.{0,60}\b(wife|divorce|ties|resign\w*|downfall|affair|daughter|family)\b|\b(Polymarket|Kalshi|prediction market|betting odds|odds of)\b|\b(bans?|banned|banning|prohibits?|outlaws?)\b|\b(Burry|Buffett|Berkshire|Ackman|Dalio|Cathie Wood|Druckenmiller|Pelosi)\b.{0,60}\b(bets?|buys?|bought|sells?|sold|stake|bullish|bearish|shorts?|portfolio|13F)\b|\b(OpenAI|Anthropic|Google|Microsoft|Nvidia|Meta|Apple|Amazon)\b.{0,40}\b(acquires?|acquired|acquisition|buys?)\b|\b(study|research|survey|psychology|scientists?)\b.{0,70}\b(money|income|wealth|rich|millionaires?|salary|savings|spending|success|habits?|personality|happiness)\b|\b(money|income|wealth|rich|millionaires?|salary)\b.{0,50}\b(study|research|survey|psychology|changes? your|reveals?)\b/i;   // Nov 12 adds: hot startups + valuations, catastrophes, predictions, bans
const LOCAL = /^(Listín Diario|Listin Diario|Diario Libre|Noticias SIN|SIN|El Día|N Digital|CDN|Hoy)$/i, TOPDR = /^(Listín Diario|Listin Diario|Diario Libre|Noticias SIN|SIN)$/i;   // Marco Nov 12: Listín Diario, Diario Libre, Noticias SIN first
const sec = t => GN + "/headlines/section/topic/" + t + "?" + EN, srch = (q, l) => GN + "/search?q=" + encodeURIComponent(q + " when:1d") + "&" + (l || EN);
const CATS = {
  rd: GN + "?" + ES, business: sec("BUSINESS"), tech: sec("TECHNOLOGY"), politics: srch("politics OR Congress OR White House OR election"),
  crypto: srch("bitcoin OR ethereum OR crypto"), ent: sec("ENTERTAINMENT"), gaming: srch("video games OR PlayStation OR Xbox OR Nintendo OR esports"),
  health: sec("HEALTH"), cars: srch("cars OR Tesla OR Ferrari OR automaker OR Formula 1"), fashion: srch("luxury OR Rolex OR \"Patek Philippe\" OR \"Audemars Piguet\" OR Hermès OR \"Louis Vuitton\" OR Goyard OR sneakers OR streetwear OR \"luxury hotel\" OR Aman OR (athlete brand) OR Djokovic OR Ronaldo OR Messi OR LeBron"),
  poker: srch("poker WSOP OR \"World Series of Poker\" OR \"poker tournament\""), saving: srch("\"personal finance\" OR savings OR \"interest rates\""),
};
const LEAGUES = [["football/nfl", "NFL", 9], ["soccer/uefa.champions", "Champions League", 9], ["basketball/nba", "NBA", 8], ["mma/ufc", "UFC", 8], ["soccer/fifa.world", "World Cup", 10],
  ["soccer/esp.1", "LaLiga", 7], ["soccer/eng.1", "Premier League", 7], ["soccer/ita.1", "Serie A", 6], ["soccer/ger.1", "Bundesliga", 6], ["soccer/uefa.europa", "Europa League", 6], ["baseball/mlb", "MLB", 6], ["tennis/atp", "Tennis", 6], ["tennis/wta", "Tennis", 5], ["soccer/usa.1", "MLS", 5, /Inter Miami/i], ["soccer/fra.1", "Ligue 1", 7, /Paris Saint-Germain|\bPSG\b/i], ["baseball/dominican-winter-league", "LIDOM", 9], ["football/college-football", "College football", 5], ["racing/f1", "F1", 6]];
const dec = t => t.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16))).trim();
function parse(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const g = tag => { const r = m[1].match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">")); return r ? dec(r[1]) : ""; };
    const src = g("source"); let title = g("title"); if (src && title.endsWith(" - " + src)) title = title.slice(0, -(src.length + 3));
    const desc = g("description"), cover = new Set([src, ...[...desc.matchAll(/<font[^>]*>([^<]+)<\/font>/g)].map(x => dec(x[1]))].filter(s => TRUSTED.test(s)));
    const also = [...desc.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map(x => dec(x[1])).filter(t => t && t !== title).slice(0, 3);   // other outlets' headlines = extra facts for "What to know"
    return { h: title, s: src, u: g("link"), t: Date.parse(g("pubDate")) || 0, n: cover.size, by: [...cover].slice(0, 3), also };
  });
}
async function cached(url, ttl, kind, nocache) {
  const cache = caches.default, key = new Request(url);
  let r = nocache ? null : await cache.match(key);
  if (!r) {
    const f = await xf(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; PatoDaily/1.0)" } });
    if (!f.ok) return { at: Date.now(), body: kind === "json" ? {} : "" };
    r = new Response(await f.text(), { headers: { "cache-control": "public, max-age=" + ttl, "x-at": String(Date.now()) } });
    await cache.put(key, r.clone());
  }
  const txt = await r.text(); let body = txt; if (kind === "json") { try { body = JSON.parse(txt); } catch (e) { body = {}; } }
  return { at: Number(r.headers.get("x-at")) || Date.now(), body };
}
// Google News blocks Cloudflare (503/429) at times, so every feed falls back to Bing News RSS for the same topic (Nov 11).
const BQ = { BUSINESS: "business stock market economy", WORLD: "world news", TECHNOLOGY: "AI OR Apple OR Google OR Microsoft OR Nvidia OR OpenAI tech", ENTERTAINMENT: "Hollywood OR Netflix OR celebrity OR music OR movie", HEALTH: "health medicine" };
function bingUrl(url) {
  if (url === GN + "?" + ES) return "https://www.bing.com/news/search?q=" + encodeURIComponent("República Dominicana") + "&format=rss&setlang=es&cc=DO&count=40&qft=interval%3d%227%22&qft=sortbydate%3d%221%22";
  let q = ""; const m = url.match(/\/topic\/([A-Z]+)/); if (m) q = BQ[m[1]] || m[1].toLowerCase();
  else { try { q = (new URL(url).searchParams.get("q") || "").replace(/ when:\d+[dh]/, ""); } catch (e) {} }
  return q ? "https://www.bing.com/news/search?q=" + encodeURIComponent(q) + "&format=rss&setlang=en&cc=US&count=40&qft=sortbydate%3d%221%22" : "";
}
function parseBing(xml) {
  const it = [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const g = tag => { const r = m[1].match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i")); return r ? dec(r[1]) : ""; };
    const l = g("link"), u = (() => { try { return new URL(l).searchParams.get("url") || l; } catch (e) { return l; } })(), im = g("News:Image").replace(/^http:/, "https:");
    return { bing: 1, h: g("title"), s: g("News:Source"), d: g("description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 400), u, t: Date.parse(g("pubDate")) || 0, img: "" };   // Nov 12: Bing thumbnails are low quality; the app asks /img for the outlet's own photo instead
  }).filter(i => i.h && i.u);
  return it.map(i => { const w = new Set(words(i.h)), same = it.filter(j => j === i || words(j.h).filter(v => w.has(v)).length / Math.max(w.size, 1) >= 0.5);
    const by = [...new Set(same.map(j => j.s).filter(x => TRUSTED.test(x)))]; return Object.assign(i, { n: new Set(same.map(j => j.s).filter(Boolean)).size || 1, by: by.slice(0, 3), also: same.filter(j => j !== i).map(j => j.h).slice(0, 3) }); });
}
// Bing first (its stories come with a photo), Google News when Bing has nothing (Nov 11, Marco: photos on every story).
const gfeed = (url, ttl, nc) => cached(url, ttl, "", nc).then(f => ({ at: f.at, items: parse(f.body) })).catch(() => ({ at: Date.now(), items: [] }));
// Source memory (Marco Nov 12: "learn which news sites block you and don't go back"): Bing News and Google News are tried in order of what worked;
// a source that failed 3 times in a row is skipped for 6 hours (only used if the other one fails too). The cron saves what it learned in KV "hl1".
let HL = {}, HLdirty = false;
const blocked = k => { const x = HL[k]; return !!(x && x.fail >= 3 && Date.now() - x.last < 6 * 3600e3); };
const note = (k, ok) => { const x = HL[k] || (HL[k] = { ok: 0, fail: 0, last: 0 }); if (ok) { x.ok++; x.fail = 0; } else { x.fail++; x.last = Date.now(); } HLdirty = true; };
async function loadHL(env) { try { HL = (env && env.LIMITS && await env.LIMITS.get("hl1", "json")) || {}; } catch (e) { HL = {}; } HLdirty = false; }
async function saveHL(env) { if (HLdirty && env && env.LIMITS) { await env.LIMITS.put("hl1", JSON.stringify(HL)).catch(() => {}); HLdirty = false; } }
const feed = async (url, ttl, nc) => { const b = bingUrl(url), tryB = async () => { const r = await bingFeed(b, ttl, nc); const ok = pick(r.items).length > 0; note("bing", ok); return ok ? r : null; },
  tryG = async () => { const r = await gfeed(url, ttl, nc); const ok = pick(r.items).length > 0; note("google", ok); return ok ? r : null; };
  const order = !b ? [tryG] : blocked("bing") && !blocked("google") ? [tryG, tryB] : [tryB, tryG];
  for (const f of order) { const r = await f().catch(() => null); if (r) return r; } return { at: Date.now(), items: [] }; };
// Drops are prepared ahead (Marco Nov 12: "we need to be efficient"): the cron fetches every shared topic once before each drop and keeps it in KV; /news only reads it.
// If a source fails, the last good stories stay. Fresh for 200 min (drops are 3h apart), so a missed cron only means one live fetch.
const fkey = u => "fd2:" + u.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "").slice(-180);
async function kfeed(env, url, mins) {
  const kv = env && env.LIMITS; let old = null;
  if (kv) { try { old = await kv.get(fkey(url), "json"); } catch (e) {} if (old && Date.now() - old.at < mins * 6e4) return old; }
  const r = await feed(url, 7200).catch(() => ({ items: [] }));
  if (pick(r.items || []).length) { const v = { at: Date.now(), items: (r.items || []).slice(0, 30) }; if (kv) await kv.put(fkey(url), JSON.stringify(v), { expirationTtl: 172800 }).catch(() => {}); return v; }
  return old || r;
}
async function refreshFeed(env, url) { const r = await feed(url, 7200, true).catch(() => ({ items: [] })); if (env.LIMITS && pick(r.items || []).length) await env.LIMITS.put(fkey(url), JSON.stringify({ at: Date.now(), items: r.items.slice(0, 30) }), { expirationTtl: 172800 }); return (r.items || []).length; }
// Bing: one request at a time (bursts come back empty), only cache answers that have stories, retry once.
let bingQ = Promise.resolve();
const bingGet = u => (bingQ = bingQ.catch(() => {}).then(() => new Promise(r => setTimeout(r, 120))).then(() => xf(u, { headers: { ...PUA, accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } })).then(f => f.ok ? f.text() : ""));
async function bingFeed(u, ttl, nc) {
  const key = new Request(u + "&pv=2"), hit = nc ? null : await caches.default.match(key);
  if (hit) return { at: Number(hit.headers.get("x-at")) || Date.now(), items: parseBing(await hit.text()) };
  let x = await bingGet(u), items = parseBing(x);
  if (!items.length) { x = await bingGet(u); items = parseBing(x); }
  if (items.length) await caches.default.put(key, new Response(x, { headers: { "cache-control": "public, max-age=" + ttl, "x-at": String(Date.now()) } }));
  return { at: Date.now(), items };
}
function clean(items, hours) {
  const now = Date.now(), seen = new Set();
  return items.filter(i => {
    const k = i.h.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 6).join(" ");
    if (!i.h || i.h.trim().split(/\s+/).length < 4 || !(i.bing || TRUSTED.test(i.s)) || BADSRC.test(i.s || "") || JUNK.test(i.h) || seen.has(k) || (i.t && now - i.t > hours * 3600e3)) return false;
    seen.add(k); return true;
  });
}
const pick = items => clean(items, 14);   // Marco: anything over 14h drops
const CO = { GOOGL: "google|alphabet|pichai", GOOG: "google|alphabet|pichai", NVDA: "nvidia|jensen huang", META: "meta|facebook|instagram|whatsapp|zuckerberg", AVGO: "broadcom|hock tan", AAPL: "apple|iphone|tim cook", MSFT: "microsoft|nadella", AMZN: "amazon|jassy|bezos", TSLA: "tesla|musk", MU: "micron", IBKR: "interactive brokers", AMD: "\\bamd\\b", TSM: "tsmc", NFLX: "netflix", VUAA: "s&p 500" };
// Importance: trusted outlets covering it x10 + freshness (0-14) + 25 if it names your stocks. 2nd story only if 5+ outlets or about you.
function top2(items, tick, busy, like) {
  const now = Date.now(), me = new RegExp("\\b(" + tick.map(t => t.toLowerCase() + (CO[t] ? "|" + CO[t] : "")).join("|") + ")", "i");
  const a = pick(items).map(i => { const mine = tick.length ? me.test(i.h) : false; return Object.assign({}, i, { mine, sc: (i.n || 1) * 10 + Math.max(0, 14 - (now - i.t) / 36e5) + (mine ? 25 : 0) + (TASTE.test(i.h) ? 20 : 0) + (TOPDR.test(i.s || "") ? 18 : LOCAL.test(i.s || "") ? 8 : 0) + (like ? like(i.h) : 0) }); }).sort((x, y) => y.sc - x.sc);
  const w0 = a[0] ? new Set(words(a[0].h)) : new Set(), dup = i => words(i.h).filter(v => w0.has(v)).length / Math.max(w0.size, 1) >= 0.5;   // 2nd story must be a different story
  return a.slice(0, 1).concat(a.slice(1).filter(i => !dup(i) && (busy || i.n >= 5 || i.mine)).slice(0, 1));
}
const drDay = () => new Date(Date.now() - 4 * 3600e3).toISOString().slice(0, 10), edDay = () => new Date(Date.now() - 11 * 3600e3).toISOString().slice(0, 10); // edition starts 7am DR
async function games() {
  const d = drDay().replace(/-/g, ""), out = [];
  await Promise.all(LEAGUES.map(([path, name, w, only]) => cached("https://site.api.espn.com/apis/site/v2/sports/" + path + "/scoreboard?dates=" + d, 3600, "json").then(f => {
    (f.body.events || []).forEach(e => {
      if (only && !only.test(e.name || e.shortName || "")) return;   // Marco Nov 12: MLS = Inter Miami only, Ligue 1 = PSG only
      const st = e.status && e.status.type && e.status.type.state; if (st === "post") return;
      const c = (e.competitions || [])[0] || {}, tv = (c.broadcasts || []).flatMap(b => b.names || []), note = ((c.notes || [])[0] || {}).headline || "";
      const ranked = (c.competitors || []).filter(x => x.curatedRank && x.curatedRank.current && x.curatedRank.current <= 10).length;
      const nat = tv.some(n => /ESPN|ABC|TNT|NBC|CBS|FOX|Prime|Netflix|Peacock|TBS|Paramount/i.test(n));
      const teams = (c.competitors || []).slice().sort((x, y) => (x.homeAway === "away" ? -1 : 0) - (y.homeAway === "away" ? -1 : 0)).slice(0, 2).map(x => {
        const t = x.team || {}, a = x.athlete || {}, rec = ((x.records || [])[0] || {}).summary || "";
        return { n: t.shortDisplayName || t.displayName || a.shortName || a.displayName || "", ab: t.abbreviation || "", logo: t.logo || (a.flag && a.flag.href) || "", rec, score: st === "in" ? x.score || "" : "" }; });
      const o0 = (c.odds || [])[0];
      out.push({ path, id: e.id, ref: path + "|" + e.id, odds0: o0 ? { line: o0.details || "", ou: o0.overUnder || "", ml: [(o0.awayTeamOdds || {}).moneyLine, (o0.homeTeamOdds || {}).moneyLine], by: (o0.provider || {}).name || "" } : null, league: name, name: e.name || e.shortName, short: e.shortName, t: Date.parse(e.date) || 0, tv: tv.slice(0, 2), note, live: st === "in", teams,
        score: w + (nat ? 2 : 0) + ranked + (/final|championship|playoff|semifinal|title|main event|derby|clasico|clásico/i.test(note + " " + e.name) ? 4 : 0) });
    });
  }).catch(() => null)));
  const srt = out.sort((a, b) => b.score - a.score), seenL = new Set(), one = [], more = [];   // best game of each league first, so the day mixes sports (Marco Nov 11)
  srt.forEach(g => { if (seenL.has(g.league)) more.push(g); else { seenL.add(g.league); one.push(g); } });
  const top = one.concat(more).slice(0, 10);
  await Promise.all(top.slice(0, 5).map(g => gameInfo(g))); top.slice(5).forEach(g => { if (g.odds0) g.odds = { line: String(g.odds0.line || ""), ou: g.odds0.ou ? String(g.odds0.ou) : "", ml: [], by: g.odds0.by }; delete g.path; delete g.id; delete g.odds0; });   // all shown games get the full card (Marco Nov 11: odds, form, key players, injuries)   // injury report + starting lineups for the biggest games (Marco Nov 11)
  return top;
}
async function gameInfo(g) {
  try {
    const f = await cached("https://site.api.espn.com/apis/site/v2/sports/" + g.path + "/summary?event=" + g.id, 1800, "json"), b = f.body || {};
    const inj = (b.injuries || []).map(t => ({ team: (t.team || {}).shortDisplayName || (t.team || {}).displayName || "",
      out: (t.injuries || []).filter(i => /out|doubtful|questionable|day-to-day/i.test(i.status || "")).slice(0, 4).map(i => ({ n: ((i.athlete || {}).shortName || (i.athlete || {}).displayName || ""), st: i.status })) })).filter(t => t.team && t.out.length);
    const lu = (b.rosters || []).map(t => ({ team: (t.team || {}).shortDisplayName || (t.team || {}).displayName || "",
      xi: (t.roster || []).filter(r => r.starter).slice(0, 11).map(r => ((r.athlete || {}).shortName || (r.athlete || {}).displayName || "")) })).filter(t => t.team && t.xi.length);
    if (inj.length) g.inj = inj; if (lu.length) g.lineup = lu;
    // away team first everywhere, like g.teams
    const nm = x => ((x || {}).shortDisplayName || (x || {}).displayName || (x || {}).abbreviation || "");
    const ord = g.teams.map(t => t.n), side = n => { const i = ord.indexOf(n); return i < 0 ? 9 : i; };
    const pc = (b.pickcenter || [])[0], o = pc ? { line: pc.details || "", ou: pc.overUnder || "", ml: [(pc.awayTeamOdds || {}).moneyLine, (pc.homeTeamOdds || {}).moneyLine], by: (pc.provider || {}).name || "" } : g.odds0;
    if (o && (o.line || o.ou || o.ml.some(v => v != null))) g.odds = { line: String(o.line || ""), ou: o.ou ? String(o.ou) : "", ml: o.ml.map(v => v == null ? "" : (Number(v) > 0 ? "+" : "") + v), by: o.by };
    const pr = b.predictor || {}, pa = parseFloat((pr.awayTeam || {}).gameProjection), ph = parseFloat((pr.homeTeam || {}).gameProjection);
    if (isFinite(pa) && isFinite(ph) && pa + ph > 50) g.win = [Math.round(pa), Math.round(ph)];
    const form = (b.lastFiveGames || []).map(t => ({ team: nm(t.team), r: (t.events || []).slice(0, 5).map(e => (e.gameResult || "").charAt(0)).filter(Boolean).join("") })).filter(t => t.team && t.r).sort((x, y) => side(x.team) - side(y.team));
    if (form.length) g.form = form;
    const stars = (b.leaders || []).map(t => { const L = ((t.leaders || [])[0]) || {}, a = (L.leaders || [])[0]; return a && a.athlete ? { team: nm(t.team), n: a.athlete.shortName || a.athlete.displayName || "", v: a.displayValue || "", s: L.shortDisplayName || L.abbreviation || L.displayName || "" } : null; }).filter(x => x && x.n).sort((x, y) => side(x.team) - side(y.team));
    if (stars.length) g.stars = stars.slice(0, 2);
  } catch (e) {}
  if (!g.odds && g.odds0) g.odds = { line: String(g.odds0.line || ""), ou: g.odds0.ou ? String(g.odds0.ou) : "", ml: g.odds0.ml.map(v => v == null ? "" : (Number(v) > 0 ? "+" : "") + v), by: g.odds0.by };
  delete g.path; delete g.id; delete g.odds0;
}
// Pato's pick of the day (Marco Nov 12: "research, and decide based on history, odds and probability a recommendation... track Pato's percentage and his hit rate").
// One pick per DR day, locked the first time it's made (so the record is honest), graded from ESPN when the game ends. Shared by every user.
const impl = ml => { const m = parseFloat(ml); return !isFinite(m) || m === 0 ? null : m < 0 ? -m / (-m + 100) : 100 / (m + 100); };
function choosePick(G) {
  let best = null, seen = 0;
  (G || []).forEach(g => {
    if (!g.ref || !g.win || g.win.length !== 2 || !g.odds || !g.odds.ml || g.win[0] + g.win[1] < 97 || g.live || (g.t && g.t < Date.now())) return;
    const a = impl(g.odds.ml[0]), b = impl(g.odds.ml[1]); if (a == null || b == null) return; seen++;
    const P = [a / (a + b) * 100, b / (a + b) * 100];
    [0, 1].forEach(i => { const T = (g.teams || [])[i] || {}, f = (g.form || []).find(x => x.team === T.n), wn = f ? (f.r.match(/W/g) || []).length : null, e = g.win[i] - P[i], sc = e + (wn == null ? 0 : (wn - 2.5) * 1.5);
      if (e >= 3 && (wn == null || wn >= 2) && sc >= 4 && (!best || sc > best.sc)) best = { sc, side: i, team: T.n || "", ab: T.ab || "", ml: String(g.odds.ml[i]), w: g.win[i], p: Math.round(P[i]), edge: Math.round(e), form: f ? f.r : "", game: g.name || g.short || "", league: g.league, t: g.t, ref: g.ref }; });
  });
  return { best, seen };
}
async function patoPick(env, G) {
  if (!env.LIMITS) return null;
  const day = drDay(), k = "pk1:" + day; let log = JSON.parse((await env.LIMITS.get("pklog1")) || "[]"), today = JSON.parse((await env.LIMITS.get(k)) || "null"), dirty = false;
  if (!today) { const c = choosePick(G); if (c.best) { today = Object.assign({ day }, c.best); delete today.sc; await env.LIMITS.put(k, JSON.stringify(today), { expirationTtl: 172800 }); log = log.filter(x => x.day !== day).concat([today]).slice(-120); dirty = true; } else if (c.seen) today = { day, none: true, seen: c.seen }; }
  let n = 0; for (const x of log) {   // grade finished games (a few per call)
    if (x.res || !x.ref || !x.t || Date.now() - x.t < 2.5 * 3600e3 || n >= 4) continue; n++;
    const [path, id] = x.ref.split("|"), f = await cached("https://site.api.espn.com/apis/site/v2/sports/" + path + "/summary?event=" + id, 1800, "json").catch(() => null);
    const c = (((f && f.body && f.body.header) || {}).competitions || [])[0] || {}, done = c.status && c.status.type && c.status.type.completed;
    if (!done) { if (Date.now() - x.t > 4 * 864e5) { x.res = "void"; dirty = true; } continue; }
    const me = (c.competitors || []).find(t => t.homeAway === (x.side === 0 ? "away" : "home")), them = (c.competitors || []).find(t => t !== me);
    if (!me || !them) continue; const a = Number(me.score), b = Number(them.score);
    x.res = me.winner === true || a > b ? "won" : a === b ? "push" : "lost"; x.score = me.score + "-" + them.score; dirty = true;
  }
  if (dirty) await env.LIMITS.put("pklog1", JSON.stringify(log));
  const g = log.filter(x => x.res === "won" || x.res === "lost"), won = g.filter(x => x.res === "won").length;
  const units = g.reduce((u, x) => { const m = parseFloat(x.ml); return u + (x.res === "won" ? (m > 0 ? m / 100 : 100 / -m) : -1); }, 0);
  const last = log.filter(x => x.res && x.res !== "void" && x.day !== day).slice(-1)[0] || null;
  return { today, rec: { n: g.length, won, units: Math.round(units * 100) / 100 }, last: last ? { team: last.team, res: last.res, score: last.score || "", game: last.game } : null };
}
// Predictions (Marco Nov 12, picked "Predictions + odds in stories"): Polymarket's public market data, no key. Top markets for your world + the market line inside matching stories.
const PJ = s => { try { return Array.isArray(s) ? s : JSON.parse(s || "[]"); } catch (e) { return []; } };
async function kalshi() {
  const f = await xf("https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit=100", { headers: { "user-agent": "Mozilla/5.0 (compatible; PatoDaily/1.0)", accept: "application/json" } }).then(r => r.ok ? r.json() : {}).catch(() => ({})), ev = Array.isArray(f.events) ? f.events : [];
  const c = v => { const n = Number(v); return isFinite(n) ? n : null; }, px = m => { const d = c(m.last_price_dollars) != null ? c(m.last_price_dollars) * 100 : c(m.last_price); return d != null && d > 0 ? d : (c(m.yes_bid) || 0); };
  return ev.filter(e => e && !/sport/i.test(e.category || "") && !/^KXMVE/i.test(e.event_ticker || "") && !/[,]/.test(e.title || "")).map(e => { const ms = (e.markets || []).filter(m => m && /active|open/i.test(m.status || "active")); let best = null;
    ms.forEach(m => { const p = px(m); if (p > 0 && (!best || p > best.p)) best = { m, p }; });
    if (!best) return null; const m = best.m, prev = c(m.previous_price_dollars) != null ? c(m.previous_price_dollars) * 100 : c(m.previous_price);
    return { t: String(e.title || m.title || "").slice(0, 140), q: String((ms.length > 1 ? (m.yes_sub_title || m.subtitle || m.title) : (m.title || e.title)) || "").slice(0, 140), multi: ms.length > 1, p: Math.round(best.p), ch: prev ? Math.round(best.p - prev) : 0, end: String(m.close_time || m.expiration_time || "").slice(0, 10), vol: ms.reduce((a, x) => a + (c(x.volume_24h) || 0), 0), u: "https://kalshi.com/events/" + (e.event_ticker || ""), img: "", src: "Kalshi" }; }).filter(Boolean);
}
async function polymarket() {
  const f = await xf("https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=60", { headers: { "user-agent": "Mozilla/5.0 (compatible; PatoDaily/1.0)" } }).then(r => r.ok ? r.json() : []).catch(() => []), ev = Array.isArray(f) ? f : [];
  return ev.map(e => { const ms = (e.markets || []).filter(m => m && !m.closed && m.active !== false); let best = null;
    ms.forEach(m => { const o = PJ(m.outcomes), p = PJ(m.outcomePrices).map(Number), yi = o.findIndex(x => /^yes$/i.test(String(x))), py = yi >= 0 ? p[yi] : null; if (py == null || !isFinite(py)) return;
      if (!best || py > best.p) best = { q: ms.length > 1 ? (m.groupItemTitle || m.question || "") : (m.question || ""), p: py, ch: Number(m.oneDayPriceChange) || 0 }; });
    return best ? { t: String(e.title || best.q).slice(0, 140), q: String(best.q).slice(0, 140), multi: ms.length > 1, p: Math.round(best.p * 100), ch: Math.round(best.ch * 100), end: String(e.endDate || "").slice(0, 10), vol: Number(e.volume24hr) || 0, u: "https://polymarket.com/event/" + (e.slug || ""), img: e.image || e.icon || "" } : null; }).filter(Boolean);
}
const markets = async () => { const [a, b] = await Promise.all([polymarket().catch(() => []), kalshi().catch(() => [])]); return a.concat(b); };
const PWORLD = /\b(AI|OpenAI|Nvidia|Apple|Google|Microsoft|Amazon|Meta|Tesla|Musk|Fed|rates?|inflation|recession|S&P|Bitcoin|BTC|Ethereum|crypto|Trump|election|Congress|Senate|Dominican|Haiti|Abinader|Venezuela|Iran|China|NBA|NFL|MLB|Champions League|Premier League|World Cup|Super Bowl|Real Madrid|Barcelona|Yankees|Lakers)\b/i;
// Marco Nov 12: counting bets ("how many tweets will Elon post") tell you nothing; keep markets that explain what is happening
const PTRIVIA = /\b(tweets?|posts? on X|how many (times|tweets|posts|followers|views)|will \w+( \w+)? say\b|mention(s|ed)?\b|followers|subscribers|views|streams|box office|gross|top (song|artist|spotify)|spotify|youtube|tiktok|# of|number of (tweets|posts)|what price will|(bitcoin|btc|ethereum|ether|solana|xrp|dogecoin)\b[^?]{0,40}\b(hit|reach|dip|above|below|price))\b/i;
const okM = M => M.filter(m => !PTRIVIA.test(m.t + " " + m.q));
// Nov 12 (Marco): never two polls of the same kind at once (two Fed-rate questions), and Kalshi polls too
const MON = /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/gi;
const themeOf = m => { const t = String(m.t + " " + m.q); return /\b(Fed|FOMC|interest rates?|rate (cut|hike)|bps)\b/i.test(t) ? "fed" : /\b(bitcoin|btc|ethereum|crypto|solana|xrp)\b/i.test(t) ? "crypto" : String(m.t).toLowerCase().replace(MON, " ").replace(/[0-9]+|[^a-z ]/g, " ").replace(/\b(by|in|on|the|will|be|of|a|to|before|after|for|and)\b/g, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" "); };
function pickMarkets(M, tick) { M = okM(M); const me = tick.length ? new RegExp("\\b(" + tick.map(t => t + (CO[t] ? "|" + CO[t] : "")).join("|") + ")\\b", "i") : null;
  return M.filter(m => m.p >= 4 && m.p <= 96 && m.u.length > 30).map(m => Object.assign({}, m, { sc: Math.log10(m.vol + 10) + (PWORLD.test(m.t + " " + m.q) ? 3 : 0) + (me && me.test(m.t + " " + m.q) ? 4 : 0) + Math.min(3, Math.abs(m.ch) / 4) }))
    .sort((a, b) => b.sc - a.sc).filter((m, i, a) => a.findIndex(o => themeOf(o) === themeOf(m)) === i).reduce((acc, m, i, all) => { if (acc.length < 4) acc.push(m); else if (acc.length === 4 && !acc.some(x => x.src === "Kalshi")) { const k = all.find(x => x.src === "Kalshi"); if (k) acc[3] = k; acc.push(null); } return acc; }, []).filter(Boolean).slice(0, 4).map(m => { delete m.sc; return m; }); }
const GENERIC = new Set("this that with from have will what when where which after before about into over under their there these those been were your more most just only than then them they said says here also back next last first news report reports update after amid week year years today new latest says could would should might says plan plans deal deals shares stock stocks market markets price prices company companies people government president state states world global group bank banks year inside why how".split(" "));
const toks = t => [...new Set((String(t).match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).filter(x => !GENERIC.has(x.toLowerCase()) && (x.length >= 4 || /^(Fed|OPEC|NATO|SEC|FTC|IPO|ETF)$/.test(x))).map(x => x.toLowerCase()))];
// Nov 12 (Marco): "whenever a story can match a poll, do it": one distinctive shared name in the poll's TITLE is enough (Fed, Nvidia, Trump, Bitcoin...)
function marketFor(M, h) { if (!h) return null; M = okM(M); const w = new Set(toks(h)); if (w.size < 1) return null; let best = null, bs = 0;
  M.forEach(m => { if (!(m.p >= 3 && m.p <= 97)) return; const tt = new Set(toks(m.t)), tq = new Set(toks(m.q)), n = [...w].filter(x => tt.has(x) || tq.has(x)).length, nt = [...w].filter(x => tt.has(x)).length; if (!(n >= 2 || nt >= 1)) return; const sc = n * 10 + nt * 5 + Math.log10((m.vol || 0) + 10); if (sc > bs) { bs = sc; best = m; } });
  if (!best) return null; const by = /\bby\.{0,3}\??$/i.test(best.t), q = best.multi ? (by ? best.t.replace(/\bby\.{0,3}\??$/i, "by " + String(best.q).replace(/^by /i, "")).replace(/\?*$/, "?") : best.t.replace(/\?$/, "") + ": " + best.q) : best.q;
  return { q, p: best.p, end: best.end, u: best.u }; }
// Launches + Rising companies (Marco Nov 12: "product releases" and "underground companies before they break through"): big launches this week, startups raising at big valuations
const LAUNCH = /\b(launch(es|ed)?|unveil(s|ed)?|debuts?|introduc(es|ed)|releases?|rolls? out|now available|goes on sale|first look|announc(es|ed) (new|its))\b/i, NOTLAUNCH = /\b(missile|rocket attack|investigation|lawsuit|probe|campaign against|offensive|strikes?)\b/i;
const LBRAND = /\b(Apple|iPhone|iPad|Mac(Book)?|Google|Gemini|Pixel|Samsung|Galaxy|Nvidia|OpenAI|ChatGPT|Anthropic|Claude|Tesla|Meta|Instagram|WhatsApp|Microsoft|Xbox|Sony|PlayStation|Nintendo|Amazon|Netflix|Disney|Spotify|Ferrari|Porsche|BMW|Mercedes|Nike|Adidas|Rolex|Louis Vuitton|Herm[eè]s|xAI|Grok|Uber|Airbnb|Starlink|SpaceX)\b/;
const RAISE = /\b(rais(es|ed)|funding|valuation|valued at|series [a-f]|seed round|unicorn|backed|investors? pour|in talks to raise)\b/i, MONEY = /\$\s?\d[\d.,]*\s?(million|billion|bn|m|b|trillion)\b/i;
const BIGCO = /^(Apple|Google|Alphabet|Microsoft|Amazon|Meta|Nvidia|OpenAI|Anthropic|xAI|Tesla|Samsung|Sony|Nintendo|SoftBank)\b/;
const simw = (a, b) => { const A = new Set(words(a)), B = new Set(words(b)); return [...A].filter(w => B.has(w)).length / Math.max(Math.min(A.size, B.size), 1); };
const amt = s => { const m = String(s).match(/\$\s?(\d[\d.,]*)\s?(million|billion|bn|m|b|trillion)\b/i); if (!m) return 0; const v = parseFloat(m[1].replace(/,/g, "")), u = m[2].toLowerCase(); return v * (u[0] === "t" ? 1e12 : u[0] === "b" ? 1e9 : 1e6); };
function launches(items, tick) { const me = tick.length ? new RegExp("\\b(" + tick.map(t => t + (CO[t] ? "|" + CO[t] : "")).join("|") + ")\\b", "i") : null, now = Date.now(), out = [];
  clean(items, 72).filter(i => LAUNCH.test(i.h) && !NOTLAUNCH.test(i.h) && !HUGE.test(i.h) && (LBRAND.test(i.h) || (me && me.test(i.h)))).map(i => Object.assign({}, i, { mine: !!(me && me.test(i.h)), sc: (i.n || 1) * 10 + Math.max(0, 24 - (now - i.t) / 36e5) / 2 + (me && me.test(i.h) ? 20 : 0) + (TASTE.test(i.h) ? 6 : 0) }))
    .sort((a, b) => b.sc - a.sc).forEach(i => { if (out.length < 4 && !out.some(o => simw(o.h, i.h) >= 0.5)) out.push({ h: i.h, s: i.s, u: i.u, t: i.t, n: i.n, d: i.d || "", mine: i.mine }); });
  return out; }
function rising(items) { const now = Date.now(), out = [];
  clean(items, 72).filter(i => RAISE.test(i.h) && MONEY.test(i.h) && !BIGCO.test(i.h) && !/\b(fund (closes|raises)|ETF|bond|IPO priced|government|city|county|charity)\b/i.test(i.h)).map(i => {
    const h = i.h, v = h.match(/(?:valu(?:ed|ation) (?:at|of)|at a|\bto)\s+(\$\s?\d[\d.,]*\s?(?:million|billion|bn|m|b|trillion))/i) || h.match(/(\$\s?\d[\d.,]*\s?(?:million|billion|bn|m|b|trillion))\s+valuation/i), r = h.match(/(?:rais(?:es|ed)|secures?|lands?|closes?|nabs?|gets?)\s+(\$\s?\d[\d.,]*\s?(?:million|billion|bn|m|b|trillion))/i);
    const val = v ? v[1].replace(/\s+/g, " ") : "", raised = r ? r[1].replace(/\s+/g, " ") : "", co = (h.match(/^([A-Z][\w.&'-]*(?:\s[A-Z][\w.&'-]*){0,2})(?=,|\s(?:raises|raised|secures|lands|closes|nabs|gets|is|hits|valued|in talks|seeks|reaches|doubles|triples))/) || [])[1] || "";
    // Pills must add what the headline doesn't say (Marco Nov 12): sector, round, who backed it, share of the company sold; numbers from other outlets' headlines or the snippet
    const X = [h].concat(i.also || [], i.d || "").join(" . "), V2 = val || ((X.match(/(?:valu(?:ed|ation) (?:at|of)|at a)\s+(\$\s?\d[\d.,]*\s?(?:million|billion|bn|m|b|trillion))/i) || X.match(/(\$\s?\d[\d.,]*\s?(?:million|billion|bn|m|b|trillion))\s+valuation/i) || [])[1] || ""), R2 = raised || ((X.match(/(?:rais(?:es|ed|ing)|secures?|lands?|closes?)\s+(\$\s?\d[\d.,]*\s?(?:million|billion|bn|m|b|trillion))/i) || [])[1] || "");
    const stage = ((X.match(/\b(Series [A-F]|seed round|pre-seed)\b/i) || [])[1] || "").replace(/^series/i, "Series").replace(/^seed round$/i, "Seed").replace(/^pre-seed$/i, "Pre-seed");
    const lead = ((X.match(/\b(?:led by|backed by|from investors? (?:including|like))\s+([A-Z][\w&.'-]*(?:\s(?:[A-Z][\w&.'-]*|&|of)){0,3})/) || [])[1] || "").replace(/[.,]+$/, "").replace(/\s(and|with|of)$/, "");
    const SECT = [[/\b(AI|artificial intelligence|LLM|chatbot|agents?)\b/i, "AI"], [/\brobot/i, "Robotics"], [/\b(defen[cs]e|military|drones?)\b/i, "Defense"], [/\b(space|satellite|rocket)\b/i, "Space"], [/\b(chips?|semiconductor)\b/i, "Chips"], [/\b(fintech|payments?|bank(ing)?|stablecoin)\b/i, "Fintech"], [/\b(crypto|bitcoin|blockchain)\b/i, "Crypto"], [/\b(biotech|health|drug|medical)\b/i, "Health"], [/\b(energy|nuclear|fusion|battery|solar)\b/i, "Energy"], [/\b(coding|software|cloud|cyber\w*)\b/i, "Software"]];
    const sector = SECT.filter(([re]) => re.test(X) && !re.test(h)).map(([, n]) => n).slice(0, 2).join(" · "), pct = amt(R2) && amt(V2) > amt(R2) ? Math.round(amt(R2) / amt(V2) * 100) : 0;
    const hl = h.toLowerCase(), pills = [sector, stage && !hl.includes(stage.toLowerCase()) ? stage : "", lead && !hl.includes(lead.toLowerCase()) ? "Backed by " + lead : "",
      V2 && !val ? "Valued " + V2 : "", R2 && !raised ? "Raised " + R2 : "", pct >= 1 && pct <= 60 ? "Sold ~" + pct + "% of the company" : ""].filter(Boolean).slice(0, 3);
    return Object.assign({}, i, { co, val, raised, pills, sc: Math.log10(Math.max(amt(val), amt(raised), 1)) * 4 + (i.n || 1) * 6 + Math.max(0, 24 - (now - i.t) / 36e5) / 3 + (val ? 6 : 0) + (/\b(AI|robot|quantum|defense|space|fintech|crypto|chips?)\b/i.test(h) ? 4 : 0) }); })
    .sort((a, b) => b.sc - a.sc).forEach(i => { if (out.length < 4 && !out.some(o => (o.co && o.co === i.co) || simw(o.h, i.h) >= 0.5)) out.push({ h: i.h, s: i.s, u: i.u, t: i.t, n: i.n, d: i.d || "", co: i.co, val: i.val, raised: i.raised, pills: i.pills }); });
  return out; }
const LQ = srch("(launches OR unveils OR debuts OR \"release date\" OR \"now available\") (Apple OR Google OR Samsung OR Nvidia OR OpenAI OR Tesla OR Meta OR Microsoft OR Sony OR Nintendo OR Anthropic OR Amazon OR Ferrari OR Nike OR iPhone OR PlayStation)").replace(" when:1d", " when:3d").replace("when%3A1d", "when%3A3d");
const RQ = srch("startup (raises OR \"valued at\" OR valuation OR \"funding round\" OR \"Series A\" OR \"Series B\" OR \"Series C\" OR unicorn OR \"teen founders\" OR \"student founders\" OR \"year-old founder\" OR \"young founders\")").replace("when%3A1d", "when%3A3d");
// Games and predictions are the same for everyone: keep one copy in KV (20/30 min) so a /news call doesn't redo ~25 outside calls or parse Polymarket's 18 MB list each time (Nov 12)
async function kvFresh(env, key, mins, make) {
  const kv = env && env.LIMITS; let old = null;
  if (kv) { try { old = await kv.get(key, "json"); } catch (e) {} if (old && Date.now() - old.at < mins * 6e4) return old.v; }
  const v = await make().catch(() => null);
  if (v && v.length) { if (kv) await kv.put(key, JSON.stringify({ at: Date.now(), v }), { expirationTtl: 86400 }).catch(() => {}); return v; }
  return old ? old.v : [];
}
const AQ = srch("analysts upgrade stock buy rating");
// The shared topics every drop needs (same for all users); the cron splits them in two runs before each drop
// Deep reads (Marco Nov 12: Economist-style explainers, "not exactly news"): one per drop, shown inside the matching topic tab (no new tab).
// Read straight from each outlet's own RSS (the news search could not find them), kept 200 min in KV (dp2), prepared by the cron before each drop.
const DFEEDS = [["https://www.economist.com/briefing/rss.xml", "The Economist"], ["https://www.economist.com/finance-and-economics/rss.xml", "The Economist"], ["https://www.economist.com/international/rss.xml", "The Economist"], ["https://www.foreignaffairs.com/rss.xml", "Foreign Affairs"], ["https://www.wired.com/feed/rss", "Wired"], ["https://www.technologyreview.com/feed/", "MIT Technology Review"], ["https://www.theguardian.com/news/series/the-long-read/rss", "The Guardian"]];
async function deepAll(env, force) {
  const kv = env && env.LIMITS; let old = null;
  if (kv) { try { old = await kv.get("dp2", "json"); } catch (e) { old = null; } if (old && !force && Date.now() - old.at < 200 * 6e4) return old.items || []; }
  const got = await Promise.all(DFEEDS.map(async ([u, s]) => { try { const r = await xf(u, { headers: { ...PUA, accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" } }); if (!r.ok) return []; return parse(await r.text()).slice(0, 12).map(i => Object.assign(i, { s })); } catch (e) { return []; } }));
  const items = got.flat().filter(i => i.h && i.t);
  if (items.length) { if (kv) await kv.put("dp2", JSON.stringify({ at: Date.now(), items }), { expirationTtl: 172800 }).catch(() => {}); return items; }
  return old ? old.items || [] : [];
}
const DEEPSRC = /^(The Economist|The Atlantic|Foreign Affairs|Foreign Policy|Vox|MIT Technology Review|Harvard Business Review|The New Yorker|Noema|Financial Times|Bloomberg|The Wall Street Journal|WSJ|The New York Times|The Washington Post|BBC|The Guardian|Reuters|Wired|TIME|Time|Fortune|Axios)/;
const DEEPH = /\b(why|how|inside|study|reveals?|explained|explainer|analysis|what .{0,25} means|behind|long read|deep dive|the (rise|fall|race|problem|truth|case|real|end|future))\b|:\s|\?$/i;
const SHARED = () => [sec("BUSINESS"), sec("WORLD"), ...Object.values(CATS), AQ, LQ, RQ];
async function bundle(P, env) {
  const tick = (P.get("t") || "").toUpperCase().split(",").filter(x => /^[A-Z.]{1,6}$/.test(x)).slice(0, 5);
  const wl = k => (P.get(k) || "").split(",").map(v => v.trim().toLowerCase()).filter(v => /^[a-z0-9]{3,20}$/.test(v)).slice(0, 8), LK = wl("lk"), DK = wl("dk");   // Nov 12: words you 👍/👎 (sent by the app, nothing stored here)
  const lk = h => { const t = String(h || "").toLowerCase(); let s = 0; LK.forEach(v => { if (new RegExp("\\b" + v + "\\b").test(t)) s += 9; }); DK.forEach(v => { if (new RegExp("\\b" + v + "\\b").test(t)) s -= 14; }); return s; };
  const want = (P.get("k") || "rd,business,tech").split(",").filter(k => CATS[k]).slice(0, 8);
  const [top, world, ...rest] = await Promise.all([kfeed(env, sec("BUSINESS"), 200), kfeed(env, sec("WORLD"), 75),
    ...want.map(k => kfeed(env, CATS[k], 200)), ...tick.map(t => kfeed(env, srch(t + " stock"), 180)), kfeed(env, AQ, 200)]);
  const N1 = SUBN;
  const [LF, RF, DFI] = await Promise.all([kfeed(env, LQ, 200), kfeed(env, RQ, 200), deepAll(env)]);
  const [MK, GM] = await Promise.all([kvFresh(env, "mk2", 90, markets), P.get("g") === "0" ? Promise.resolve([]) : kvFresh(env, "gm2:" + drDay(), 60, games)]); rest.push(GM); const N2 = SUBN;
  const stocks = {}; tick.forEach((t, i) => { const it = pick(rest[want.length + i].items || [])[0]; if (it) stocks[t] = it; });
  // Breaking (Marco Nov 11): the story that matters most to YOU today: big world events, scandals about the people behind your companies, major accidents, analyst calls on your stocks.
  const WL = clean(world.items || [], 14), me = tick.length ? new RegExp("\\b(" + tick.map(t => t.toLowerCase() + (CO[t] ? "|" + CO[t] : "")).join("|") + ")", "i") : null, now = Date.now();
  const pool = WL.concat(pick(top.items || []), ...tick.map((t, i) => pick(rest[want.length + i].items || []).slice(0, 3)));
  const bs = i => (i.n || 1) * 10 + Math.max(0, 14 - (now - i.t) / 36e5) + (HUGE.test(i.h) ? 25 : 0) + (DRAMA.test(i.h) ? 18 : 0) + (me && me.test(i.h) ? 30 : 0) + (CALLS.test(i.h) && me && me.test(i.h) ? 10 : 0) + (TASTE.test(i.h) ? 12 : 0) + lk(i.h);
  const B = pool.filter(i => i && i.h).sort((x, y) => bs(y) - bs(x))[0] || null;
  const W = B ? Object.assign({}, B, { huge: (B.n || 0) >= 3 && HUGE.test(B.h), mine: !!(me && me.test(B.h)) }) : null;
  const CL = pick(rest[want.length + tick.length].items || []).filter(i => CALLS.test(i.h)).map(i => Object.assign({}, i, { mine: !!(me && me.test(i.h)) })).sort((x, y) => (y.mine - x.mine) || ((y.n || 1) - (x.n || 1)))[0] || null;
  const T = pick(top.items || []);
  // "More from the world" (Marco Nov 12: every drop has at least 2 new stories; "find the biggest recent story you can"): next-biggest stories worldwide
  const bw = B ? new Set(words(B.h)) : new Set(); let MORE = pool.filter(i => i && i.h && i !== B && words(i.h).filter(v => bw.has(v)).length / Math.max(bw.size, 1) < 0.5).sort((x, y) => bs(y) - bs(x))
    .filter((v, i, a) => a.findIndex(o => o.h === v.h || words(o.h).filter(w => new Set(words(v.h)).has(w)).length / Math.max(words(v.h).length, 1) >= 0.5) === i).slice(0, 10)
    .map(i => ({ h: i.h, s: i.s, u: i.u, t: i.t, n: i.n, by: i.by, d: i.d || "" }));
  // one story, one slide (Nov 12: the Nvidia CEO story filled Breaking, Tech, Politics and World at once)
  const CAPS = t => new Set((String(t).replace(/['’]s\b/g, "").match(/\b[A-Z][a-zA-Z]{2,}\b/g) || []).filter(w => !/^(The|And|For|With|After|Over|Says?|New|How|What|Why|Its|This|That|From|Into|Amid|CEO|Stock|Stocks)$/.test(w)));
  const EVT = /\b(resign\w*|oust\w*|affair|scandal|spy|fired|steps? down|probe|indict\w*|arrest\w*|crash\w*|quake|earthquake|hurricane|collaps\w*|plunge\w*|drops?|falls?|tumbl\w*|sinks?|soar\w*|surg\w*|jumps?|ceasefire|attack\w*|explosion|shooting|out at)\b/i;
  const same = (a, b) => { if (!a || !b) return false; if (simw(a, b) >= 0.5) return true; const A = CAPS(a), B = CAPS(b), n = [...A].filter(w => B.has(w)).length; return n >= 2 || (n >= 1 && EVT.test(a) && EVT.test(b)); };   // same name + both about an event = same story
  // Nov 12 fix: skip stories already shown BEFORE ranking, so a category falls back to its next-best story instead of disappearing
  const shown = W ? [W.h] : [], cats = {}; want.forEach((k, i) => { const it = top2((rest[i].items || []).filter(x => x && x.h && !shown.some(h => same(h, x.h))), tick, P.get("busy") === "1", lk); if (it.length) { cats[k] = it; it.forEach(x => shown.push(x.h)); } });
  MORE = MORE.filter(it => !shown.some(h => same(h, it.h)));
  { const dsc = i => (/Economist|Foreign Affairs|MIT Technology/.test(i.s) ? 10 : 0) + (/\b(AI|econom\w*|market\w*|China|debt|bond|invest\w*|money|tech\w*|chips?|bank\w*|trade|tariffs?|inflation|rates?|startups?|oil|war|Trump|billionaires?|wealth)\b/i.test(i.h) ? 8 : 0) + (TASTE.test(i.h) ? 12 : 0) + lk(i.h);   // what Marco likes first, hard reads from the best outlets
    const cs = clean(DFI || [], 96).filter(i => DEEPSRC.test(i.s || "") && DEEPH.test(i.h) && !/\b(stocks?|shares|earnings|futures|Dow|Nasdaq|S&P)\b.{0,30}\b(rise|fall|jump|slide|drop|gain|close)/i.test(i.h) && !shown.some(h => same(h, i.h))).sort((x, y) => dsc(y) - dsc(x) || y.t - x.t).slice(0, 6);
    const dp = cs.length ? cs[Math.floor(Date.now() / 108e5) % cs.length] : null;   // a different one each 3-hour drop
    if (dp) { const pk = /\b(AI|chips?|Nvidia|OpenAI|tech|software|robots?|startups?)\b/i.test(dp.h) && cats.tech ? "tech" : /\b(econom\w*|market|inflation|debt|trade|bank|spend\w*|tariffs?|fiscal|budget|wages?|jobs?)\b/i.test(dp.h) && cats.business ? "business" : ["politics", "business", "tech", "rd"].concat(Object.keys(cats)).find(k => cats[k]);
      if (pk) { cats[pk].splice(1, 0, Object.assign({}, dp, { deep: 1 })); shown.push(dp.h); } } }
  if (W) W.mk = marketFor(MK, W.h); Object.keys(cats).forEach(k => { const it = cats[k][0]; if (it) it.mk = marketFor(MK, it.h); });
  { const cand = [W].concat(Object.keys(cats).map(k => cats[k][0])).filter(it => it && it.mk), used = new Set(); let kept = 0;   // Nov 12 (Marco): polls inside stories only sometimes, so nobody gets tired of them: at most 2 per edition, never the same poll twice
    cand.forEach(it => { if (kept >= 2 || used.has(it.mk.u)) delete it.mk; else { kept++; used.add(it.mk.u); } }); }
  return { at: top.at || Date.now(), day: edDay(), big: W, calls: CL, more: MORE, preds: pickMarkets(MK, tick), launch: launches(LF.items || [], tick), rising: rising(RF.items || []), cats, stocks, games: rest[rest.length - 1] || [],
    _n: [N1, N2, MK.length, (GM || []).length], ticker: T.filter(i => MOVERS.test(i.h)).concat(T).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5) };
}
const TAKE = `You are Pato, the money buddy inside a finance app for young Dominicans. Write today's "Pato's take" for ONE user from the facts below.
Return ONLY JSON: {"pato":{"line":"","tip":""},"happened":{"text":"","src":""},"you":{"text":"","src":""},"watch":{"text":"","src":""},"game":0,"rd":"","notes":{},"know":{}}
Rules:
- pato: the heart of the app. Pato (a duck who is the user's sharp, warm money friend) talks straight to THEM. line = ONE memorable sentence (max 32 words) that shows Pato really knows their money and teaches them something. Pato covers their WHOLE financial life, not only stocks: savings vs goal, spending pace vs limit, money lent out and what comes back (money.lentOutRD, backOwedRD, lateLoans), bets record (money.betsWon/betsLost), portfolio concentration (stocks[].weightPct), and lessons from today's news in FACTS (e.g. AI changing jobs = invest in your skills; a rate move = what it does to savings; a crisis = why an emergency fund matters). USER.angle names today's preferred angle: use it if its data exists, otherwise pick the most interesting one. Connect their real numbers into an insight or real financial / general knowledge they would not notice alone (concentration risk, compounding, cost averaging, emergency fund, the real cost of a habit, the house edge in betting, the risk of lending). NEVER just recap today's gain or loss. tip = ONE specific, well-thought move for the next days, with a number from USER (e.g. a daily spending amount, a saving target, skipping a bet). Never tell them to buy or sell a specific stock or bet. Use ONLY numbers that appear in USER (you may round). Skip any data that is missing. Sound human, a little witty, never preachy. No emojis. Clarity first (Marco Nov 12: great advice must be explained better): short sentences, correct commas and periods, no semicolons or dashes, say the idea first and then why it matters in plain words a 20-year-old gets on first read.
- happened: the one news story that matters most for this user's money today (their stocks first, then markets). src = the outlet name given.
- you: what it means for THEM using ONLY the numbers in USER. "Today" numbers come ONLY from TODAY_* fields. SINCE_BOUGHT_gainPct is the total gain since they bought; never call it today's move. If nothing moved much, say it was a quiet day and give their real total.TODAY change. src = "From your stocks" (or "From your bets").
- watch: one concrete thing coming up (an earnings date, a game they bet on, a Fed meeting) that appears in the facts. If none, a short useful money habit. src = outlet or "Pato".
- Never invent numbers, dates, or events. Never tell them to buy or sell. No emojis. Max 22 words per line. Plain, friendly English, like texting a smart friend.
- game: index (0-based) of the biggest match in GAMES for a young Dominican audience (stakes, stars, rivalry, playoffs; MLB/NBA/soccer stars from DR count extra). If the user has an open bet on one, prefer it unless another is clearly bigger. -1 if GAMES is empty.
- rd: the RD headline translated to short natural English (keep names), or "" if none.
- notes: for each key in CARDS, one line (max 14 words) on whether that story touches THIS user's money (their stocks, bets, savings in RD$). Be honest: if it doesn't, say so briefly ("No effect on your money today."). Never invent effects.
- know: for each key in CARDS, exactly 2 short lines (max 16 words each) a young reader needs to get the story: line 1 = what happened in plain words, line 2 = why it matters or the context. Use ONLY facts in that card's h and also headlines plus widely known background (who a famous person or company is). Never invent numbers, names, quotes, or outcomes. English even if the headline is Spanish.`;
// Every number in "For you" must be one of the user's real numbers; otherwise use a plain line built from the numbers.
function check(out, body) {
  const today = new Set(), since = new Set(), other = new Set(), put = (S, v) => { if (typeof v === "number" && isFinite(v)) { const a = Math.abs(v); [0, 1, 2].forEach(d => S.add(a.toFixed(d))); } };
  (body.stocks || []).forEach(s => { put(today, s.TODAY_changeUsd); put(today, s.TODAY_changePct); put(since, s.SINCE_BOUGHT_gainPct); put(other, s.shares); put(other, s.weightPct); });
  if (body.total) { put(today, body.total.TODAY_changeUsd); put(today, body.total.TODAY_changePct); }
  (body.bets || []).forEach(x => put(other, x.stakeRD));
  const t = out && out.you && out.you.text || "", says = /today/i.test(t), sinceWords = /since|bought|overall|in total|all.?time/i.test(t);
  const nums = [...t.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)].map(m => m[1].replace(/,/g, "")).filter(n => Number(n) > 1 && !/^(19|20)\d\d$/.test(n));
  const key = n => Number(n).toFixed(n.includes(".") ? Math.min(2, n.split(".")[1].length) : 0);
  const bad = nums.some(n => { const k = key(n); if (!today.has(k) && !since.has(k) && !other.has(k)) return true; return says && !sinceWords && since.has(k) && !today.has(k); });
  if (bad && body.total) { const u = body.total.TODAY_changeUsd, p = body.total.TODAY_changePct;
    out.you = { text: Math.abs(u) < 1 ? "Quiet day: your stocks barely moved." : "Your stocks are " + (u > 0 ? "up" : "down") + " US$" + Math.abs(u).toFixed(2) + " (" + Math.abs(p).toFixed(2) + "%) today.", src: "From your stocks" }; }
  const pt = out && out.pato ? (out.pato.line || "") + " " + (out.pato.tip || "") : "", all = new Set([...today, ...since, ...other]); put(all, 0);
  const mny = body.money || {}; Object.values(mny).forEach(v => { if (typeof v === "number") [v, v / 1000].forEach(x => { put(all, x); [Math.round(x / 100) * 100, Math.round(x / 1000) * 1000, Math.round(x / 1000)].forEach(y => put(all, y)); }); });
  const pn = [...pt.matchAll(/(\d[\d,]*(?:\.\d+)?)/g)].map(m => m[1].replace(/,/g, "")).filter(n => Number(n) > 1 && !/^(19|20)\d\d$/.test(n));
  if (pn.some(n => !all.has(key(n)) && !all.has(Number(n).toFixed(0)))) out.pato = null;   // a number we can't trace to their data: drop it, the app writes its own line
  return out;
}
async function take(env, uid, body, b) {
  const key = "daily7:" + uid + ":" + b.day;
  if (env.LIMITS) { const hit = await env.LIMITS.get(key); if (hit) return JSON.parse(hit); }
  const user = JSON.stringify({ stocks: (body.stocks || []).slice(0, 8), total: body.total || null, bets: (body.bets || []).slice(0, 8), money: body.money || null, angle: String(body.angle || "").slice(0, 20), currency: "USD for stocks, RD$ for bets and money" }).slice(0, 3500);
  const facts = JSON.stringify({ stockNews: b.stocks, marketTop: b.ticker.slice(0, 4).map(i => ({ h: i.h, s: i.s })), breaking: b.big ? { h: b.big.h, s: b.big.s } : null, tech: b.cats.tech ? { h: b.cats.tech[0].h, s: b.cats.tech[0].s } : null, rd: b.cats.rd ? { h: b.cats.rd[0].h, s: b.cats.rd[0].s } : null,
    games: b.games.map(g => ({ league: g.league, name: g.name, note: g.note, tv: g.tv })),
    cards: Object.fromEntries(Object.entries(b.cats).concat(b.big ? [["big", b.big]] : []).map(([k, v]) => { const i = Array.isArray(v) ? v[0] : v; return [k, { h: i.h, also: (i.also || []).slice(0, 3) }]; })) }).slice(0, 9000);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 2500, messages: [{ role: "user", content: TAKE + "\n\nUSER: " + user + "\n\nFACTS: " + facts + "\n\nGAMES are FACTS.games in order. CARDS are FACTS.cards." }] }) });
  if (!r.ok) return null;
  const j = await r.json(), txt = ((j.content || []).find(c => c.type === "text") || {}).text || "", m = txt.match(/\{[\s\S]*\}/);
  let out = null; try { out = JSON.parse(m[0]); } catch (e) { return null; }
  out = check(out, body);
  if (env.LIMITS && Object.keys(b.cats).length >= 2) await env.LIMITS.put(key, JSON.stringify(out), { expirationTtl: 172800 });   // only keep a take built on a full edition
  return out;
}

// "In plain words" (Marco Nov 12: some headlines are jargon, e.g. NGX / Seplat / MTN, or a name nobody knows). One cheap batched call per new set of headlines, shared by everyone and kept in KV.
const PLAIN = `Headlines marked [DEEP READ] are analysis pieces, not news: ALWAYS write 1 or 2 short sentences (max 35 words) on what the piece is about and why it matters, using only the headline and widely known facts, never inventing claims. For the other headlines: for each numbered news headline, decide if a 20-year-old who does not follow the topic would be confused by it: politics, world events, foreign markets or companies, unfamiliar names, jargon. If yes, write BACKGROUND context: 1 or 2 short sentences (max 40 words) saying who or what is involved and why it is happening or why it matters, e.g. what an institution is, who a person is, what led to this. Use ONLY the headline and widely known general knowledge. Never invent numbers, causes, quotes or outcomes; if unsure, return "". If the headline is already clear to anyone (sports results, product launches, simple company news), return "". Return ONLY JSON like {"0":"...","1":""}.`;
async function plainAll(env, b) {
  if (!env.ANTHROPIC_KEY || !env.LIMITS || !b || !b.cats) return;
  const items = []; Object.values(b.cats).forEach(a => (a || []).slice(0, 2).forEach(it => { if (it && it.h) items.push(it); }));
  if (!items.length) return;
  const hk = it => (it.deep ? "d:" : "") + it.h.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
  let M = {}; try { M = JSON.parse((await env.LIMITS.get("pl2")) || "{}"); } catch (e) { M = {}; }
  const miss = items.filter(it => !(hk(it) in M));
  if (miss.length) {
    const list = miss.slice(0, 16), r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1400, messages: [{ role: "user", content: PLAIN + "\n\nHEADLINES:\n" + list.map((it, i) => i + ". " + (it.deep ? "[DEEP READ] " : "") + it.h + " (" + (it.s || "") + ")").join("\n") }] }) }).catch(() => null);
    if (r && r.ok) {
      const j = await r.json(), txt = ((j.content || []).find(c => c.type === "text") || {}).text || "", m = txt.match(/\{[\s\S]*\}/); let o = null; try { o = JSON.parse(m[0]); } catch (e) { o = null; }
      if (o) { list.forEach((it, i) => { M[hk(it)] = typeof o[i] === "string" ? o[i].trim().slice(0, 300) : ""; }); const ks = Object.keys(M); if (ks.length > 220) ks.slice(0, ks.length - 220).forEach(k => delete M[k]); await env.LIMITS.put("pl2", JSON.stringify(M), { expirationTtl: 604800 }); }
    }
  }
  items.forEach(it => { const t = M[hk(it)]; if (t) it.pl = t; });
}
// Breaking key facts (Marco Nov 11: "give the most important data, not only a headline"). One AI call per story, shared by all users (KV), grounded only in the feed text.
const BRIEF = `You explain one news story to a busy young reader in a money app. From ONLY the text below, return JSON {"facts":["",""," "],"why":""}.
facts: up to 3 short lines (max 15 words each) with the most important data: who, what happened, key numbers, what happens next. Only facts stated in the text; if the text has fewer facts, return fewer lines. Never invent numbers, names or outcomes.
why: one line (max 18 words) on why it matters for markets, money or daily life, only if the text supports it; else "". English. No emojis.`;
async function brief(env, it) {
  if (!it || !it.h || !env.ANTHROPIC_KEY || !env.LIMITS) return null;
  const k = "brief1:" + it.h.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 120), hit = await env.LIMITS.get(k); if (hit) return JSON.parse(hit);
  const text = JSON.stringify({ headline: it.h, outlet: it.s, snippet: it.d || "", otherHeadlines: (it.also || []).slice(0, 4) });
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 800, messages: [{ role: "user", content: BRIEF + "\n\nTEXT: " + text }] }) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json(), txt = ((j.content || []).find(c => c.type === "text") || {}).text || "", m = txt.match(/\{[\s\S]*\}/);
  let out = null; try { out = JSON.parse(m[0]); } catch (e) { return null; }
  out = { facts: (out.facts || []).filter(x => typeof x === "string" && x.trim()).slice(0, 3), why: typeof out.why === "string" ? out.why : "" };
  await env.LIMITS.put(k, JSON.stringify(out), { expirationTtl: 172800 }); return out;
}
// Big move insight (Marco Nov 11: "the user needs to feel you're giving great financial advice or knowledge", not a recap of the day). One call per user, stock, day and direction.
const INSIGHT = `You are Pato, a sharp, warm money friend inside a finance app for young investors. One of the user's stocks moved a lot today. Using ONLY the numbers in DATA, write JSON {"line":""}: max 3 short sentences, 50 words total, correct punctuation, no semicolons or dashes, plain words.
Give real insight, not a recap of today's move: e.g. what their concentration means (weightPct), where they stand vs their average cost, what an upcoming event (DATA.event) means for volatility, how to think about a dip or a jump with a plan (cost averaging, position size, not chasing, not panic selling). You may share widely known general knowledge about how markets work. Never say "buy" or "sell" this stock as an instruction; frame it as how a smart investor thinks about it. Never invent numbers, dates, news or targets. Plain English, no emojis.`;
async function insight(env, uid, d) {
  const t = String(d.t || "").toUpperCase().replace(/[^A-Z.]/g, "").slice(0, 6); if (!t || !env.ANTHROPIC_KEY) return null;
  const k = "ins1:" + uid + ":" + drDay() + ":" + t + ":" + (Number(d.chPct) < 0 ? "dn" : "up"); if (env.LIMITS) { const hit = await env.LIMITS.get(k); if (hit) return JSON.parse(hit); }
  const data = { ticker: t, company: String(d.co || "").slice(0, 40), todayPct: Number(d.chPct), todayUsd: Number(d.usd), shares: Number(d.sh), avgCostUsd: Number(d.avg) || null, priceUsd: Number(d.px), sinceBoughtPct: Number(d.since), positionUsd: Number(d.val), weightPct: Number(d.w), otherStocksTodayUsd: Number(d.oth), event: d.ev ? String(d.ev).slice(0, 60) : null, headline: d.h ? String(d.h).slice(0, 160) : null };
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 300, messages: [{ role: "user", content: INSIGHT + "\n\nDATA: " + JSON.stringify(data) }] }) }).catch(() => null);
  if (!r || !r.ok) return null;
  const j = await r.json(), txt = ((j.content || []).find(c => c.type === "text") || {}).text || "", m = txt.match(/\{[\s\S]*\}/);
  let out = null; try { out = JSON.parse(m[0]); } catch (e) { return null; }
  const ok = new Set(); Object.values(data).forEach(v => { if (typeof v === "number" && isFinite(v)) { const a = Math.abs(v); [0, 1, 2].forEach(n => ok.add(a.toFixed(n))); ok.add(String(Math.round(a))); } });
  const nums = [...String(out.line || "").matchAll(/(\d[\d,]*(?:\.\d+)?)/g)].map(x => x[1].replace(/,/g, "")).filter(n => Number(n) > 1 && !/^(19|20)\d\d$/.test(n));
  if (!out.line || nums.some(n => !ok.has(Number(n).toFixed(n.includes(".") ? Math.min(2, n.split(".")[1].length) : 0)) && !ok.has(String(Math.round(Number(n)))))) return null;   // every number must be theirs
  out = { line: String(out.line).slice(0, 320) }; if (env.LIMITS) await env.LIMITS.put(k, JSON.stringify(out), { expirationTtl: 172800 }); return out;
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
  const good = items.map(it => Object.assign(it, { sc: score(it) })).filter(it => it.sc >= 0.5 || (it.sc >= 0.35 && it.sc * want.size >= 3)).sort((x, y) => y.sc - x.sc);
  // Marco Nov 12: no low-quality photos ever. Bing's thumbnails are small, so only the outlet's own full-size photo is used.
  for (const it of good.slice(0, 3)) {   // else the outlet's own preview photo, trying up to 3 outlets covering it
    const real = (() => { try { return new URL(it.l).searchParams.get("url") || it.l; } catch (e) { return it.l; } })();
    log.push("match " + it.sc.toFixed(2) + " " + real.slice(0, 60));
    try { const og = real && !/bing\.com/.test(real) ? await ogImg(real, log) : ""; if (og) return og; } catch (e) { log.push("og err " + e.message); }
  }
  return "";
}
async function storyImg(u, h, debug) {
  const key = new Request("https://pato-img.cache/v6?u=" + encodeURIComponent(u)), hit = debug ? null : await caches.default.match(key);
  if (hit) return hit.json();
  const log = []; let img = "", src = "";
  if (h) { try { img = await bingImg(h, log); } catch (e) { log.push("bing err " + e.message); } }
  const out = { img };
  await caches.default.put(key, new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": "public, max-age=" + (img ? 86400 : 900) } }));
  return debug ? { img, src, log } : out;
}

export default {
  // every 15 min (tools/wrangler.toml crons): refresh games and predictions in their own run, so /news only reads them
  // Every 15 min. At :30 and :45 before each drop (7, 10, 1, 4, 7, 10 DR = 11, 14, 17, 20, 23, 2 UTC) it prepares the drop's news; other runs refresh games, predictions and world news.
  async scheduled(ev, env, ctx) { SUBN = 0; await loadHL(env); const d = new Date(ev.scheduledTime || Date.now()), m = Math.floor(d.getUTCMinutes() / 15) * 15, pre = [10, 13, 16, 19, 22, 1].includes(d.getUTCHours()) && m >= 30;
    if (pre) { const L = SHARED(), half = Math.ceil(L.length / 2), part = m === 30 ? L.slice(0, half) : L.slice(half);
      ctx.waitUntil((async () => { if (m === 30) await deepAll(env, true).catch(() => 0); for (const u of part) await refreshFeed(env, u).catch(() => 0); await saveHL(env); })()); return; }
    ctx.waitUntil(Promise.all([kvFresh(env, "mk2", 0, markets), kvFresh(env, "gm2:" + drDay(), 0, games), m === 0 ? refreshFeed(env, sec("WORLD")).catch(() => 0) : null]).then(() => saveHL(env))); },
  async fetch(req, env) {
    SUBN = 0;
    const origin = req.headers.get("origin") || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/news" && url.searchParams.get("debug") === "kv") {   // test link: how old each prepared topic is
      const out = {}; for (const u of SHARED()) { const v = await env.LIMITS.get(fkey(u), "json").catch(() => null); out[fkey(u).slice(-34)] = v ? { min: Math.round((Date.now() - v.at) / 6e4), n: v.items.length } : null; }
      out.sources = await env.LIMITS.get("hl1", "json").catch(() => null);
      for (const k of ["mk2", "gm2:" + drDay()]) { const v = await env.LIMITS.get(k, "json").catch(() => null); out[k] = v ? { min: Math.round((Date.now() - v.at) / 6e4), n: v.v.length } : null; }
      return json(out, 200, origin);
    }
    if (req.method === "GET" && url.pathname === "/news" && url.searchParams.get("debug") === "net") {   // test link: can the server reach ESPN and Polymarket right now
      const T = ["https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=" + drDay().replace(/-/g, ""), "https://gamma-api.polymarket.com/events?active=true&closed=false&order=volume24hr&ascending=false&limit=120"], out = [];
      for (const u of T) { try { const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; PatoDaily/1.0)" } }), t = await r.text(); out.push({ u: u.slice(8, 40), st: r.status, len: t.length, head: t.slice(0, 120) }); } catch (e) { out.push({ u: u.slice(8, 40), err: String(e.message || e).slice(0, 120) }); } }
      const c = await caches.default.match(new Request(T[0])); out.push({ cachedEspn: !!c, cachedLen: c ? (await c.text()).length : 0 });
      return json(out, 200, origin);
    }
    if (req.method === "GET" && url.pathname === "/news" && url.searchParams.get("debug") === "deep") {   // test link: what the deep-read search returns and what survives the filters
      await loadHL(env); const it = await deepAll(env, true), t = clean(it, 96);
      return json({ raw: it.length, clean: t.length, src: t.filter(i => DEEPSRC.test(i.s || "")).length, head: t.filter(i => DEEPSRC.test(i.s || "") && DEEPH.test(i.h)).length, sample: it.slice(0, 8).map(i => i.s + " | " + i.h), kept: t.slice(0, 8).map(i => i.s + " | " + i.h) }, 200, origin);
    }
    if (req.method === "GET" && url.pathname === "/news" && url.searchParams.get("debug") === "1") {   // test link: how many stories each topic feed gives right now
      const ks = ["rd", "business", "tech", "politics", "crypto", "ent", "gaming", "health", "cars", "fashion"], out = {};
      await Promise.all(ks.map(async k => { try { const it = (await feed(CATS[k], 7200)).items;
        out[k] = { raw: it.length, fresh: pick(it).length, top2: top2(it, [], true).length, img: it.filter(i => i.img).length }; } catch (e) { out[k] = { err: String(e.message || e).slice(0, 80) }; } }));
      return json(out, 200, origin);
    }
    if (req.method === "GET" && url.pathname === "/news") {
      if (!ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
      try { await loadHL(env); const b = await bundle(url.searchParams, env); if (b.big) b.big.brief = await brief(env, b.big).catch(() => null); await plainAll(env, b).catch(() => null); b.pick = await patoPick(env, b.games).catch(() => null); return json(b, 200, origin); } catch (e) { return json({ error: { type: "news_failed" } }, 502, origin); }
    }
    if (req.method === "GET" && url.pathname === "/scores") {   // live scores for the games on screen (Marco Nov 12: update when you come back), cached 60s
      if (!ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
      const refs = (url.searchParams.get("r") || "").split(",").map(x => x.trim()).filter(x => /^[a-z0-9.\-]+\/[a-z0-9.\-]+\|\d{3,12}$/i.test(x)).slice(0, 12), paths = [...new Set(refs.map(x => x.split("|")[0]))].slice(0, 6), out = {};
      await Promise.all(paths.map(pth => cached("https://site.api.espn.com/apis/site/v2/sports/" + pth + "/scoreboard?dates=" + drDay().replace(/-/g, "") + "&_s=1", 60, "json").then(f => {
        (f.body.events || []).forEach(e => { const ref = pth + "|" + e.id; if (refs.indexOf(ref) < 0) return; const c = (e.competitions || [])[0] || {}, st = e.status && e.status.type || {};
          const cs = (c.competitors || []).slice().sort((x, y) => (x.homeAway === "away" ? -1 : 0) - (y.homeAway === "away" ? -1 : 0));
          out[ref] = { st: st.state || "", det: st.shortDetail || "", sc: cs.map(x => x.score || ""), win: cs.map(x => !!x.winner) }; });
      }).catch(() => null)));
      return json(out, 200, origin);
    }
    if (req.method === "GET" && url.pathname === "/img") {
      if (url.searchParams.get("debug") === "1") {   // test link: tries today's top world story and shows each step
        const w = (await feed(sec("WORLD"), 3600)).items.filter(i => TRUSTED.test(i.s))[0] || {};
        return json({ story: w.h || "", ...(await storyImg(w.u || "", w.h || "", true)) }, 200, origin);
      }
      if (!ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
      const u = url.searchParams.get("u") || "", h = (url.searchParams.get("h") || "").slice(0, 200);
      if (!/^https:\/\//.test(u)) return json({ img: "" }, 200, origin);
      return json(await storyImg(u, h), 200, origin);
    }
    if (req.method !== "POST" || !ORIGINS.includes(origin)) return json({ error: { type: "forbidden" } }, 403, origin);
    const uid = await verify((req.headers.get("authorization") || "").replace(/^Bearer /, "")).catch(() => null);
    if (!uid) return json({ error: { type: "authentication_error", message: "Sign in again" } }, 401, origin);
    let body; try { body = await req.json(); } catch (e) { return json({ error: { type: "invalid_request_error" } }, 400, origin); }
    if (url.pathname === "/call") {   // "Call it": shared tally of how many Pato users called today's question right (one answer per user)
      const q = String(body.q || "").replace(/[^a-z0-9]/gi, "").slice(0, 24); if (!q || !env.LIMITS) return json({ n: 0, right: 0 }, 200, origin);
      const k = "call:" + q, cur = JSON.parse((await env.LIMITS.get(k)) || '{"n":0,"right":0}');
      if (typeof body.right === "boolean" && !(await env.LIMITS.get("callv:" + q + ":" + uid))) {
        cur.n++; if (body.right) cur.right++;
        await env.LIMITS.put(k, JSON.stringify(cur), { expirationTtl: 259200 }); await env.LIMITS.put("callv:" + q + ":" + uid, "1", { expirationTtl: 259200 });
      }
      return json(cur, 200, origin);
    }
    if (url.pathname === "/insight") { try { return json((await insight(env, uid, body)) || {}, 200, origin); } catch (e) { return json({}, 200, origin); } }
    if (url.pathname === "/daily") {
      try { await loadHL(env); const b = await bundle(url.searchParams, env); if (b.big) b.big.brief = await brief(env, b.big).catch(() => null); await plainAll(env, b).catch(() => null); b.pick = await patoPick(env, b.games).catch(() => null); return json({ ...b, take: await take(env, uid, body, b).catch(() => null) }, 200, origin); }
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
