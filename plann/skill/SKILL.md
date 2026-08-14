---
name: plann
description: Read and write the user's CalDAV calendars and task lists from the command line via the `plann` CLI. Use whenever the user wants to see their agenda, find their next event, add/edit/complete events, todos or journal entries, or mentions plann/caldav/their calendar.
---

# Calendars and tasks via `plann`

`plann` is a CalDAV command-line client. It is on `PATH` and **already
configured** — `~/.config/calendar.conf` holds the server, credentials and
calendar selection. Never write or "fix" that file, and never pass
`--caldav-url`/`--caldav-pass`: just run the tool.

```bash
plann <global options> <command> ...
```

Confirm connectivity and see which calendars the config exposes:

```bash
plann list-calendars
```

## Choosing calendars

The config is split into sections; the `default` section is used unless told
otherwise. Sections are selected globally, before the subcommand:

```bash
plann --config-section work select --event list
plann --config-section '*' list-calendars      # every section (glob patterns work)
```

Run `plann list-calendars` first if you need to know what exists — do not guess
section names.

## Reading

`select` filters, then a subcommand acts on the selection.

```bash
plann select --event --start=today --end=+30d list
plann select --todo list
plann select --journal --start=-7d --end=now list
plann agenda                                    # events +7d and todos, convenience
```

Timestamps accept ISO values, relative offsets (`+30d`, `-7d`) and natural
language via dateparser (`now`, `today`, `tomorrow`, `next monday`, `3 hours ago`).

Useful selection flags: `--summary`, `--category`, `--location`, `--status`,
`--uid`, `--include-completed`, `--has-due`/`--no-due`, `--skip-children`,
`--skip-parents`.

Sorting and slicing happen **after** the search, in this order: sort by
`--sort-key` (default: `DTSTART` ascending), then `--offset`, then `--limit`.

```bash
plann select --event --start=now --end=+90d --limit=1 list     # next event
plann select --todo --sort-key '-{PRIORITY}' --limit=10 list
```

Output subcommands: `list` (one line per object), `print-ical`, `print-uid`,
`list-categories`, `sum-hours`.

`list` takes `--template` for custom output, and `--top-down`/`--bottom-up` to
render parent/child task hierarchies:

```bash
plann select --todo list --template '{DUE:?{DTSTART:?(no date)?}?%F}: {SUMMARY} [{CATEGORIES:?-?}]'
```

## Writing

```bash
plann add event "release party" 2026-11-30T19:00+2h
plann add event "bughunting" 2026-11-25+5d          # date + duration
plann add todo "change oil" --set-due 2026-09-01 --set-priority 2
plann add journal "trip notes"
```

`add event` takes positional `SUMMARY TIMESPEC` — **not** `--set-summary`.
TIMESPEC is an ISO date/timestamp with an optional `+duration` suffix.

Editing and completing go through `select`:

```bash
plann select --uid <uid> edit --set-summary "new title"
plann select --todo --summary 'oil' complete
plann select --uid <uid> delete
```

Get a uid first with `plann select ... print-uid` or `list --template '{UID} {SUMMARY}'`.

`delete` is permanent — confirm intent with the user before running it.

If more than one calendar is selected, `add` prompts and can duplicate the
object into _every_ selected calendar. Select a single calendar (via
`--config-section`) before writing, or pass `--first-calendar`.

There are also `plann interactive` subcommands (`manage-tasks`, `check-due`,
`dismiss-panic`, …). They are prompt-driven REPLs — do not invoke them from a
non-interactive agent context; they will hang.

## Gotchas

- **`--event` and `--todo` in one query crash.** caldav raises
  `ConsistencyError: inconsistent search parameters`. Query one component class
  per invocation and merge the results yourself.
- **`plann select <subcommand> --help` still hits the server.** The `select`
  group callback runs the CalDAV search before the subcommand's help is
  printed, so it can take minutes. Use `plann select --help` for the filter
  flags, and read subcommand help sparingly.
- **Never merge stderr into stdout when counting or parsing.** caldav writes
  compatibility warnings — including full iCalendar dumps — to stderr. A
  `2>&1 | wc -l` will silently count warning lines as results. Always `2>/dev/null`.
- **`--all` skips sorting and slicing.** It returns before the sort/limit stage,
  so results are unordered and `--limit`/`--offset`/`--sort-key` are ignored.
  Sort in the shell if you use it.
- **Empty output means zero matches**, not an error; `list` prints one blank
  line. Exit status stays 0.
- **Rate limiting.** `list` fetches **one GET per object**, so the cost scales
  with the calendar's size, not with the number of invocations. caldav raises
  `RateLimitError` on HTTP 429/503 and does **not** retry. Measured against
  Stalwart 0.16.13 (1000 authenticated requests/min per account): a
  98-object calendar lists fine, a 1664-object one dies mid-run with
  `Retry-After: 42`. Never run `--all` against a large calendar; bound the
  selection first, and back off ~60 s after a failure instead of retrying.
- **Time-range searches return 0 on a non-empty calendar (Stalwart).** The
  cause is server-side and now pinned down: Stalwart 0.16.13 does not
  serialise `<C:calendar-data/>` inside a `calendar-query` REPORT, so caldav
  receives matches with no payload and yields nothing. Isolated against a
  1664-object calendar:

  | request | result |
  |---|---|
  | `calendar-query` + time-range, `getetag` only | 8 hrefs for the month, correct |
  | `calendar-query` + time-range, with `calendar-data` | 1 |
  | `calendar-query` no filter, with `calendar-data` | 1 |
  | `calendar-multiget` with explicit hrefs | every object, correct |

  So both the time-range filter and object serialisation work — only their
  combination in `calendar-query` is broken. Objects that plann created itself
  are returned, which is why a self-authored test event never reproduces it.

  Until it is fixed, don't read Stalwart calendars through plann. Query for
  hrefs and then fetch them with `calendar-multiget` (two curl requests, still
  server-side filtered), or accept `--all` on calendars small enough to
  survive one GET per object. Nextcloud serialises `calendar-data` correctly,
  so ordinary plann reads work there.
