# plann

[`plann`](https://plann.no) is a CalDAV command-line client for calendars and
task lists. It is not in nixpkgs, so this entry builds it and ships the agent
skill that documents it.

```bash
nix run github:pinpox/skill-collection#plann -- list-calendars
```

## Source pin

`src` points at [`pinpox/plann`](https://github.com/pinpox/plann), not upstream
`pycalendar/plann`. The fork carries `caldav_pass_command`, which lets the
CalDAV password be read from an external command instead of sitting in
plaintext in `~/.config/calendar.conf`:

```yaml
default:
  caldav_url: "https://dav.example.com/dav/cal"
  caldav_user: someone@example.com
  caldav_pass_command: "passage show my-calendar"
```

That change is under review upstream in
[pycalendar/plann#46](https://github.com/pycalendar/plann/pull/46). Once it is
merged, repoint `src` at `pycalendar/plann` and drop the fork.

Note that stock plann does **not** merely ignore an unknown `caldav_pass_command`
key — it forwards every `caldav_*` key to `DAVClient` and dies with
`TypeError: DAVClient.__init__() got an unexpected keyword argument
'pass_command'`. So a config written for the fork needs the fork.

## Configuration

Deliberately out of scope for both this package and the skill: the config file
is per-user (server, credentials, calendar ids). See the
[plann README](https://github.com/pycalendar/plann#configuration-file) for the
format. The skill assumes `~/.config/calendar.conf` already exists and works.

## Skill

[`skill/SKILL.md`](skill/SKILL.md) — installed to `$out/share/skills/plann/`.
