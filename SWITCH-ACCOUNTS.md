# Switching Pato to a second Claude account

Do this when the first account runs out of usage. No passwords or keys go in this file or in chat; type them only in settings screens.

## Checklist
1. **New project.** In the second account, create a project and add the repo `marcoferrando114/sette-cifre` (connect GitHub when asked: https://claude.ai/connect-github, and make sure the Claude GitHub App is installed on the repo).
2. **First message to Claude:** "Read PATO-CONTEXT.md in the repo first, then continue helping Marco with Pato." Marco's rules (answer directly, back up before each change, Errands private, never write the Joshua reason) are in that file.
3. **Gmail connector.** Settings > Connectors > connect Gmail with the account that gets the BHD bank emails (needed only for Marco's own bank sync).
4. **Cloud environment.** Create one at claude.ai/code with the repo attached.
   - Network access: `firestore.googleapis.com`, `identitytoolkit.googleapis.com`, `marcoferrando114.github.io`, `query1.finance.yahoo.com`.
   - Environment variable (secret): `STAKD_BOT_PASSWORD` = the sync robot's password. It is the same value as the `BOT_PASSWORD` secret in Cloudflare (pato-cron). Type it only in the environment settings.
5. **Recreate the Gmail/BHD sync task** (the only scheduled job that still needs Claude): 4 runs a day at 7am, 12pm, 5pm, 10pm DR, with the Gmail connector on, using `tools/stakd_db.py` to write to Marco's space (uid in PATO-CONTEXT.md), plus the smart alerts step. If the old task's prompt is still in the first account, copy it over. The old Claude tasks for stock prices and loan reminders are NOT needed: pato-cron does them.
6. **Cloudflare stays the same.** Workers pato-ai, pato-mail, pato-cron keep running with no Claude. Deploys happen when a PR merges to `main`. Cloudflare variables are in the Cloudflare dashboard, not in either Claude account.
7. **Check it works.** Ask Claude to run the sync once and confirm new spending appears in the app, and open Cloudflare > pato-cron > Logs to see the last stock run.

## Can the Gmail sync move to Cloudflare?
Not safely yet. pato-mail reads Gmail with a Google sign-in per user, and today it is set up for friends only (Marco's own bank emails come from his school/personal mailbox through the Claude Gmail connector, with judgment rules for BHD, combining rows and loan payments). Moving it would need Marco to connect Google once in pato-mail (its `GOOGLE_ID`/`GOOGLE_SECRET` must also be fixed first) and a test against his existing rows. Until then, keep it as a Claude task.
