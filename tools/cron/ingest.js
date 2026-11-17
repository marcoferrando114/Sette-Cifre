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
function catOf(merchant, learned) {
  const k = spMerch(merchant); if (learned && learned[k]) return learned[k];
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

async function ingest(S, a) {
  if (!a || !a.id || !(a.amount > 0)) return "skipped";
  const ts = a.ts || Date.now(), date = a.date || drDay(ts), cur = FX[a.cur] ? a.cur : "DOP", rdAmt = r2(a.amount * FX[cur]), bad = /Declinada|Rechazada|Reversada/i.test(a.status || "");
  if (await alreadyLogged(S, a.id)) return "already logged";

  // ---------- Popular (checking) -> spend ----------
  if (a.bank === "Popular") {
    if (a.kind === "card") {
      const merchant = a.detail || "Bank charge", cat = catOf(merchant, await learnedCats(S));
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
      if (a.kind === "card" && !(await S.eq("spend", "savEntry", cand[0].id)).length && cand[0].motivo !== "favor") await spendFor(S, a, cand[0].id, name, date, ts, rdAmt, cur);
      return "matched your hand-logged entry";
    }
    if (a.kind === "card") {
      if (/modyloft|betcris/i.test(name)) {   // sports bets: savings entry only, never a spend row, never combined
        await S.put("entries", "bhd-" + a.id, { type: "out", source: "Apuestas", motivo: "apuesta", amount: a.amount, date, createdAt: ts, note: "Betcris", bhdInfo: "BHD card · Betcris (Modyloft) · " + rd(a.amount) + " · " + mon(date), bhd: a.id, auto: true });
        return "bet entry";
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
async function spendFor(S, a, entryId, name, date, ts, rdAmt, cur) {
  await S.put("spend", "bhd-" + a.id, { date, merchant: name, raw: a.raw || name, amount: a.amount, currency: cur, rd: rdAmt, kind: "manual", fromSav: true, savEntry: entryId, status: "Aprobada", cat: catOf(name, await learnedCats(S)), source: "bhd", excluded: false, ts, note: "Paid with the BHD savings card" });
}

export { ingest, catOf, spMerch };
