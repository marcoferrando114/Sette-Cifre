// Pato auto-logging of bank alert emails (Nov 17, 2026). Pure logic over a small store, so it can be tested without Firestore.
// Port of the rules of the old "Medio palo sync" Claude prompt (Parts A and B): same ids, same fields, same combine rule, no AI.
// S = { get(col,id), put(col,id,data) (merge), eq(col,field,value), arrayHas(col,field,value), range(col,field,lo,hi), list(col) }
// a = parsed alert from pato-mail: {id, ts, bank, kind, amount, cur, status, date (YYYY-MM-DD or ""), detail, raw, bene}
const FX = { DOP: 1, USD: 60, EUR: 73 };
const nrm = s => String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const spMerch = m => nrm(m).replace(/[\d#*•.,:-]+/g, " ").replace(/\s+/g, " ").trim();   // same key the app uses to learn categories
const r2 = n => Math.round(n * 100) / 100;
const mon = iso => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const rd = n => "RD$" + n.toLocaleString("en-US", { minimumFractionDigits: Math.round(n * 100) % 100 ? 2 : 0, maximumFractionDigits: 2 });
const drDay = ts => new Date(ts - 4 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const tol = a => Math.max(50, a * 0.01);

// Category keys are the app's (SP_CATS). Never "errands" (Marco's private one). Unknown stays "other": the app asks its own categorizer when it opens.
const KEYS = [
  ["rides", /\buber(?!\s*eats)|taxi|indrive|cabify/],
  ["food", /vili|taconazo|pizzarelli|mcdonald|burger|rolling steak|pollos|green bowl|domino|barra junior|wendy|kfc|subway|pizza|cafe|coffee|panader|bakery|restaur|grill|sushi|helado|yogen|starbucks|supermerc|colmado|nacional|jumbo|asian market|total food|pedidosya|uber\s*eats|glovo|dragon de or/],
  ["gas", /\btotal\b|sigma|\bshell\b|texaco|\bnext\b|parqueo|estacionam|peaje|lavad|car wash|taller|gasolin|combustible|bomba/],
  ["sport", /country club|padel|tenis|tennis|gimnasio|\bgym\b|body shop|sportline/],
  ["out", /\bbar\b|casino|cerveceria|hotel|brewery|\bpub\b|lounge|discoteca|cinema|cine\b/],
  ["shopping", /fortnite|epic games|playstation|steam|nintendo|apple|amazon|zara|nike|adidas|reloj|watch/],
  ["subs", /spotify|netflix|disney|hbo|deliveroo|youtube|icloud|google one|openai|claude/],
  ["health", /farmacia|pharm|carol|\bgbc\b|clinica|laboratorio|medic/],
];
// the bank spells one store many ways (branch, city, cut-off names): same first two words, or the same single long word, is the same store (same rule as the app)
const STOP = /^(s ?a|srl|sas|the|de|del|la|el|los|las|dr|rd|santo|domingo|sto|dgo|www|com)$/;
const words = k => String(k || "").split(" ").filter(w => w.length >= 3 && !STOP.test(w));
function learnFor(L, merchant) {
  const k = spMerch(merchant); if (!k || !L) return null; if (L[k]) return L[k];
  const w = words(k); if (!w.length) return null; let best = null, bl = 0;
  for (const lk in L) { const lw = words(lk); let n = 0; while (n < w.length && n < lw.length && w[n] === lw[n]) n++;
    if ((n >= 2 || (n === 1 && (w.length === 1 || lw.length === 1) && w[0].length >= 5)) && n >= bl) { bl = n; best = L[lk]; } }
  return best;
}
function catOf(merchant, learned) {
  const c = learnFor(learned, merchant); if (c) return c;
  const n = nrm(merchant); for (const [c, re] of KEYS) if (re.test(n)) return c;
  return "other";
}
async function learnedCats(S) {   // what Marco picked himself for each merchant (same rule as the app: newest pick wins, transfers excluded)
  const m = {}; (await S.eq("spend", "userCat", true)).filter(t => t.cat && t.kind !== "transfer").sort((a, b) => (a.ts || 0) - (b.ts || 0)).forEach(t => { m[spMerch(t.merchant)] = t.cat; if (t.raw) m[spMerch(t.raw)] = t.cat; });   // the bank's own spelling too (it truncates names)
  return m;
}
const isSelf = b => /marco/i.test(b || "") && /ferrando/i.test(b || "");
const natural = b => { const p = String(b || "").split(","); if (p.length < 2) return nice(b); const sur = p[0].trim().split(/\s+/)[0], first = p.slice(1).join(" ").trim(); return nice(first + " " + sur); };
const nice = s => String(s || "").toLowerCase().replace(/(^|[\s,.'-])([a-zà-ÿ])/g, (m, a, b) => a + b.toUpperCase()).trim();

async function alreadyLogged(S, id) {   // spend or savings docs written by this code, by the old Claude sync, or combined into another row
  if (await S.get("spend", id) || await S.get("spend", "bhd-" + id) || await S.get("entries", "bhd-" + id) || await S.get("entries", "pop-" + id)) return true;
  if ((await S.arrayHas("spend", "bhdIds", id)).length || (await S.arrayHas("entries", "bhdIds", id)).length) return true;
  for (const f of ["bhd", "bhd2", "popular"]) if ((await S.eq("entries", f, id)).length) return true;
  return false;
}

async function ingestCore(S, a) {
  if (!a || !a.id || !(a.amount > 0)) return "skipped";
  const ts = a.ts || Date.now(), date = a.date || drDay(ts), cur = FX[a.cur] ? a.cur : "DOP", rdAmt = r2(a.amount * FX[cur]), bad = /Declinada|Rechazada|Reversada/i.test(a.status || "");
  if (await alreadyLogged(S, a.id)) return "already logged";

  // ---------- Popular (checking) -> spend ----------
  if (a.bank === "Popular") {
    if (a.kind === "card") {
      const merchant = a.detail || "Bank charge", cat = catOf(merchant, await learnedCats(S));
      if (!bad) { const pre = await findPre(S, date, rdAmt, cur !== "DOP");   // Apple Pay tap or email receipt already logged this one: attach the bank id, no second row
        if (pre) { await S.put("spend", pre.row.id, { bhdIds: [...(pre.row.bhdIds || []), a.id], preOpen: pre.rest }); return "matched " + pre.row.source + " row " + pre.row.id; } }
      if (!bad) { const same = (await S.eq("spend", "date", date)).find(t => t.kind === "consumo" && t.source === "email" && t.status === "Aprobada" && !t.excluded && spMerch(t.merchant) === spMerch(merchant));
        if (same) {   // COMBINE RULE: same day, same place = one row
          const parts = same.note && /\+/.test(same.note) ? same.note + " + " + rd(a.amount) : rd(Number(same.amount) || 0) + " + " + rd(a.amount);
          await S.put("spend", same.id, { amount: r2((Number(same.amount) || 0) + a.amount), rd: r2((Number(same.rd) || 0) + rdAmt), bhdIds: [...(same.bhdIds || [same.id]), a.id], note: parts });
          return "combined into " + same.id; } }
      await S.put("spend", a.id, { date, merchant, raw: a.raw || merchant, amount: a.amount, currency: cur, rd: rdAmt, kind: "consumo", status: bad ? (/Reversada/i.test(a.status) ? "Reversada" : "Declinada") : "Aprobada", cat, source: "email", excluded: false, ts });
      return "spend row";
    }
    if (a.kind === "cash") {
      await S.put("spend", a.id, { date, merchant: "Código Cash · ATM", raw: "Código Cash", amount: a.amount, currency: "DOP", rd: a.amount, kind: "retiro", status: /Reversada/i.test(a.status) ? "Reversada" : bad ? "Declinada" : "Aprobada", cat: "cash", source: "email", excluded: false, ts });
      return "cash withdrawal row";
    }
    if (a.kind === "deposit") {   // the ATM deposit email does not say who it is from; it is logged as income and Marco sorts it (loan payment, etc.) as before
      await S.put("spend", a.id, { date, merchant: "ATM deposit", raw: a.raw || "Depósito por ATM", amount: a.amount, currency: "DOP", rd: a.amount, kind: "ingreso", status: "Aprobada", cat: "income", source: "email", excluded: false, ts });
      return "deposit row";
    }
    return "not logged";   // transfers out of Popular come with a receipt photo (tr-<ref>); money-in wording unknown
  }

  // ---------- BHD (savings) -> entries (+ spend for card purchases) ----------
  if (a.bank === "BHD") {
    if (bad) return "not logged (declined or reversed)";
    const name = a.kind === "card" ? (a.detail || "Bank charge") : a.kind === "transfer" ? natural(a.bene) : "";
    if (a.kind === "transfer" && /interactive|ibkr/i.test(a.bene || "")) return "not logged (IBKR wire)";   // wires follow their own rule: fees only + config inversiones
    const info = (a.kind === "card" ? "BHD card · " + name : "BHD transfer to " + name) + " · " + rd(a.amount) + " · " + mon(date);
    // B4: Marco often logs these by hand first: attach the bank id to ONE matching hand-logged entry instead of creating another
    const near = (await S.range("entries", "date", addDays(date, -2), addDays(date, 1))).filter(e => e.type === "out" && !e.bhd && !e.popular && !e.auto && Math.abs((Number(e.amount) || 0) - a.amount) <= tol(a.amount));
    const mine = a.kind === "transfer" && isSelf(a.bene);
    const cand = near.filter(e => mine ? !!e.traslado : !e.traslado).sort((x, y) => Math.abs(x.amount - a.amount) - Math.abs(y.amount - a.amount) || Math.abs(Date.parse(x.date) - Date.parse(date)) - Math.abs(Date.parse(y.date) - Date.parse(date)));
    if (cand.length && !/modyloft|betcris/i.test(name)) {
      await S.put("entries", cand[0].id, { bhd: a.id, bhdInfo: info });
      const pre0 = a.kind === "card" ? await findPre(S, date, rdAmt, cur !== "DOP") : null;
      if (pre0) { await linkPreSav(S, pre0, a.id, cand[0].id); return "matched your hand-logged entry + " + pre0.row.source + " row"; }
      if (a.kind === "card" && !(await S.eq("spend", "savEntry", cand[0].id)).length && cand[0].motivo !== "favor") await spendFor(S, a, cand[0].id, name, date, ts, rdAmt, cur);
      return "matched your hand-logged entry";
    }
    if (a.kind === "card") {
      if (/modyloft|betcris/i.test(name)) {   // sports bets: savings entry only, never a spend row, never combined
        await S.put("entries", "bhd-" + a.id, { type: "out", source: "Apuestas", motivo: "apuesta", amount: a.amount, date, createdAt: ts, note: "Betcris", bhdInfo: "BHD card · Betcris (Modyloft) · " + rd(a.amount) + " · " + mon(date), bhd: a.id, auto: true });
        return "bet entry";
      }
      const pre1 = await findPre(S, date, rdAmt, cur !== "DOP");   // Apple Pay tap / receipt came first: the savings withdrawal is new, the spend row is not
      if (pre1) {
        await S.put("entries", "bhd-" + a.id, { type: "out", source: "Retiro", motivo: "gasto", amount: a.amount, date, createdAt: ts, note: name, bhdInfo: info, bhd: a.id, auto: true });
        await linkPreSav(S, pre1, a.id, "bhd-" + a.id); return "savings entry + matched " + pre1.row.source + " row";
      }
      const same = (await S.eq("entries", "date", date)).find(e => e.bhd && e.type === "out" && e.source === "Retiro" && e.motivo === "gasto" && e.auto && spMerch(e.note) === spMerch(name));
      if (same) {   // COMBINE RULE
        const ids = same.bhdIds || [same.bhd], total = r2((Number(same.amount) || 0) + a.amount);
        await S.put("entries", same.id, { amount: total, bhdIds: [...ids, a.id], bhdInfo: (same.bhdInfo || "BHD card · " + name).replace(/( · [A-Z][a-z]{2} \d+)$/, " + " + rd(a.amount) + "$1") });
        for (const sp of await S.eq("spend", "savEntry", same.id)) await S.put("spend", sp.id, { amount: r2((Number(sp.amount) || 0) + a.amount), rd: r2((Number(sp.rd) || 0) + rdAmt), bhdIds: [...(sp.bhdIds || [same.bhd]), a.id] });
        return "combined into " + same.id;
      }
      await S.put("entries", "bhd-" + a.id, { type: "out", source: "Retiro", motivo: "gasto", amount: a.amount, date, createdAt: ts, note: name, bhdInfo: info, bhd: a.id, auto: true });
      await spendFor(S, a, "bhd-" + a.id, name, date, ts, rdAmt, cur);
      return "savings entry + spend row";
    }
    if (a.kind === "transfer") {
      if (mine) {   // BHD -> own Popular checking: a move (never spending), and the checking balance goes up, like the Move money form
        const cc = (await S.list("corriente")).sort((x, y) => (y.date || "").localeCompare(x.date || "") || (y.createdAt || 0) - (x.createdAt || 0))[0], cc0 = cc ? Number(cc.saldo) || 0 : 0;
        await S.put("corriente", "cc-" + a.id, { saldo: Math.max(0, cc0 + a.amount), date: !cc || date > (cc.date || "") ? date : drDay(Date.now()), createdAt: ts, move: a.amount, entryRef: "bhd-" + a.id });
        await S.put("entries", "bhd-" + a.id, { type: "out", source: "Retiro", motivo: "corriente", amount: a.amount, date, createdAt: ts, note: "Moved to Popular checking", bhdInfo: "BHD transfer to own Popular checking · " + rd(a.amount) + " · " + mon(date), bhd: a.id, auto: true, traslado: true, ccRef: "cc-" + a.id });
        return "move to Popular";
      }
      // anyone else: no motivo, Marco picks the reason in the app (one-off per transfer, as before)
      await S.put("entries", "bhd-" + a.id, { type: "out", source: "Retiro", amount: a.amount, date, createdAt: ts, note: "Transfer to " + name, bhdInfo: info, bhd: a.id, auto: true });
      return "savings entry (reason to pick)";
    }
  }
  return "not logged";
}

// ---------- Loan payments (Nov 23): a clear incoming deposit marks the loan payment as received ----------
// Clear = the borrower's name is in the alert, or the amount equals exactly what one open loan owes and that payment is due within a week (or late). Anything else is left for Marco.
const lTotal = l => (Number(l.monto) || 0) * (1 + (Number(l.interes) || 0) / 100);
const lPaid = l => (Array.isArray(l.cuotasPagadas) ? l.cuotasPagadas : []).reduce((t, c) => t + (Number(c.monto) || 0), 0);
const lN = l => Math.max(1, Math.round(Number(l.cuotas) || 1));
function lDates(l) {
  const n = lN(l), d0 = new Date((l.fecha || "") + "T12:00:00Z"), out = [];
  for (let k = 0; k < n; k++) {
    if (l.frecuencia === "semanal") out.push(addDays(d0.toISOString().slice(0, 10), 7 * k));
    else if (l.frecuencia === "quincenal") out.push(addDays(d0.toISOString().slice(0, 10), 14 * k));
    else { const day = d0.getUTCDate(), d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1, 12)); d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate())); out.push(d.toISOString().slice(0, 10)); }
  }
  return out;
}
function lNext(l) {   // {amt, date, k, n} of the payment Pato expects next
  const n = lN(l), left = Math.max(0, lTotal(l) - lPaid(l)); if (l.pagado || l.pausado || left < 0.5 || !l.fecha) return null;
  if (n === 1) return { amt: left, date: l.fecha, k: 1, n };
  const each = lTotal(l) / n, paid = lPaid(l), k = Math.min(n - 1, Math.floor((paid + 0.5) / each));
  return { amt: k + 1 === n ? left : Math.min(each * (k + 1) - paid, left), date: lDates(l)[k], k: k + 1, n };
}
async function collectLoan(S, a, bank) {
  const date = a.date || drDay(a.ts || Date.now()), text = nrm([a.detail, a.bene, a.raw].join(" "));
  const loans = (await S.list("prestamos")).filter(l => !l.pagado && !l.pausado && lNext(l));
  if (loans.some(l => (l.cuotasPagadas || []).some(c => c.bankId === a.id))) return "";
  const nameHit = l => { const n = nrm(l.nombre).split(/\s+/).filter(w => w.length >= 3); return n.length > 0 && n.every(w => text.includes(w)); };
  let pick = loans.filter(nameHit).filter(l => a.amount <= lTotal(l) - lPaid(l) + 0.5);
  if (pick.length !== 1) {
    const near = loans.filter(l => { const x = lNext(l), left = lTotal(l) - lPaid(l); return (Math.abs(x.amt - a.amount) <= 0.5 || Math.abs(left - a.amount) <= 0.5) && Date.parse(x.date + "T12:00:00Z") <= Date.parse(date + "T12:00:00Z") + 7 * 864e5; });
    pick = pick.length ? [] : near;   // two borrowers named, or none: only a unique exact amount counts
  }
  if (pick.length !== 1) return "";
  const l = pick[0], left = lTotal(l) - lPaid(l), amt = Math.min(left, a.amount), x = lNext(l), done = amt >= left - 0.5;
  const lbl = x.n > 1 ? `Payment ${x.k}/${x.n} from ${l.nombre}` : `Payment from ${l.nombre}`, sav = bank === "BHD";
  let entryId = null;
  if (sav) { entryId = "loan-" + a.id; await S.put("entries", entryId, { amount: amt, type: "in", source: "Préstamo", date, note: lbl, createdAt: a.ts || Date.now(), auto: true, bhd: a.id }); }
  const list = [...(Array.isArray(l.cuotasPagadas) ? l.cuotasPagadas : []), { fecha: date, monto: amt, destino: sav ? "ahorro" : "otra", entryId, bankId: a.id, auto: true }];
  await S.put("prestamos", l.id, { cuotasPagadas: list, ...(done ? { pagado: true, cobradoEl: date, destino: sav ? "ahorro" : "otra" } : {}) });
  return `LOAN|${l.nombre}|${Math.round(amt)}|${Math.round(left - amt)}`;
}

// ---------- Apple Pay taps and email receipts (Nov 24) ----------
// A tap (iOS Shortcut) or a receipt email (Uber, Amazon, PedidosYa...) is logged the moment it arrives, as a spend row with preOpen = [RD$ amounts the bank has not confirmed yet].
// The later bank alert finds that row (same day +-1, same amount) and only attaches its id (BHD: the savings withdrawal is still created). If the bank row came first, the tap/receipt attaches to it instead.
const hash = str => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0; return h.toString(36); };
const tolOf = (rdAmt, foreign) => foreign ? Math.max(30, rdAmt * 0.06) : Math.max(1, rdAmt * 0.005);
async function findPre(S, date, rdAmt, foreign) {
  const t = tolOf(rdAmt, foreign);
  for (const r of await S.range("spend", "date", addDays(date, -1), addDays(date, 1)))
    if (Array.isArray(r.preOpen)) { const i = r.preOpen.findIndex(x => Math.abs(Number(x) - rdAmt) <= t); if (i >= 0) return { row: r, rest: r.preOpen.filter((_, k) => k !== i) }; }
  return null;
}
async function findPost(S, date, rdAmt, foreign, forReceipt) {   // a bank-made row (no tap/receipt linked yet) for the same charge
  const t = tolOf(rdAmt, foreign);
  return (await S.range("spend", "date", addDays(date, -1), addDays(date, 1))).filter(r => (forReceipt ? !r.rcpt : !r.apLinked) && !Array.isArray(r.preOpen) && ["email", "bhd"].includes(r.source) && r.status === "Aprobada" && !r.excluded && (r.kind === "consumo" || (r.kind === "manual" && r.fromSav)) && Math.abs((Number(r.rd) || 0) - rdAmt) <= t)
    .sort((x, y) => Math.abs(x.rd - rdAmt) - Math.abs(y.rd - rdAmt))[0] || null;
}
async function linkPreSav(S, pre, bankId, entryId) {
  await S.put("spend", pre.row.id, { bhdIds: [...(pre.row.bhdIds || []), bankId], preOpen: pre.rest, fromSav: true, savEntry: entryId, kind: "manual", bank: "bhd", note: "Paid with the BHD savings card" });
}
const bankOfCard = c => /bhd|6133/i.test(c || "") ? "bhd" : /popular|5935/i.test(c || "") ? "pop" : "";
function parseMoney(txt) {   // "RD$1,250.00", "US$ 12.5", "1.250,00", "€9,99": amount + currency
  const t = String(txt || ""), cur = /US|USD/i.test(t) ? "USD" : /EUR|€/i.test(t) ? "EUR" : "DOP";
  let n = (t.match(/\d[\d.,]*/) || [""])[0];
  if (/,\d{1,2}$/.test(n) && !/\.\d{1,2}$/.test(n)) n = n.replace(/\./g, "").replace(",", ".");   // European decimal comma
  return { amount: r2(Number(n.replace(/,/g, "")) || 0), cur };
}
async function ingestPay(S, p) {   // p = {amount (number or text), currency?, merchant, card?, ts?}
  const m = typeof p.amount === "number" ? { amount: r2(p.amount), cur: p.currency || "DOP" } : parseMoney(p.amount);
  if (p.currency && FX[String(p.currency).toUpperCase()]) m.cur = String(p.currency).toUpperCase();
  if (!(m.amount > 0)) return { result: "skipped" };
  const ts = p.ts || Date.now(), date = drDay(ts), merchant = nice(String(p.merchant || "Apple Pay").replace(/\s+/g, " ").slice(0, 80)) || "Apple Pay", rdAmt = r2(m.amount * FX[m.cur]);
  const id = "ap-" + hash([date, m.amount, spMerch(merchant), Math.floor(ts / 120e3)].join("|"));   // the same tap sent twice within 2 minutes is one
  if (await S.get("spend", id)) return { result: "already logged" };
  const post = await findPost(S, date, rdAmt, m.cur !== "DOP");
  if (post) { await S.put("spend", post.id, { apLinked: true }); return { result: "already logged by the bank", merchant, rdAmt, cat: post.cat }; }
  const cat = catOf(merchant, await learnedCats(S)), bank = bankOfCard(p.card);
  const same = (await S.eq("spend", "date", date)).find(t => t.source === "applepay" && t.status === "Aprobada" && !t.excluded && spMerch(t.merchant) === spMerch(merchant) && t.currency === m.cur);
  if (same) {   // COMBINE RULE: same day, same place = one row
    const parts = same.note && /\+/.test(same.note) ? same.note + " + " + rd(m.amount) : rd(Number(same.amount) || 0) + " + " + rd(m.amount);
    await S.put("spend", same.id, { amount: r2((Number(same.amount) || 0) + m.amount), rd: r2((Number(same.rd) || 0) + rdAmt), preOpen: [...(same.preOpen || []), rdAmt], note: parts });
    return { result: "combined into " + same.id, merchant, rdAmt, cat: same.cat };
  }
  await S.put("spend", id, { date, merchant, raw: p.merchant || merchant, amount: m.amount, currency: m.cur, rd: rdAmt, kind: "consumo", status: "Aprobada", cat, source: "applepay", excluded: false, ts, card: String(p.card || "").slice(0, 40), bank, preOpen: [rdAmt] });
  return { result: "spend row", merchant, rdAmt, cat };
}
// a = {kind:"receipt", id, ts, merchant (platform), detail, amount, cur, card4, cat?, date?}  or  {kind:"sub", id, ts, merchant, amount, cur, renews, every}
async function ingestReceipt(S, a) {
  if (!a || !a.id || !(a.amount > 0)) return "skipped";
  if (a.kind === "sub") { const slug = nrm(a.merchant).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sub"; await S.put("subs", slug, { name: a.merchant, amount: a.amount, currency: a.cur || "DOP", renews: a.renews || "", every: a.every || "", at: a.ts || Date.now() }); return "subscription noted"; }
  if ((await S.eq("spend", "rcpt", a.id)).length || await S.get("spend", "rc-" + a.id)) return "already logged";
  const ts = a.ts || Date.now(), date = a.date || drDay(ts), cur = FX[a.cur] ? a.cur : "DOP", rdAmt = r2(a.amount * FX[cur]), foreign = cur !== "DOP";
  const post = await findPost(S, date, rdAmt, foreign, true);
  if (post) {   // the bank row came first: add the details (and a better category if the bank row had none)
    const up = { rcpt: a.id, apLinked: true, detail: a.detail || "" };
    if (post.cat === "other" && !post.userCat && a.cat) up.cat = a.cat;
    await S.put("spend", post.id, up); return "receipt matched " + post.id;
  }
  const cat = a.cat || catOf(a.merchant, await learnedCats(S)), bank = a.card4 === "6133" ? "bhd" : a.card4 === "5935" ? "pop" : "";
  await S.put("spend", "rc-" + a.id, { date, merchant: a.merchant, raw: a.merchant, detail: a.detail || "", amount: a.amount, currency: cur, rd: rdAmt, kind: "consumo", status: "Aprobada", cat, source: "receipt", rcpt: a.id, excluded: false, ts, bank, preOpen: [rdAmt] });
  return "receipt row";
}
async function ingest(S, a) {
  if (a && (a.kind === "receipt" || a.kind === "sub")) return ingestReceipt(S, a);
  const r = await ingestCore(S, a);
  if (r === "already logged" || r === "skipped" || !a || !(a.amount > 0) || a.cur === "USD" || a.cur === "EUR" || !/^(deposit|in)$/.test(a.kind) || /Declinada|Rechazada|Reversada/i.test(a.status || "")) return r;
  try { const m = await collectLoan(S, a, a.bank); return m ? r + " | " + m : r; } catch (e) { return r + " | loan match error"; }
}
async function spendFor(S, a, entryId, name, date, ts, rdAmt, cur) {
  await S.put("spend", "bhd-" + a.id, { date, merchant: name, raw: a.raw || name, amount: a.amount, currency: cur, rd: rdAmt, kind: "manual", fromSav: true, savEntry: entryId, status: "Aprobada", cat: catOf(name, await learnedCats(S)), source: "bhd", excluded: false, ts, note: "Paid with the BHD savings card" });
}

export { ingest, ingestPay, catOf, spMerch };
