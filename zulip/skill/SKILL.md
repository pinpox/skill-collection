---
name: zulip
description: Read and write Zulip chat from the command line — channels, topics, messages, DMs, threads, reactions, unread triage and permalinks. Use whenever the user wants to look at, search, summarise, answer or post Zulip messages, mentions a Zulip channel/topic/stream, or gives a zulip link.
---

# Zulip

The `zulip` command talks to the Zulip REST API. It resolves channels, topics and
users from what a human would type, so you never have to look up ids first.

```bash
zulip help                       # full command and filter list
zulip whoami                     # confirm which account and realm you are on
```

Run `zulip help` once at the start of a Zulip task; it is the authoritative
surface and shorter than guessing.

## Reading

```bash
zulip channels                            # subscribed channels, with ids
zulip topics <channel> [--limit N]        # recent topics, newest first
zulip messages --channel deploys --topic "prod v1.2" --limit 30
zulip messages --dm alice --limit 20      # a DM conversation
zulip messages --sender bob --search "restic" --channels public
zulip message 12345                       # one message plus its permalink
zulip unread                              # grouped by conversation, newest first
zulip users bob                           # find a user id/email
zulip link 12345                          # permalink only
```

Channels and users accept an id, an exact name, or a unique case-insensitive
substring (`deploys` finds `deploys ops`). An ambiguous substring is an error
that lists the candidates — pick one and retry rather than guessing.

Filters combine (they AND together): `--channel --topic --dm --sender --search
--is --has --channels --id --anchor`. `--is` takes a comma list from
`unread,starred,mentioned,dm,alerted,followed,muted,resolved`.

Message content is the **raw Markdown** the sender typed, never rendered HTML,
so quoting it back is lossless. `--json` gives the untouched API response for
anything you need to parse.

### Scope of a search

Without a `--channel`, a query only covers **your own message history**. To
search the whole realm's public history add `--channels public`:

```bash
zulip messages --search "borg" --channels public --limit 50
```

## Writing

```bash
zulip send <channel> <topic> "text"        # topic is mandatory — Zulip has no untopicked channel post
zulip send deploys "prod v1.2" - < notes.md   # or pipe the body on stdin
zulip dm alice "text"
zulip dm alice,bob "text"                  # group DM
zulip reply 12345 "text"                   # same channel+topic, or same DM thread
zulip react 12345 tada                     # add; --remove to take yours back
zulip edit 12345 "new text"                # your own message
zulip edit 12345 --topic "better name" --propagate change_all   # rename/move a thread
zulip upload ./diagram.png                 # prints URL + markdown snippet to paste
zulip mark-read --channel deploys          # or: mark-read 123 124 | mark-read --all
zulip delete 12345 --yes                   # irreversible
```

`reply` is the right default for answering: it keeps the conversation in one
thread instead of starting a new topic.

Multi-line bodies and non-ASCII text must reach `zulip` as a single argv element
from a direct exec (the bash tool is fine). For anything long, write the body to
a file and pipe it in — that avoids quoting mistakes entirely.

## Conventions to follow

- **Never post without being asked to.** Reading, searching and summarising are
  safe; sending, editing, reacting and deleting are not. Show the user what you
  intend to send if there is any doubt, and quote the exact channel and topic.
- **Do not mark things read as a side effect.** Reading messages never changes
  flags — only explicit `mark-read` does. Don't "tidy up" unread counts.
- Sign nothing and add no "sent by an assistant" footer unless the user asks.
- Match the language of the thread you are answering in.
- `delete` and `mark-read --all` need explicit intent; confirm first.

## Credentials

First hit wins:

1. `ZULIP_SITE` + `ZULIP_EMAIL` + `ZULIP_API_KEY` in the environment
2. `--zuliprc <path>` or `$ZULIPRC`
3. `--passage <entry>` or `$ZULIP_PASSAGE_ENTRY` (decrypted via `passage show`)
4. `~/.zuliprc`

A zuliprc is the INI file the web UI hands out:

```ini
[api]
email=you@example.com
key=<api key>
site=https://zulip.example.com
```

Get the key from **Settings → Account & privacy → API key** (or the bot's
management page). If a command reports `credentials … rejected`, the key is
stale — ask the user to regenerate it; never invent one. `zulip server <url>`
works with no credentials at all and reports the realm name, version and login
methods, which is the quickest way to check a URL is a Zulip instance.

## Notes

- Exit codes: `0` ok · `1` runtime/API error · `2` unknown command.
- Errors print Zulip's own message plus its machine-readable code, e.g.
  `zulip: Invalid message(s) [BAD_REQUEST]`.
- Permalinks are built the way the server builds them
  (`#narrow/channel/<id>-<name>/topic/<topic>/near/<id>`), so they open the
  message in the web app.
- `--limit` is a single page. `unread` defaults to 200 messages and says when it
  truncated; raise `--limit` if so.
- The wrapper brings its own `node`; the tool has no other dependencies.
