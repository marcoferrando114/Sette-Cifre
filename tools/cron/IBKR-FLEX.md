# IBKR auto-sync (Flex Web Service, read-only)

A Flex token can only download reports. It cannot trade or move money.

## In IBKR (Client Portal, on a computer)
1. Performance & Reports > Flex Queries > Activity Flex Query > **+**. Name it `Pato`.
2. Sections: **Open Positions** (Options: Summary; fields: Symbol, Asset Category, Position, Cost Basis Price, Cost Basis Money, Mark Price, Currency) and **Cash Report** (fields: Currency, Ending Cash).
3. Format XML, Period **Last Business Day**, Save. Note the **Query ID** (number in the list).
4. Same page > Flex Web Service > Configure > Generate token (12 months, no IP restriction). Copy the token.

## In Cloudflare (Workers > pato-cron > Settings > Variables and Secrets)
- `FLEX_TOKEN` = the token (type Secret)
- `FLEX_QUERY` = the Query ID (type Text)
Deploy. Also make sure `BOT_PASSWORD` is set (needed for the whole worker).

## Test
Open `https://pato-cron.<your-subdomain>.workers.dev/flex?pw=<BOT_PASSWORD>` for a preview (nothing written). Add `&apply=1` to write.
After that it syncs by itself at the first stock tick of each day.

Rules: data is as of the last close; a position the app shows as bought after the statement date is left alone; cash is replaced by IBKR's; free-share (regalo) flags and notes are kept; backup of the previous doc in KV `cron:ibkr-backup-flex`.
