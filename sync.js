// Pato: Refresh stock prices (straight from the phone, Finnhub free key) and ask for a Gmail sync
// (writes spendMeta/syncReq; the hourly scheduled sync picks it up).
(function(){
  var $ = function(id){ return document.getElementById(id); };
  if (!$("saGm") || !$("saSt")) return;
  var db = null, ibkr = null, meta = null, req = null, key = null, busy = false;
  var tm = function(ms){ var d = new Date(ms), now = new Date();
    var t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
    if (d.toDateString() === now.toDateString()) return "today " + t;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + t; };
  var tt = null, toast = function(t, s, warn){ var el = $("toast"); if (!el) return;
    $("toastT").textContent = t; $("toastS").textContent = s || ""; $("toastUndo").hidden = true; el.classList.toggle("warn", !!warn);
    el.classList.remove("on"); void el.offsetWidth; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(function(){ el.classList.remove("on"); }, 3200); };
  var paint = function(){
    var a = ibkr && ibkr.at ? Date.parse(ibkr.at) : 0;
    $("saStT").textContent = a ? "Updated " + tm(a) : "Not updated yet";
    $("saKey").hidden = !!key; $("saSt").hidden = !key;
    if (req && req.status === "pending") $("saGmT").textContent = "Asked " + tm(req.at).replace("today ", "") + ", runs within the hour";
    else if (req && req.status === "running") $("saGmT").textContent = "Updating now…";
    else if (meta && meta.lastRunAt) $("saGmT").textContent = "Last updated " + tm(meta.lastRunAt);
    else if (meta && meta.lastSync) $("saGmT").textContent = "Last updated " + new Date(meta.lastSync + "T12:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    else $("saGmT").textContent = "Not updated yet";
    $("saGm").disabled = false;
  };
  async function quote(sym){
    var r = await fetch("https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(sym) + "&token=" + encodeURIComponent(key), { cache: "no-store" });
    if (r.status === 401 || r.status === 403) throw new Error("key");
    if (!r.ok) throw new Error("http " + r.status);
    var q = await r.json(); if (!q || !q.c) throw new Error("no price for " + sym);
    return { precio: Math.round(q.c * 10000) / 10000, prev: q.pc || null, open: q.o || null, time: q.t || Math.floor(Date.now() / 1000) };
  }
  async function refresh(silent){
    if (busy || !ibkr || !key) return; busy = true; var b = $("saSt"); if (!silent) { b.disabled = true; b.textContent = "Refreshing…"; }
    try {
      var d = ibkr, latest = 0, pos = [];
      var qs = await Promise.all((d.posiciones || []).map(function(p){ return quote(p.t); }));
      (d.posiciones || []).forEach(function(p, i){ var x = qs[i]; latest = Math.max(latest, x.time); pos.push(Object.assign({}, p, { precio: x.precio, prev: x.prev, open: x.open })); });
      var bench = Object.assign({ t: "SPY" }, d.bench || {}); var s = await quote(bench.t || "SPY"); latest = Math.max(latest, s.time);
      if (!bench.start) bench.start = s.precio; bench.precio = s.precio;
      latest = Math.min(latest, Math.floor(Date.now() / 1000));
      // market closed: the saved prices (which include after-hours trades) are already newer than these quotes
      var have = d.at ? Date.parse(d.at) / 1000 : 0;
      if (latest <= have) { if (!silent) toast("Prices are up to date", "Market is closed"); return; }
      var v = Math.round(((d.cash || 0) + pos.reduce(function(t, p){ return t + (p.sh || 0) * p.precio; }, 0)) * 100) / 100;
      var h = (d.hist || []).filter(function(x){ return x && x.t != null && x.v != null; });
      if (!h.length || latest > h[h.length - 1].t + 600) h.push({ t: latest, v: v });
      else if (latest >= h[h.length - 1].t) h[h.length - 1] = { t: latest, v: v };
      await db.doc("invest/ibkr").update({ posiciones: pos, bench: bench, hist: h.slice(-400), at: new Date(latest * 1000).toISOString().replace(/\.\d+Z$/, "Z") });
      if (!silent) toast("Stock prices updated");
    } catch (e) {
      console.warn("refresh", e);
      if (silent && String(e.message) !== "key") return;
      if (String(e.message) === "key") { key = null; toast("That stock key didn’t work", "Paste it again", true); }
      else toast("Couldn’t refresh prices", "Try again in a minute", true);
    } finally {
      busy = false; b.disabled = false; b.textContent = "Refresh"; paint();
    }
  }
  $("saSt").onclick = function(){ refresh(false); };
  // live prices: while the app is open during US market hours, refresh every minute (straight from the phone, no Claude)
  function marketOpen(){
    try {
      var p = {}; new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
        .formatToParts(new Date()).forEach(function(x){ p[x.type] = x.value; });
      if (p.weekday === "Sat" || p.weekday === "Sun") return false;
      var m = (+p.hour) * 60 + (+p.minute); return m >= 570 && m <= 961;   // 9:30 am to 4:01 pm New York
    } catch (e) { return false; }
  }
  function tick(){ if (!document.hidden && key && marketOpen()) refresh(true); }
  setInterval(tick, 60000);
  document.addEventListener("visibilitychange", function(){ if (!document.hidden) setTimeout(tick, 1500); });
  $("saKeySave").onclick = async function(){
    var k = $("saKeyIn").value.trim(); if (k.length < 10) return;
    key = k; $("saKeyIn").value = "";
    try { await db.doc("prefs/keys").set({ finnhub: k, at: Date.now() }); } catch (e) {}
    paint(); refresh();
  };
  // Nov 25: Refresh reads the bank emails right now through the Gmail watcher (pato-mail), no Claude sync needed
  var MAIL = "https://pato-mail.marcoferrando.workers.dev", watchAt = 0, working = false;
  async function mail(path){
    var tok = window.mpIdToken ? await window.mpIdToken() : ""; if (!tok) throw new Error("sign_in");
    var r = await fetch(MAIL + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: "{}" });
    var j = await r.json().catch(function(){ return {}; }); if (!r.ok) throw new Error(j.error || ("http " + r.status)); return j;
  }
  function stamp(ms){ if (!ms || !db) return; watchAt = ms;
    var d = { lastRunAt: ms, lastSync: new Date(ms - 4 * 36e5).toISOString().slice(0, 10) };
    db.doc("spendMeta/sync").update(d).catch(function(){}); paint(); }
  var paint0 = paint; paint = function(){ paint0();
    if (working) { $("saGmT").textContent = "Reading bank emails…"; $("saGm").disabled = true; return; }
    if (watchAt) { $("saGmT").textContent = "Last updated " + tm(watchAt); $("saGm").disabled = false; } };
  $("saGm").onclick = async function(){
    if (working) return; working = true; paint();
    try { var j = await mail("/refresh"); working = false; stamp(j.watchAt || Date.now());
      toast(/^[1-9]\d* alert/.test(j.result || "") ? "New bank activity logged" : j.result === "gmail not connected" ? "Gmail isn’t connected" : "Up to date", "", /not connected/.test(j.result || "")); }
    catch (e) { working = false; paint(); toast("Couldn’t refresh", "Try again in a minute", true); }
  };
  setTimeout(function(){ mail("/status").then(function(j){ if (j && j.watchAt) stamp(j.watchAt); }).catch(function(){}); }, 2500);
  (async function(){
    if (!window.claude) return;
    db = await window.claude.use("db"); if (!db) return;
    db.doc("invest/ibkr").onSnapshot(function(s){ ibkr = s.exists ? s.data() : null; paint(); }, function(){});
    db.doc("spendMeta/sync").onSnapshot(function(s){ meta = s.exists ? s.data() : null; paint(); }, function(){});
    db.doc("spendMeta/syncReq").onSnapshot(function(s){ req = s.exists ? s.data() : null; paint(); }, function(){});
    db.doc("prefs/keys").onSnapshot(function(s){ var k = s.exists ? s.data().finnhub : null; var first = !key && k; if (k) key = k; paint(); if (first) setTimeout(tick, 1500); }, function(){});
  })();
})();
