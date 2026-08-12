# kleinanzeigen

CLI for [kleinanzeigen.de](https://www.kleinanzeigen.de) (ex eBay
Kleinanzeigen). Talks to the mobile app's JSON API instead of scraping the
website, so listings come back as structured data — typed attributes, GPS
coordinates, ISO timestamps, price type — and the account side (chat,
notifications, own ads) is reachable at all.

## Features

- **Search without an account** — location and category are resolved from plain
  names, so `--location Köln` just works instead of demanding an internal id
- **Chat** — list conversations, read a thread, reply, or open a new one on
  somebody's ad
- **Notifications** — the push feed: saved-search hits and followed-ad updates
- **One login, then nothing** — Auth0 authorization-code + PKCE in the browser
  once; after that a refresh token in
  `~/.local/state/kleinanzeigen/session.json` (mode 600) keeps it alive

## Install

```bash
nix run github:pinpox/skill-collection#kleinanzeigen -- search fahrrad --location Köln
```

Or add `skill-collection.packages.${system}.kleinanzeigen` to your home-manager
packages.

## Usage

```bash
kleinanzeigen help
kleinanzeigen search "dahon faltrad" --location Köln --radius 20 --max 300
kleinanzeigen ad 3483320665
kleinanzeigen login                       # one-time browser sign-in
kleinanzeigen notifications --unread
kleinanzeigen conversations --unread
kleinanzeigen reply <conversation-id> "Ist das noch verfügbar?"
```

See [skill/SKILL.md](skill/SKILL.md) for the full command reference and the
non-obvious parts (bot detection, 2FA, id formats).

## How it works

Two hosts, two auth schemes:

| host                       | scope                                                                 | auth                                                        |
| -------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `api.kleinanzeigen.de`     | search, ads, categories, locations, own ads, watchlist, notifications | app HTTP Basic, plus the user's access token in two headers |
| `gateway.kleinanzeigen.de` | chat ("messagebox")                                                   | `Authorization: Bearer <access token>`                      |

The classifieds host answers in JAXB-flavoured JSON where every scalar hides
under a `value` key; the client unwraps that centrally and decodes the
HTML-escaped text, so callers see plain JSON.

Kleinanzeigen's terms of service forbid automated access. This is meant for
personal, low-volume use — no polling loops, no bulk messaging.
