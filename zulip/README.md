# zulip

Read and write [Zulip](https://zulip.com) chat from the command line: channels,
topics, messages, DMs, threads, reactions, unread triage, uploads, permalinks.

```bash
zulip help                                        # full surface
zulip messages --channel deploys --topic "prod v1.2" --limit 30
zulip unread                                      # grouped by conversation
zulip reply 12345 "on it"
zulip send deploys "prod v1.2" - < notes.md
```

## Why this exists

`python3Packages.zulip` ships `zulip-send`, which can only send, and
`zulip-term` is a TUI. Neither is usable as a scriptable read/write client, so
this is a small client for the endpoints that matter, with zero npm
dependencies — `fetch` plus HTTP Basic auth is the whole of the Zulip API.

Design notes, all of them chosen for calling from an agent:

- **Names, not ids.** Channels and users resolve from an id, an exact name, or a
  unique case-insensitive substring; an ambiguous one errors and lists the
  candidates.
- **Raw Markdown.** Messages are fetched with `apply_markdown=false`, so
  `content` is what the sender typed and round-trips through `edit`.
- **Reading never writes.** Flags change only via `mark-read`; sends set
  `read_by_sender` so your own message doesn't land in your unread count.
- **Server-accurate permalinks.** The hash encoding follows
  `zerver/lib/url_encoding.py` (`%`→`.`, `.`→`.2E`), so links open the message.
- **Correctness details the API demands:** `narrow` in object form (the legacy
  tuple form cannot carry integer operands), `to` as a channel id or JSON, and
  `reaction_type`/`emoji_code` echoed back when removing a reaction (`DELETE`
  defaults to `unicode_emoji` instead of inferring it, so custom emoji would
  otherwise not be found).

Verified against Zulip 12.1, API feature level 500.

## Credentials

First hit wins:

1. `ZULIP_SITE` + `ZULIP_EMAIL` + `ZULIP_API_KEY`
2. `--zuliprc <path>` / `$ZULIPRC`
3. `--passage <entry>` / `$ZULIP_PASSAGE_ENTRY` — decrypted with `passage show`,
   so the key can stay in an age-encrypted store instead of a plaintext dotfile
4. `~/.zuliprc`

A zuliprc is the INI file the web UI hands out (**Settings → Account & privacy →
API key**):

```ini
[api]
email=you@example.com
key=<api key>
site=https://zulip.example.com
```

`zulip server <url>` needs no credentials and prints the realm name, version and
enabled login methods.

Exit codes: `0` ok · `1` runtime/API error · `2` unknown command.

## Install

```bash
nix run github:pinpox/skill-collection#zulip -- whoami
```

See [skill/SKILL.md](skill/SKILL.md) for the agent-facing notes.
