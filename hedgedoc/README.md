# hedgedoc

Read and edit [HedgeDoc](https://hedgedoc.org) / CodiMD notes from the command
line, given nothing but a note URL.

```bash
hedgedoc <note-url> get                 # print markdown to stdout
hedgedoc <note-url> set    < new.md     # replace the note from stdin
hedgedoc <note-url> append < extra.md   # append to the note
```

## Why this exists

HedgeDoc's REST API can **create** a note (`POST /new`) and **read** one
(`GET /<id>/download`), but there is **no endpoint that edits an existing
note**. `codimd-cli`'s `update` targets `PUT /api/notes/:id`, which HedgeDoc
answers with a 404. The only way to change a note is the realtime socket.io +
operational-transform channel the web editor speaks.

This client speaks that channel directly, with zero npm dependencies — Node's
built-in `WebSocket` (so Node ≥ 22) and nothing else. It targets modern
HedgeDoc/CodiMD (socket.io v4 / engine.io 4) and falls back to EIO3 for old
instances.

There is deliberately no `patch` command: `get`, edit the markdown wherever you
like, `set` it back.

## Auth

Notes with permission `freely` need no setup. For anything stricter, pass a
logged-in session cookie:

```bash
HEDGEDOC_COOKIE='connect.sid=s%3A...' hedgedoc "$URL" set < new.md
```

Exit codes: `0` ok · `1` connection/runtime error · `2` usage · `3` edit
rejected (permission).

## Install

```bash
nix run github:pinpox/skill-collection#hedgedoc -- https://pad.example.org/abc123 get
```

See [skill/SKILL.md](skill/SKILL.md) for the agent-facing notes.
