// Pato: one-tap Gmail for friends (guest accounts). Connect once with Google (read-only), pick 1, 3 or 6 months,
// then bank emails turn into spending rows every time the app opens. Server: tools/mail/worker.js ("pato-mail").
(function(){
  var URL_ = "https://pato-mail.marcoferrando.workers.dev";
  var $ = function(id){ return document.getElementById(id); };
  var anchor = $("saGmRow"); if (!anchor) return;
  var db = null, st = null, busy = false, have = null, months = 3, lastTry = 0, prog = "";

  var row = document.createElement("div");
  row.className = "sa-gm"; row.id = "gmRow"; row.hidden = true;
  row.innerHTML = '<div id="gmInfo" style="cursor:pointer"><b>Bank activity</b><small id="gmT">…</small></div><button type="button" class="mini" id="gmBtn">Connect</button>';
  anchor.parentNode.insertBefore(row, anchor.nextSibling);
  var dlg = document.createElement("div");
  dlg.className = "celebrate"; dlg.id = "gmDlg"; dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true");
  dlg.innerHTML = '<div class="cel-card" style="border-color:var(--green)"><h2 id="gmH" style="margin:0 0 4px">Connect Gmail</h2><p id="gmP"></p>' +
    '<div id="gmMo" style="display:flex;gap:6px;margin:-6px 0 18px"></div><div class="colbtns"><button type="button" id="gmGo"></button><button type="button" id="gmNo" class="ghost">Cancel</button></div></div>';
  document.body.appendChild(dlg);
  var css = document.createElement("style");
  css.textContent = "#gmMo button{flex:1;border:1px solid var(--line);background:none;color:var(--ink);font:inherit;font-weight:600;padding:10px 4px;border-radius:12px;cursor:pointer}" +
    "#gmMo button.on{background:var(--green);color:var(--on-green);border-color:var(--green)}#gmRow[hidden]{display:none!important}";
  document.head.appendChild(css);

  var tm = function(ms){ var d = new Date(ms), now = new Date(), t = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase();
    return d.toDateString() === now.toDateString() ? "today " + t : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + t; };
  var tt = null, toast = function(t, s, warn){ var el = $("toast"); if (!el) return;
    $("toastT").textContent = t; $("toastS").textContent = s || ""; if ($("toastUndo")) $("toastUndo").hidden = true; el.classList.toggle("warn", !!warn);
    el.classList.remove("on"); void el.offsetWidth; el.classList.add("on"); clearTimeout(tt); tt = setTimeout(function(){ el.classList.remove("on"); }, 3200); };

  async function call(path, body){
    var tok = window.mpIdToken ? await window.mpIdToken() : "";
    var r = await fetch(URL_ + path, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok }, body: JSON.stringify(body || {}) });
    var j = await r.json().catch(function(){ return {}; });
    if (!r.ok) throw new Error(j.error || ("http " + r.status));
    return j;
  }
  function paint(){
    var b = $("gmBtn"), t = $("gmT");
    if (!st) { t.textContent = "…"; b.hidden = true; return; }
    b.hidden = false; b.disabled = busy;
    if (st.off) { t.textContent = "Not available yet"; b.hidden = true; return; }
    if (!st.connected) { t.textContent = st.reconnect ? "Gmail needs a new tap" : "Connect Gmail"; b.textContent = st.reconnect ? "Reconnect" : "Connect"; return; }
    b.textContent = busy ? "Updating…" : "Refresh";
    t.textContent = busy ? (prog || "Reading bank emails…") : st.lastRunAt ? "Updated " + tm(st.lastRunAt) : "Gmail connected";
  }
  function open(){
    var on = st && st.connected;
    $("gmH").textContent = on ? "Gmail connected" : "Connect Gmail";
    $("gmP").textContent = on ? (st.email || "") : "Pato reads only your bank emails. How far back?";
    $("gmMo").hidden = on; $("gmMo").style.display = on ? "none" : "flex";
    $("gmMo").innerHTML = [1, 3, 6].map(function(m){ return '<button type="button" data-m="' + m + '" class="' + (m === months ? "on" : "") + '">' + m + (m === 1 ? " month" : " months") + "</button>"; }).join("");
    $("gmGo").textContent = on ? "Disconnect" : "Continue with Google"; $("gmGo").dataset.arm = "";
    $("gmGo").style.background = on ? "var(--red)" : ""; $("gmGo").style.color = on ? "#fff" : "";
    $("gmNo").textContent = on ? "Close" : "Cancel";
    dlg.classList.add("on");
  }
  var close = function(){ dlg.classList.remove("on"); };
  $("gmMo").onclick = function(e){ var m = e.target && e.target.dataset && e.target.dataset.m; if (!m) return; months = +m;
    [].forEach.call($("gmMo").children, function(x){ x.classList.toggle("on", +x.dataset.m === months); }); };
  $("gmNo").onclick = close;
  dlg.onclick = function(e){ if (e.target === dlg) close(); };
  $("gmGo").onclick = async function(){
    var b = this;
    if (st && st.connected) {   // two taps to disconnect (no native confirm on the iPhone app)
      if (!b.dataset.arm) { b.dataset.arm = "1"; b.textContent = "Tap again to disconnect"; return; }
      b.disabled = true;
      try { await call("/disconnect"); st = { connected: false }; close(); toast("Gmail disconnected", "Your saved spending stays"); }
      catch (e) { toast("Couldn’t disconnect", "Try again", true); }
      b.disabled = false; paint(); return;
    }
    b.disabled = true; b.textContent = "Opening Google…";
    try { var r = await call("/start", { months: months }); location.href = r.url; }
    catch (e) { b.disabled = false; b.textContent = "Continue with Google"; toast("Couldn’t open Google", "Try again in a minute", true); }
  };
  $("gmInfo").onclick = function(){ if (st && st.connected && !busy) open(); };
  $("gmBtn").onclick = function(){ if (!st || !st.connected) open(); else run(true); };

  async function run(manual){
    if (busy || !st || !st.connected || !have) return;
    busy = true; lastTry = Date.now(); prog = ""; paint();
    var page = "", added = 0, read = 0, first = false;
    try {
      for (var i = 0; i < 60; i++) {
        var r = await call("/sync", page ? { page: page } : {});
        if (!r.connected) { st = r; break; }
        if (r.first) first = true;
        if (r.limit) { if (manual) toast("That’s enough for today", "More comes in tomorrow"); break; }
        for (var k = 0; k < (r.items || []).length; k++) {
          var it = r.items[k], id = it.id; if (have.has(id)) continue;
          var d = Object.assign({}, it); delete d.id;
          await db.collection("spend").doc(id).set(d); have.add(id); added++;
        }
        read += r.read || 0;
        if (r.lastRunAt) st.lastRunAt = r.lastRunAt;
        if (read) { prog = "Read " + read + " bank emails" + (added ? " · " + added + " added" : ""); paint(); }
        if (!r.next) break;
        page = r.next;
      }
      if (added) toast(added + (added === 1 ? " purchase added" : " purchases added"), "From your bank emails");
      else if (manual || first) toast("Up to date", "No new bank activity");
    } catch (e) {
      console.warn("gmail", e);
      if (manual) toast("Couldn’t read Gmail", "Try again in a minute", true);
    } finally { busy = false; prog = ""; paint(); }
  }
  async function status(){
    try { st = await call("/status"); }
    catch (e) { if (String(e.message) === "not_set_up") st = { off: true }; else if (!st) st = { connected: false }; }
    paint();
    if (st && st.connected && Date.now() - lastTry > 10 * 60e3) run(false);
  }
  document.addEventListener("visibilitychange", function(){ if (!document.hidden && db && !busy) setTimeout(status, 800); });
  (async function(){
    if (!window.claude) return;
    db = await window.claude.use("db"); if (!db) return;
    var me = window.MP_ME || {}; if (me.owner) return;   // Marco keeps his own sync
    row.hidden = false; paint();
    db.collection("spend").onSnapshot(function(s){ var first = !have; have = new Set(s.docs.map(function(d){ return d.id; })); if (first) status(); }, function(){});
  })();
})();
