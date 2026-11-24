# PATO-CONTEXT.md

Read this first. To switch Claude accounts, follow SWITCH-ACCOUNTS.md. It explains how Pato (the app, formerly "Stakd" / "Sette Cifre") is built, where things live, and how Marco likes to work. No secrets are in this file, only where they live.

## What Pato is
A personal-finance app for Marco (Dominican Republic, times are DR = UTC-4 all year) that is also a beta for friends. It tracks savings toward a RD$1,000,000 goal, spending, loans Marco gave, stocks (IBKR), crypto, sports bets, poker, and shows "Pato Daily" news stories. "Pato AI" is the assistant inside (camera to log a purchase, Pato's take). Vision: a financial AI tracker for the younger generation. Marco uses it as an iPhone home-screen app.

- App link (GitHub Pages, branch `main`): https://marcoferrando114.github.io/Sette-Cifre/
- Repo: marcoferrando114/sette-cifre (public). Firebase project: `stakd-3d1b9` (Auth + Firestore).
- Marco's Firebase uid (owner): `e16AkFccPaRJjc5uosBXY5AGXyx1`. Friends create an account in the app and start empty (the "base model").

## Repo layout
- `index.html` (~780 KB): the whole app, one built file (HTML+CSS+JS). `mp-firebase.js`: bundled Firebase SDK. `sync.js`, `gmail.js`, `faceid.js`: app helpers. `sw.js` service worker, `manifest.webmanifest`, icons (`icon-*.png`; green is the Home Screen icon, brown and cream are optional looks), `privacy.html`, `setup.html`, `pato-daily-demo.json` (demo stories), `version.json` (bump on release so phones refresh).
- `tools/pato-ai-worker.js` + `tools/wrangler.toml`: worker **pato-ai** (camera proxy, Pato Daily news, scores, insight, "Call it").
- `tools/mail/`: worker **pato-mail** (one-tap Gmail sync for friends).
- `tools/cron/`: worker **pato-cron** (stock prices + loan reminder push; replaces the scheduled Claude tasks).
- `tools/stakd_db.py`: Python helper used by Claude tasks to read/write Firestore as the sync robot.
- `.github/workflows/deploy-worker.yml`: on push to `main` touching `tools/pato-ai-worker.js`, `tools/wrangler.toml`, `tools/mail/**`, `tools/cron/**`, GitHub deploys all three workers with wrangler (repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
- The project's shared files folder (outside the repo, in the Claude project) holds the working copy and history: `sette-cifre/kit/*_step.py` (the build kit), `sette-cifre/ai-proxy/worker.js` (+ many `worker.backup-*.js`), `backups/`, `investing/` (stock notes and `tools/stock_update.py`), `sette-cifre/friend-kit/`, `sette-cifre/secrets/` (VAPID private key, never in the repo).

## How the app is built
`index.html` is generated, not hand-written. In the project files, `sette-cifre/kit/build.py` turns the base tracker HTML into the web app (adds the PWA head, password gate, Firebase), and many small scripts `kit/<feature>_step.py` each patch `index.html` with one feature (e.g. `score_step.py` Pato score, `loans_person_step.py` loan buttons, `settings_page_step.py` Settings page, `crypto_step.py` Crypto, `daily_step.py` + `daily.js` Pato Daily, `warm_text_step.py` / `remind_text_step.py` Remind texts, `looks_step.py` themes, `snap_step.py` camera). Workflow for a change: back up the current `index.html` to `backups/pato-index-<date>-before-<feature>.html`, write or edit a step, run it, verify in a browser (Playwright is available), then open a PR to `main`. Merging deploys the site (GitHub Pages). Bump `version.json`.
Tabs/areas: Savings (goal, milestones, league rakeback, loans), Spend, Stocks (IBKR + Crypto), Games/Poker (League, Tables, Arcade, Sports), Loans, Pato Daily (stories, peeking duck), Settings.

## Workers (Cloudflare, free account, `workers.dev`)
| Worker | URL | Does | Vars / secrets (set in Cloudflare dashboard, never in git) |
|---|---|---|---|
| pato-ai | https://pato-ai.marcoferrando.workers.dev | `/daily`, `/news`, `/scores`, `/img`, `/call`, `/insight`, camera. Limits: 30 photos/day Marco, 20 friends. Cron every 15 min refreshes games + predictions into KV; Pato Daily drops 7am, 10am, 1pm, 4pm, 7pm, 10pm DR prepared 15-30 min ahead. Only the 7am Pato's take uses AI. | `ANTHROPIC_KEY` (secret), `OWNER_UID`, KV `LIMITS` |
| pato-mail | https://pato-mail.marcoferrando.workers.dev | Friends' one-tap Gmail (read-only) bank-email sync: `/start`, `/callback`, `/status`, `/sync`, `/disconnect`. Google Cloud project "Pato" under Marco's personal Gmail, app "In production" (unverified, up to 100 users). | `GOOGLE_ID`, `GOOGLE_SECRET`, `ANTHROPIC_KEY` (all must be real values) |
| pato-cron | https://pato-cron.marcoferrando.workers.dev | Stock prices (Yahoo, same logic as `investing/tools/stock_update.py`) every 30 min during market hours, plus pre-market 9:05am, after-hours 5:05pm, 7:05pm, 9:05pm DR, weekdays; writes `invest/ibkr`. Loan reminder push at 8:42am DR (loans due in 7 or 2 days, plus debts with a due date). | `BOT_PASSWORD` (secret, robot sign-in), `VAPID_PRIVATE` (secret, PEM text), KV `LIMITS` |

All three share the KV namespace `pato-limits` (binding `LIMITS`). Anthropic: US$5 credit, US$5/month cap. Deploy: merge to `main` (GitHub Action) or paste the file into the worker's "Edit code". `keep_vars = true` keeps dashboard variables across deploys. Test cron jobs from the dashboard (Settings > Triggers > Trigger event) and read Logs.

## Data model (Firestore, all under `users/{uid}/`)
Rules: a user can read/write only their own space; the sync robot `sync-1f6e51ca@stakd-bot.app` can also write Marco's space (see `sette-cifre/firestore-rules-new.txt`).
- `entries`: savings ledger (type in/out, amount, source, note, date; `extra:true` = never fills an expected date; `bhdIds` for combined bank rows).
- `spend`: spending rows (date, amount/rd, currency, category, kind consumo/manual/transfer, status "Aprobada", excluded).
- `prestamos`: loans Marco gave (nombre, monto, interes, fecha first due, cuotas, frecuencia semanal/quincenal/mensual, cuotasPagadas[], pagado, pausado = "On hold", avisos[] like `pre:2026-11-30`/`late:...` = reminded). `topay`: what Marco owes ("To pay"). `contactos/{slug}`: phone numbers for WhatsApp.
- `config/main`: settings: `limiteMensual` (monthly hard limit), `recordarDias` (reminder days, default 2), `fijos` (expected income; `montos {date: amount}` for one-offs), `deudas`, `inversiones`, `liga` weeks (monto + accion), goal, milestones.
- `invest/ibkr`: `posiciones` (t, sh, costo, precio, prev, open, regalo), `ordenes`, `hist` [{t,v}], `eventos`, `bench`, `cash`, `at`. Buys record `invertido` + `comisionPagada` (never a field named `comision`); when an order fills, move it from `ordenes` to `posiciones`.
- `holdings` (crypto), `bets`/`apuestas` (sports), `pokerOtra`, `corriente`, `pagos`, `receipts`, `checkins`, `snaps`.
- `prefs/ui|news|keys|score|push|alerts`: per-user prefs; `prefs/push.subs` = Web Push subscriptions of the phone(s). `spendMeta/sync|wallet|alertLog`.

## Schedules (DR time)
- Stocks: see pato-cron above. Gmail/BHD bank sync for Marco: Claude task 4 times a day (7am, 12pm, 5pm, 10pm), includes smart alerts (`tools/stakd_alerts.py`-style push: stock moves 5%+, earnings, loans due tomorrow, payment received, rakeback, 85% of budget). Loan reminders: pato-cron 8:42am.
- Pato Daily: pato-ai (above). Cloudflare jobs cost no Claude usage.
- **Pato Daily redesign (Nov 14, demo accounts `pato-demo*` only until Marco approves the rollout; everyone else still runs the old `/news` + `/daily`).** One shared edition per drop at 7am, 1pm, 7pm DR, served by `GET /edition` (and `POST /daily2`, which adds only Pato's personal take). Nine tabs: Pato's take, Breaking, topic 1, topic 2, Predictions (exactly 3, never repeated, KV `pu1`), Company of the day (one per day, KV `cotd2:<day>`), Sports (biggest event first via `bigExtra`), topic 3, founder story (one per day, curated `FOUNDERS` roster, Wikipedia portrait). Users pick up to 3 topics; Pato fills in if fewer. No Daily Duel.
- **Launch standard (built in pato-ai, `advance()`):** cron runs every 5 min; in the hour before each drop it prepares feeds (:00, :05) then does one step per tick: build, photos, briefs, key facts, image check (`verifyImgs`), quality check (`qualityCheck`: 3+ topic stories, Breaking importance bar, exactly 3 predictions, Company, founder, English/Spanish only, key facts, nothing repeated today via KV `dayh:<day>`), repair (`repairEd`: swap to the next best story kept in `_alt`/`_bigC`, redo missing pieces, up to 3 rounds), then publish (`edpub` pointer) or keep the last good edition. Phones always get this drop's edition once published, otherwise the last good one, never a broken one. Health note in KV `edh:<drop>`; pato-cron `editionHealth` (35 min after each drop) sends Marco a one-line push if a drop was not clean. KV keys are versioned (`ed9:<drop>`): bump the prefix to force a rebuild. Debug: `/edition?dbg=1` shows checks and repair log.
- Old Claude tasks for stocks and loans are paused and should be deleted once pato-cron is verified.

## How loans and Remind texts work
Loans show one line per loan; one Remind and one Paid round icon per person; Paid goes to the soonest-due loan. Remind opens WhatsApp (`wa.me`) with this Spanish text (no "!"): `{Saludo by DR time} {Nombre}, {opener}. Te recuerdo que el {fecha} toca el pago de RD$X. {closer}`. Openers rotate and never repeat twice in a row, typed casually with no accents ("todo bien?", "como vas?", "como estas?", "que tal todo?", "como va todo?", "como te va?", "espero que estes bien", "espero que todo bien por alla"; Mondays add "espero que hayas empezado bien la semana", Fridays "feliz viernes"). Closers end with a period: "Gracias." / "Gracias, que tengas buen día." (morning) / "Gracias, buena tarde." (afternoon). Months/weekdays lowercase. Late: `El pago de RD$X del {fecha} sigue pendiente, me avisas cuándo me lo puedes mandar? {closer}`. The app's Reminders box lists payments due within `recordarDias` and builds the text itself (`msgFor`, `warmBits`). The 8:42am push is just the nudge to open it. "On hold" loans: gentle message, still counts like 30+ days late in trust score.

## Marco's rules and preferences
- Answer directly and shortly; relay to other threads quietly, never send him to another chat. English now (he asked to continue in English). No 👀 reactions.
- Propose ideas and wait for his pick; one numbered list with defaults. He tries ideas one at a time: **back up before each change**.
- Minimal text in the UI. Native `confirm()`/`alert()` fail on his phone: use `sure()`/`warnMsg()`.
- **Errands is private**: never log anything to Errands unless Marco says so.
- **Never write the reason for any loan "On hold"** anywhere (UI says only "On hold"). Details are in the private handoff.
- Combine rule: same-day same-kind entries = ONE row; never merge different motivo.
- Receipts: when he uploads a receipt or writes "sync", log it and run the sync.
- Record owed money only when paid. Dad loan is savings held by Dad, not a withdrawal. IBKR wires are never withdrawals.
- Spending categories: Car, Rides (Uber), Tennis & club, Going out, Family, Wants. Outside Tables poker losses go to Poker. Sports (Betcris, bank shows "modyloft") is not spending. Arcade = casino/slots (neutral name, family can see).
- Pato Daily: one way in (peeking duck that never covers data, hides while scrolling, returns 2.5s after scrolling stops); morning cover; no timers; DR section named "DR"; no repeated info across slides; tab names are categories; new vs seen obvious; full-photo covers whenever possible; only highlight stats that matter in his real dollars.
- Friends see "Stocks" (not "IBKR"). Never include his data in the base model.
- Hook-style content matters (TikTok-like), but don't depend on user feedback yet.
- Usage economy: he runs low on Claude usage, so prefer Cloudflare for anything scheduled; Claude only for judgment.

## Apple Pay + email receipts (Nov 24)
- iOS Shortcut automation (Transaction trigger) POSTs `{amount, merchant, card}` to `https://pato-cron.marcoferrando.workers.dev/pay?t=<token>`; token lives in KV `pay:token`, minted/read by pato-mail `/paylink` (owner only; Settings > Apple Pay > Copy link). `ingestPay` (tools/cron/ingest.js) logs a spend row (`source:"applepay"`, learned categories, combine rule) with `preOpen:[rd]`.
- Gmail receipts: pato-mail `/watch` also reads Uber/Uber Eats, PedidosYa, Amazon, Apple/Netflix/Spotify... emails (`parseReceipt`, no AI) -> `/notify` -> `ingestReceipt`: row with `detail` (trip route, restaurant, items), `source:"receipt"`; renewal notices go to `users/{uid}/subs`.
- Dedup: bank alert, tap and receipt for the same charge (same day +-1, same amount) share ONE row: whoever comes second attaches (`preOpen`, `bhdIds`, `apLinked`, `rcpt`). BHD still creates its savings withdrawal.

## Declined ideas (do not re-offer)
Poker results by game, borrower history, income by source, net worth chart, what-if slider, phone shortcuts, collections board, all CFP ideas (weekly pace, emergency fund, windfall split, category limits, safe-to-spend), USD/inflation view, BHD reconciliation, tax pack, loan discount/caps, IOU, stress number, bankroll, date as range, odd-charge alerts, "days of saving", weekly savings chart, 25k badges, in-app "Add to today's entry?", "Pato vs the crowd", "Log something" subtitle.

## Open items
Gmail one-tap for friends needs real `GOOGLE_ID`/`GOOGLE_SECRET` in pato-mail, then a test with a test account (details in the private handoff). Poker and Sports tab polish later. Camera test photo not confirmed. Daily name still open (Pato News / Stories / Daily).

## How to deploy and work (for a new Claude account)
1. Clone the repo, create a branch, make changes (edit via the kit steps or directly), keep a backup of `index.html` first.
2. Open a PR to `main`; merge = deploy (Pages for the app, Action for workers).
3. Firebase from scripts: sign in as the robot (`tools/stakd_db.py`, env `STAKD_BOT_PASSWORD` set in the Claude environment settings; allow `firestore.googleapis.com`, `identitytoolkit.googleapis.com`).
4. Needed in the Claude environment: network access to those hosts, Gmail connector for the bank sync, the repo connected. Never paste passwords or keys into chat.
