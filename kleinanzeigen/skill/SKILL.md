---
name: kleinanzeigen
description: Search kleinanzeigen.de listings and use the user's account — read notifications, read and answer message threads, and write to sellers — through the `kleinanzeigen` CLI. Use whenever the user wants to look for something on Kleinanzeigen (ex eBay Kleinanzeigen), check their Kleinanzeigen messages/notifications, reply to a buyer or seller, or contact somebody about an ad.
---

# Kleinanzeigen

`kleinanzeigen` is a CLI talking to the Kleinanzeigen mobile app API. It is on
`PATH`; the source lives in the `kleinanzeigen/` directory of the
[skill-collection](https://github.com/pinpox/skill-collection) repo.

```bash
kleinanzeigen help          # full option list
```

Two halves:

- **Search and listings** need no login at all.
- **Notifications, chat and own ads** need a one-time browser sign-in
  (see [Login](#login)). The refresh token is kept in
  `~/.local/state/kleinanzeigen/session.json` (mode 600) and renewed silently.

Every listing command prints one compact line per item; add `--json` when you
need to parse fields (`jq`) or want everything the API returned.

## Searching

```bash
kleinanzeigen search fahrrad --location Köln --radius 10 --max 200 --size 10
kleinanzeigen search "dahon faltrad" --sort cheap --pictures
kleinanzeigen search --category 217 --location 945 --sort new     # whole category
kleinanzeigen ad 3483320665                                       # full ad + description
```

Options: `--location <name|id>` (`--radius <km>`, default 0 = that place only),
`--min`/`--max` (€), `--category <id>`, `--type OFFERED|WANTED`,
`--sort new|old|cheap|expensive|near`, `--pictures`, `--no-topads`,
`--size N` (max 41), `--page N`.

Ids for the two filter dimensions:

```bash
kleinanzeigen locations Köln       # 945  Köln        (city, broadest match first)
kleinanzeigen categories           # top level
kleinanzeigen categories 217 --depth 2
```

`--location` takes a plain name and resolves it itself; pass an id when the name
is ambiguous. Result rows are `id · price · title · zip city · posted · url`.
A `--size N` search can return N+1 rows — one of them is a paid top ad
(`--no-topads` drops those).

## Login

Needed once, then never again unless the user revokes it. Two steps, because
the sign-in itself happens in the user's own browser:

```bash
kleinanzeigen login                       # prints the sign-in URL
kleinanzeigen login --url '<full URL the browser ended up on>'
```

**Use the user's real browser (Firefox here), not the `browser` tool.**
Kleinanzeigen sits behind Akamai bot detection: the sign-in form loads fine in a
headless Chromium, but the credential POST answers
"IP-Bereich vorübergehend gesperrt" every time. The account also has SMS 2FA, so
the login cannot be automated anyway.

Practical flow:

1. `kleinanzeigen login` → take the printed
   `https://login.kleinanzeigen.de/authorize?...` URL.
2. `firefox '<url>'` opens it in the running instance. The user signs in and
   confirms the SMS code; the tab ends on
   `https://login.kleinanzeigen.de/android/com.ebay.kleinanzeigen/callback?code=…&state=…`,
   which renders as a blank/broken page. That is expected.
3. Ask the user for that address-bar URL and finish with
   `kleinanzeigen login --url '<url>'`.

Never type the user's password yourself. If you want step 3 without asking for a
paste, the URL is also in Firefox's session store — this reads every open tab, so
only do it when the user is fine with that:

```bash
nix-shell -p 'python3.withPackages(ps: [ps.lz4])' --run 'python3 -c "
import lz4.block, json
d=open(\"$HOME/.mozilla/firefox/pinpox/sessionstore-backups/recovery.jsonlz4\",\"rb\").read()
j=json.loads(lz4.block.decompress(d[8:]))
print([e[\"url\"] for w in j[\"windows\"] for t in w[\"tabs\"] for e in t[\"entries\"]
       if \"com.ebay.kleinanzeigen/callback\" in e[\"url\"]][-1])"'
```

The file is rewritten every ~15 s, so poll it for a minute or so.

`--force` adds `prompt=login` and always asks for the password again. Check state
with `kleinanzeigen whoami`; `kleinanzeigen logout` drops the local session (it
does not revoke the token server-side).

## Notifications and messages

```bash
kleinanzeigen notifications --unread --size 10
kleinanzeigen conversations --unread        # inbox, newest first
kleinanzeigen conversation 37zpx:1hhd44:2pngd7v8v
kleinanzeigen reply 37zpx:1hhd44:2pngd7v8v "Alles klar, danke dir!"
kleinanzeigen contact 3483320665 "Hallo, ist der Artikel noch verfügbar?"
kleinanzeigen mark-read 37zpx:1hhd44:2pngd7v8v
```

- `notifications` is the push feed, not the inbox: `SAVED_SEARCH` hits (a saved
  search found something), `FOLLOW_AD` and `FOLLOW_AD_IMAGE_ADDED` (a watched ad
  changed). Rows are `time · NEW · type · text · url`. There is no
  mark-as-read for these.
- `conversations` rows are
  `conversation-id · unread · last message · counterparty · ad title · ad id`.
  Conversation ids are colon-separated strings like `37zpx:1hhd44:2pngd7v8v` —
  quote them. The **ad id** at the end is what `ad` and `contact` take.
- In a thread, `me` is the user and `them` the other side; the header says
  whether the user is Buyer or Seller on that ad.
- Reading a thread with `conversation` marks it read server-side (it is a PUT).
- `contact <ad-id>` is only for the _first_ message on an ad: it opens the thread
  and sends the text; afterwards use `reply` with the conversation id.
  `--name X` sets the display name shown to the seller (defaults to the local
  part of the account's email). Contacting one's own ad is rejected with a
  confusing HTTP 500 — that is the API's way of saying "not allowed".
- `my-ads` and `watchlist` list the user's own ads and saved ads.

## Rules

- **Never send a message on the user's behalf without showing the exact text
  first and getting an explicit go-ahead.** `reply` and `contact` are
  irreversible and land in a stranger's inbox under the user's name.
- German is the default for anything a counterparty reads; match the tone the
  user already used in the thread.
- Kleinanzeigen's ToS forbid automation, so keep it personal and low-volume: no
  polling loops, no bulk messaging, no scraping runs. A handful of requests per
  task is fine.

## When something breaks

- `HTTP 401/403 … (token rejected)` — the refresh token is stale; run the login
  flow again.
- `403 "IP-Bereich vorübergehend gesperrt"` on a _CLI_ call — the request was
  fingerprinted as a blacklisted app version, not a real IP ban. The CLI already
  avoids the header that triggers it (`X-ECG-USER-AGENT: ebayk-android-app-13.4.2`);
  do not reintroduce an old version string.
- The same message on a _sign-in page_ — Akamai rejecting an automated browser.
  Use the user's normal browser.
- Empty search results with `--location`: the name resolved to something
  unexpected. Check with `kleinanzeigen locations <name>` and pass the id.
