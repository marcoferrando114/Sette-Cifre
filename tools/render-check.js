// Screen-render check (Marco Nov 14): loads the LIVE edition into the real app in a browser, opens every slide and fails if an image box is empty, a fallback visual is missing or tiny, or section labels use different styles.
// Usage: EDITION_FILE=edition.json ACCT=owner|demo node tools/render-check.js   (needs playwright and the app served on http://localhost:8765)
const { chromium } = require('playwright'); const fs = require('fs');
const ACCT = process.env.ACCT || 'owner', OWNER = ACCT === 'owner', EMAIL = OWNER ? 'owner@example.test' : 'pato-demo-0000@example.com';
const stub = `
(function(){ const PREFS = null;
 const data = {
  'invest/ibkr': {posiciones:[{t:'MSFT',sh:2,precio:420,prev:395,costo:310},{t:'AAPL',sh:3,precio:184,prev:186.5,costo:150},{t:'NVDA',sh:4,precio:182,prev:179,costo:170}],eventos:[{t:'NVDA',fecha:'2026-11-17',txt:'Earnings'}]},
  'prefs/news': PREFS };
 const cols = { prestamos:[{nombre:'Carlos',monto:20000,interes:15,fecha:'2026-11-01',vence:'2026-11-30',pagado:false},{nombre:'Juan Pablo',monto:9000,interes:10,fecha:'2026-11-05',vence:'2026-11-25',pagado:false},{nombre:'Ana',monto:5000,interes:10,fecha:'2026-10-01',vence:'2026-10-20',pagado:true,cobradoEl:'2026-10-20'},{nombre:'Ana',monto:7000,interes:10,fecha:'2026-11-02',vence:'2026-11-28',pagado:false}], holdings:[{t:'MSFT',sh:2,precio:420,prev:415},{t:'AAPL',sh:3,precio:175,prev:186.5}], bets:[{fecha:'2026-11-10',stake:1000,legs:[{sport:'NBA',game:'Lakers vs Celtics'}]},{fecha:'2026-11-08',result:'lost',stake:500,legs:[{sport:'NBA'}]}] };
 const snap = d => ({exists: d!=null, data: () => d, id: 'x'});
 const doc = p => ({ onSnapshot:(f)=>{ setTimeout(()=>f(snap(data[p]===undefined?null:data[p])),10); return ()=>{}; }, set: async v=>{ data[p]=v; }, update: async()=>{} });
 const col = n => ({ doc: id => doc(n+'/'+id), add: async()=>({id:'n'}), onSnapshot:(f)=>{ setTimeout(()=>f({docs:(cols[n]||[]).map((d,i)=>({id:'d'+i,exists:true,data:()=>d})),size:0,empty:false}),10); return ()=>{}; } });
 window.MP_ME = {uid:'u', email:'${EMAIL}', owner:${OWNER}};
 document.documentElement.classList.toggle('mp-guest', ${!OWNER});
 document.documentElement.classList.remove('mp-locked'); const g=document.getElementById('mpGate'); if(g) g.hidden=true;
 window.mpIdToken = async()=>'tok'; window.claude = { use: async n => n==='db' ? {collection:col, doc} : null };
})();`;

const ed = JSON.parse(fs.readFileSync(process.env.EDITION_FILE, 'utf8'));
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 390, height: 844 } }), problems = [];
  p.on('pageerror', e => problems.push('page error: ' + e.message));
  await p.route(/mp-firebase\.js/, r => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await p.route(/workers\.dev\/edition/, r => r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(ed) }));
  await p.route(/workers\.dev\/daily/, r => { if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors }); r.fulfill({ contentType: 'application/json', headers: cors, body: JSON.stringify(Object.assign({}, ed, { take: null })) }); });
  await p.route(/workers\.dev\/(news|insight|scores|call)/, r => r.fulfill({ contentType: 'application/json', headers: cors, body: '{}' }));
  await p.route(/fonts|finnhub|gstatic|googleapis|coingecko|parqet|google\.com\/s2/, r => r.abort());
  await p.goto('http://localhost:8765/index.html'); p.click('text=Not now', { timeout: 1500 }).catch(() => {});
  for (let i = 0; i < 50; i++) { if (await p.evaluate(() => { const f = document.getElementById('pdFab'); return f && !f.hidden; })) break; await p.waitForTimeout(100); }
  await p.evaluate(() => { const c = document.getElementById('pdCover'); c && c.querySelector('.go') && c.querySelector('.go').click(); }); await p.waitForTimeout(600);
  await p.evaluate(() => { const f = document.getElementById('pdFab'); f.hidden = false; f.click(); }); await p.waitForTimeout(800);
  const n = await p.evaluate(() => document.querySelectorAll('#pdNav button').length);
  if (n < 8) problems.push('only ' + n + ' slides');
  const labelStyles = new Set();
  for (let i = 0; i < n; i++) {
    await p.evaluate(i => document.querySelectorAll('#pdNav button')[i].click(), i); await p.waitForTimeout(7500);   // photos get time to load; the page itself swaps a stuck photo for the visual after 6 s
    const r = await p.evaluate(() => {
      const out = { nav: document.querySelector('#pdNav button.on').textContent.trim(), issues: [], labels: [] };
      document.querySelectorAll('#pdBd .pd-img').forEach(box => {
        const bb = box.getBoundingClientRect(); if (bb.width < 50) return;
        if (box.classList.contains('pd-vis')) { const v = box.querySelector('.pd-vem,.pd-vlg'); if (!v) out.issues.push('fallback visual has no logo or emoji'); else { const vb = v.getBoundingClientRect(); if (vb.width < 40 || vb.height < 40 || Math.abs((vb.left + vb.width / 2) - (bb.left + bb.width / 2)) > bb.width * 0.2) out.issues.push('fallback visual is tiny or not centered'); } return; }
        const im = box.querySelector('img'); const ok = im && im.complete && im.naturalWidth >= 800 && getComputedStyle(im).opacity === '1';
        if (!ok) { const v = box.querySelector('.pd-bk .pd-vem,.pd-bk .pd-vlg'); if (!v) out.issues.push('photo did not load and no visual behind it'); else out.issues.push('photo still not showing after 7 s (visual behind it is visible)'); }
      });
      document.querySelectorAll('#pdBd .pd-know>i,#pdBd .pd-note>i,#pdBd .pd-key>i').forEach(l => { const c = getComputedStyle(l); out.labels.push([c.fontStyle, c.fontWeight, c.fontSize, c.textTransform, c.fontFamily].join('|')); });
      if (document.getElementById('pdBd').innerText.trim().length < 40) out.issues.push('slide is almost empty');
      return out;
    });
    r.labels.forEach(l => labelStyles.add(l));
    r.issues.forEach(m => problems.push(r.nav + ': ' + m));
    console.log(i, r.nav, r.issues.length ? 'PROBLEM ' + r.issues.join('; ') : 'ok');
  }
  if (labelStyles.size > 1) problems.push('section labels use ' + labelStyles.size + ' different styles: ' + [...labelStyles].join(' / '));
  await b.close();
  if (problems.length) { console.log('\nRENDER CHECK FAILED (' + ACCT + '):\n- ' + problems.join('\n- ')); process.exit(1); }
  console.log('\nRENDER CHECK PASSED (' + ACCT + '): ' + n + ' slides');
})();
