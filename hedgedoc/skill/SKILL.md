---
name: hedgedoc
description: Read and edit HedgeDoc / CodiMD collaborative markdown notes from just a note URL. Use whenever the user gives a hedgedoc/pad link (e.g. https://pad.example.org/abc123) and wants you to read, change, replace, or append to its content.
---

# HedgeDoc note editing

Give this skill a note URL and it reads or edits the note's markdown. The
`hedgedoc` command is on `PATH`:

```bash
hedgedoc <note-url> get                 # print markdown to stdout
hedgedoc <note-url> set    < new.md     # replace whole note from stdin
hedgedoc <note-url> append < extra.md   # append stdin to the note
```

## To "edit something" in a note

There is no patch command on purpose — `get` + `set` is the universal primitive:

1. `get` the current markdown.
2. Make the change in your own context (the editing intelligence is yours).
3. `set` the full new markdown back.

```bash
hedgedoc "$URL" get > /tmp/note.md
# ...edit /tmp/note.md however the user asked...
hedgedoc "$URL" set < /tmp/note.md
```

Always `get` and show/confirm before a destructive `set` if the user was vague.

## Why not curl / the REST API / codimd-cli

HedgeDoc's REST API can **create** (`POST /new`) and **read** (`GET /<id>/download`)
notes but has **no endpoint to edit an existing note**. `codimd-cli`'s `update`
command targets `PUT /api/notes/:id`, which does **not exist** on HedgeDoc (verified:
returns HTTP 404). The only way to change a note is the realtime socket.io +
operational-transform channel the web editor uses — which is exactly what `hd.mjs`
speaks, directly, with zero npm dependencies (Node's built-in WebSocket only).

## Auth

The note's permission decides who may edit:

- `freely` — anyone may edit; anonymous works, no setup.
- `editable` / `limited` — only logged-in users.
- `locked` / `private` / `protected` — only the owner.

For anything other than `freely`, supply a logged-in session cookie. Open the note
in a browser while logged in, copy the `connect.sid` cookie from dev-tools, and:

```bash
HEDGEDOC_COOKIE='connect.sid=s%3A...' hedgedoc "$URL" set < new.md
```

If an edit is rejected for permission reasons the script exits **3** and prints the
note's permission so you know whether a cookie is needed.

## Requirements & notes

- The wrapper brings its own `node` (needs the built-in `WebSocket`, Node ≥ 22).
- Targets modern HedgeDoc/CodiMD (socket.io v4, engine.io 4); falls back to EIO3 best-effort for old instances.
- Persisting is automatic: the server flushes dirty notes every ~1s and again when
  the last client disconnects; the script lingers ~1.7s after the server `ack` before closing.
- Exit codes: `0` ok · `1` connection/runtime error · `2` usage · `3` edit rejected (permission).
- Verify a write with `... get` or `curl -fsS <url>/download`.
