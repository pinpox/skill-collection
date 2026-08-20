---
name: gitea
description: Read and write issues on Gitea/Forgejo instances (list, show, create, comment, edit, label, close) from the command line via the `tea` CLI, across several instances. Use whenever the user wants to look at, file, answer, triage or close a Gitea/Forgejo issue, mentions a gitea/forgejo link, or says "tea".
---

# Gitea issues via `tea`

`tea` is Gitea's official CLI. It talks to **any number of instances**: each one
is a named _login_ (server URL + API token) in `$XDG_CONFIG_HOME/tea/config.yml`,
written by `tea logins add`. The user's logins already exist; never add, edit or
delete one without being asked.

```bash
tea logins ls          # names, URLs, users — start here
tea whoami             # who the default/inferred login authenticates as
```

## Picking the right instance (read this first)

Three ways a command finds its instance and repository, in order of preference:

1. **From the git remote of `$PWD`.** Inside a clone whose remote host matches a
   login, plain `tea issues ls` / `tea issues 4` / `tea comment 4 "..."` just
   work — right instance, right repo, no flags.
2. **Explicitly:** `-l <login> -r <owner>/<repo>`.
3. Neither → tea prints `NOTE: no gitea login detected, falling back to login
'<first login>'` and queries **that** instance.

So: **outside a matching clone, always pass `-l`.** `tea issues ls -r foo/bar`
alone will silently ask the wrong server and usually die with `Error: not found`.

`-r` takes an `owner/repo` slug or a **local path**, never a URL —
`-r https://git.example.org/foo/bar` fails with `user does not exist [uid: 0,
name: https:]`. Given a browser URL, split it yourself: the host picks the `-l`
login, the first two path segments are the slug, the trailing number is the
issue index.

Every issue/comment/label/milestone command accepts `-l`, `-r` and `-R <remote>`.

## Reading

```bash
tea issues ls                                  # open issues of the context repo
tea issues ls -l git.example.org -r foo/bar --state all --limit 50
tea issues ls --labels bug,Type/Enhancement --milestone v2 --author pinpox
tea issues ls --assignee pinpox --keyword "search words"
tea issues ls --mentions pinpox --from 2026-01-01 --until 2026-06-01
tea issues ls -K all                           # issues *and* pull requests
tea issues ls -l git.example.org --owner someorg   # across all repos of an owner
tea issues ls -l git.example.org               # across every repo you can see
```

Filters are `--state all|open|closed` (default `open`), `--labels/-L`,
`--milestones/-m`, `--author/-A`, `--assignee/-a`, `--mentions/-M`, `--keyword/-k`,
`--owner`, `--from/--until`, `--page/-p`, `--limit/--lm` (default 30).

Show one issue with its discussion:

```bash
tea issues 4 --comments            # rendered issue + all comments
tea issues 4 -o json               # index, title, state, body, labels, assignees, url, comments
```

Output shape: `-o simple|table|csv|tsv|yaml|json` (default `table`). For lists,
`-o json` emits **only the `--fields` columns**, so widen them first:

```bash
tea issues ls -o tsv -f index,state,title,labels,assignees,updated,url
```

Available list fields: `index,state,kind,author,author-id,url,title,body,created,
updated,deadline,assignees,milestone,labels,comments,owner,repo`.

## Writing

Confirm with the user before anything that lands on a server — issues, comments
and state changes are public and mailed to watchers.

```bash
# create — --title is required; without it tea exits 1 ("title is required")
tea issues create --title "Short imperative summary" --description "$(cat <<'EOF'
Body in Markdown.

Second paragraph.
EOF
)"
tea issues create -l git.example.org -r foo/bar -t "Title" -d "Body" \
  --labels bug --assignees pinpox --milestone v2 --deadline 2026-09-01

# comment — body as argument, or on stdin
tea comment 4 "on it"
some-command | tea comment 4

# edit — same flags, plus label add/remove; "" unsets a property
tea issues edit 4 --title "New title" --description "Rewritten body"
tea issues edit 4 --add-labels bug,docs --add-assignees pinpox --milestone v2
tea issues edit 4 --remove-labels docs --milestone ""

# state
tea issues close 4 7 9
tea issues reopen 4
```

`--labels` and `--add-labels` **silently ignore labels the repo does not have**:
the issue is created/edited, exit code 0, no label attached. Check first, and
create the label if it should exist:

```bash
tea labels ls -l git.example.org -r foo/bar --limit 100
tea labels create --name bug --color ff0000 --description "broken"
tea milestones ls --state all
tea milestones create --title v2 --description "next release"
```

Interactive prompts (`--comments`, missing fields, `preferences.editor`) only
fire on a TTY; with stdin redirected tea just proceeds. Still pass every field
explicitly rather than relying on that.

## What `tea` cannot do — use `tea api`

No subcommand exists for editing or deleting a comment, deleting or locking an
issue, reactions, or attachments. `tea api` performs an authenticated request
with the login's token and prints the raw JSON:

```bash
tea api -l git.example.org '/repos/foo/bar/issues/4/comments'        # ids + bodies
tea api -l git.example.org -X PATCH -f body="fixed wording" \
  /repos/foo/bar/issues/comments/1234
tea api -l git.example.org -X DELETE /repos/foo/bar/issues/comments/1234
tea api -X POST -f content=+1 /repos/{owner}/{repo}/issues/4/reactions
tea api -X POST -F labels='["bug","docs"]' /repos/{owner}/{repo}/issues/4/labels
```

- The path is prefixed with `/api/v1` unless it already starts with `/api/` or
  `http(s)://`; `{owner}`/`{repo}` expand from the repo context.
- `-f k=v` string field, `-F k=v` typed/JSON field (`@file`, `@-` for stdin),
  `-d '<json>'` a raw body. Any body makes the method default to POST.
- Quote endpoints containing `?` or `&`.

`tea api` is also the way to get fields the pretty printers drop (`created_by`,
`html_url`, `milestone`, timestamps): pipe it through `jq`.

## Related surfaces

- `tea pr ls|create|checkout|merge` — pull requests (same context/flags).
- `tea notifications ls --mine` / `tea notifications read <id>` — inbox triage.
- `tea open --repo foo/bar` — open in the browser (only when the user asks).

## Conventions

- Reference issues as `#<index>` (the per-repo number in URLs), never the
  internal `id` — `tea api` responses carry both.
- Issue text is Markdown; Gitea autolinks `#123` and `@user` inside a repo.
- Exit codes: `0` ok, `1` any error (unknown login, missing repo, API refusal).
  Errors go to stderr as `Error: ...`; check them, tea will not retry.
- Read commands are safe to run freely. Anything that writes, run once and
  report the resulting URL, printed by `tea issues create`.
