# ACCOUNTS-PLAN.md: rebuild Pato around accounts (plan only, nothing changed yet)

Written Nov 27, 2026 after reading `index.html`, `tools/cron/ingest.js`, `tools/cron/worker.js`, `tools/mail/worker.js` and PATO-CONTEXT.md. No app code or data was touched. Waiting for Marco's go.

## 1. What causes the drift today

Pato has no "account" object. Money lives in three different shapes, and each account's balance is rebuilt by a different formula that guesses from flags on rows.

| Account | Where its balance comes from today |
|---|---|
| BHD savings | `entries` ledger: sum of every `in` minus `out` (+ market gain). `index.html` ~4705 `render()`. It is really "total savings", so it also contains money that never touched BHD. |
| Popular checking | A typed snapshot (`corriente` docs: `saldo`, `date`) plus a guess: `ccEstimate()` ~5605 subtracts every later `spend` row that is not flagged as BHD. |
| Cash | A typed snapshot (`spendMeta/wallet`) plus `spWalletCalc()` ~5560 adding later ATM rows and `entries` with `motivo:"efectivo"`, subtracting later manual spend. |
| USD account | One typed number (`spendMeta/usdAccount`). |
| IBKR | `invest/ibkr` (separate, already fairly clean). |
| Dad's RD$307k, loans | Inside `entries`/`config`/`prestamos`, only partly linked to anything. |

Why that drifts:

1. **The account is implicit.** A spend row has no "paid from" field. The code infers it from `fromSav`, `bank==="bhd"`, `source==="bhd"`, `kind`, `traslado`, `cash`. Nov 27's Uber Eats bug was exactly this: a BHD-card row without the right flag got subtracted from Popular. It had to be patched in `ccEstimate()` with an exclusion list, and any new source (Apple Pay, receipts) can miss it again.
2. **One real event becomes 2 to 4 rows.** A BHD card charge = an `entries` withdrawal + a `spend` row (+ an Apple Pay row + a receipt row). They are tied together by fuzzy matching on amount, date +/-1 to 2 days and merchant (`findPre`, `findPost`, "near" in `ingestCore`). When the match misses, the balance is off; when it wrongly matches, a charge disappears.
3. **A transfer is a pair of unlinked rows** (a savings `traslado` entry and a `corriente` snapshot, or a spend `deposito`). They are linked by `ccRef`/`entryRef` only when created by the app; hand-logged or bank-detected ones rely on matching. A transfer can therefore still leak into spend or income if only one half is seen.
4. **Balances are snapshots plus guessed deltas.** Popular and cash are "last number someone typed, plus what we think happened since". Missing alerts (Pizzarelli, Total on Nov 27) silently become error. Neither bank emails money received, so inflows are always partial.
5. **No account says how fresh it is.** Nothing records "this balance was last confirmed by the bank on X", so drift is invisible until Marco compares screenshots.
6. **Loans mix three ideas.** Lending money, the loan record, and repayments touch `entries`, `prestamos`, `corriente` and `spend` with different rules (money "came from BHD / Popular / other").

## 2. The new model

Every peso lives in an account. Every movement is one record that says **from account to account**. Balances are computed from movements and then checked against the bank.

**Accounts** (`accounts/{id}`): `popular`, `bhd`, `cash`, `usd`, `ibkr`, `dad` (Marco's savings held by Dad, RD$307k, repays 312k Nov 30), plus per-person loan accounts `loan:<name>` (owed to Marco) and `owe:<name>` (Marco owes). Outside world is two special accounts: `world:income` and `world:spend` (with category), so even a spend is "popular to world:spend".

**Movements** (`moves/{id}`): one record per real-world event:
`{ date, ts, amount, currency, from, to, kind, category?, merchant?, note?, sources: [bankId, applePayId, receiptId, ...], status }`
- `kind` is derived from the accounts: own account to own account = **transfer** (never spend or income); own account to `world:spend` = **spend**; `world:income` to own account = **income**; own to `loan:x` = **loan given**; `loan:x` to own = **repayment**. This makes "a transfer counted as spend" impossible by construction.
- `sources` is a list: the bank alert, the Apple Pay tap and the Uber receipt for the same charge are **evidence on one movement**, not separate rows. Matching still happens once, at ingest, but the result is stored as a link instead of being re-guessed in every screen.

**Balance** = opening balance (a dated, confirmed number) + sum of movements after it. That replaces `ccEstimate`, `spWalletCalc`, and "sum of entries".

**Confirmation (part of the model, not a chore).** Each account stores `confirmed: {amount, at, by}`. Sources that confirm automatically: a bank email that includes a balance, a screenshot Marco already sends, the camera/typed "I have 300 in my wallet". When a confirmed number differs from the computed balance, Pato writes one adjusting movement tagged `kind:"adjust"` and shows "Popular: RD$1,855, confirmed Nov 27 from your screenshot". Each account card shows that one line. No separate reconciliation screen, no new task for Marco.

**Net worth** = sum of account balances (RD$ at the day's rate) + IBKR + loans owed to him - what he owes. It always adds up because every peso is somewhere.

## 3. How each part maps

- **Existing entries / spend / corriente:** migrated into `moves` (section 4). The old collections stay in place, read-only, until the new screens are verified.
- **Bank email ingest (cron `ingestCore`):** Popular alert = a movement `popular to world:spend` (card), `popular to cash` (ATM), `world:income to popular` (deposit, category unknown until Marco sorts it). BHD alert = same with `bhd`. The account is set **by the card/bank of the email** (BHD card ending 6133 can never touch `popular`; Popular debit ending 5935 can never touch `bhd`). IBKR wires = `bhd to ibkr`, never a withdrawal. The fuzzy matching is kept but writes into `sources`.
- **Apple Pay (`/pay`):** creates a movement from the card named in the tap; if the tap does not say which card, mark `from:null, pending:true` and fill it when the bank alert arrives, rather than defaulting to an account.
- **Email receipts (Uber, PedidosYa, Amazon...):** attach as evidence + `detail`; they set merchant and category, never the account.
- **Typed logging / camera / Move money:** the typed `kind:"move"`, `income`, `casino`, `cash_set` forms already carry from/to; they write one movement each instead of 2 to 3 rows (this removes `traslado`, `ccRef`, `entryRef`, `savEntry`, `fromSav`).
- **Loans:** giving a loan = `bhd|popular|cash to loan:<name>`; a payment = `loan:<name> to <account where it landed>`. The loan schedule/reminders stay in `prestamos` (reminder logic and "On hold" untouched); only the money part moves into `moves`. The "money came from" choice on lending becomes the `from` account. Dad's 307k is the `dad` account; his Nov 30 repayment is `dad to bhd` of 312k with 5k as income (interest).
- **Score (Plan = savings rate on regular income):** reads `world:income` movements as income and `to` accounts classed as savings/investment as saved; transfers are excluded by kind. Same numbers as today where data was right.
- **Charts (goal progress, savings history):** goal progress = savings accounts (BHD + USD + IBKR + Dad, loans owed excluded as today). History is rebuilt from movements by date, so the chart can never disagree with the balance.
- **Spend tab, categories, limit RD$70,000:** unchanged for the user; reads `kind:spend` movements. Sports (Betcris) stays "not spending", Poker/Arcade categories stay.
- **Friends / base model:** same collections, start empty; a friend with only one bank gets one account. Friends on the old format are migrated by the same script on their own space, later, one at a time.

## 4. Migration (safe, in steps, with backups)

1. **Backup first**, into `backups/`: `index.html`, workers, and a full JSON export of `entries`, `spend`, `corriente`, `prestamos`, `config/main`, `spendMeta/*`, `invest/ibkr`, `pagos`, `topay` (as in `backups/2026-11-27-banklog/`).
2. **Add, don't replace.** Create `accounts` and `moves` next to the old data. Nothing old is deleted.
3. **Opening balances** from the latest confirmed truth: Popular RD$1,855 and BHD RD$112,511 (Nov 27 screenshots), cash RD$50, USD US$1,200, Dad RD$307,000, IBKR from `invest/ibkr`, loans from `prestamos`. Movements before that date are imported for history only and do not change balances.
4. **Convert** history (since Oct 2026, `SP_START`) with a script: each `spend` row + its linked `entries` row (via `savEntry`, `bhdIds`, `ccRef`) becomes one movement. Rows that cannot be linked with certainty go to a short "needs a look" list, not guessed.
5. **Check:** the script prints computed vs. confirmed balance per account and the net worth before/after. Only proceed if every account matches within RD$1, otherwise fix the source data first.
6. **Dual write for ~a week:** ingest/typed logging write the new `moves` and the old rows, the app shows the new balances beside the old ones in a hidden debug view, and any difference is investigated.
7. **Switch the screens** (Savings total, Spend, account cards, loans, score, charts) to `moves`, bump `version.json`, and tell Marco to fully reopen the app (it loads from cache).
8. **Retire the old paths** (`ccEstimate`, `spWalletCalc`, `traslado` handling) after the new numbers have held for a week. Old data stays as an archive.

Each step is one small PR, with a before-backup, tested against the **real** database (not mocks), and confirmed deployed (version signal) before we tell Marco it is live.

## 5. What Marco will notice

- An account card for each of Popular, BHD, Cash, USD, IBKR, Dad: balance + "confirmed <date> by <source>".
- Net worth that equals the sum of those cards.
- Moving money is one tap, and it never shows up as spending or income.
- Fewer "Pato is off" moments; when one happens, it is a visible, dated adjustment instead of silent drift.
- Spend, loans, goal and score look the same; numbers get more trustworthy.

## 6. Risks

- **Migration mistakes** in linking old rows (most likely around combined rows, `bhdIds`, Apple Pay/receipt rows). Mitigation: no deletes, step 5 check, "needs a look" list.
- **Cached app on his iPhone** can write old-format rows while the new code is live. Mitigation: dual write period and a version gate that makes old clients read-only.
- **Missing inflow alerts** (neither bank emails money received) still mean balances can be wrong until confirmed. The model does not remove that; it makes it visible and cheap to fix with a screenshot or a typed number.
- **Cron/ingest concurrency:** two workers writing a balance at once. Mitigation: balances are never stored, only computed, so there is no counter to race on.
- **Scope/cost:** this touches the app, `ingest.js`, Apple Pay, typed logging, loans, score and charts. Estimated as 6 to 8 small PRs, not one big bang. The ingest + migration + dual-write steps give most of the value first.
- **Declined idea overlap:** Marco declined a separate "BHD reconciliation" feature. Here confirmation is automatic and built into each account, not a screen or chore. If he still dislikes the account cards' "confirmed" line, it can be hidden without changing the model.

## 7. Suggested order if Marco says go

1. Backup + export script + read-only account/move computation, checked against his real balances (no screens change).
2. Ingest + Apple Pay + receipts write `moves` (dual write).
3. Typed logging, Move money, cash, USD and loans write `moves`.
4. Account cards + net worth on the new numbers.
5. Score, charts, Spend and Savings switched over.
6. Retire old formulas.
