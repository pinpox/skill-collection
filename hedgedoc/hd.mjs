#!/usr/bin/env node
// Headless HedgeDoc note editor over the realtime collaboration protocol.
//
// HedgeDoc has NO REST endpoint to edit an existing note (only /new to create
// and /<id>/download to read). The only way to change a note's content is the
// same socket.io + operational-transform (OT) channel the web editor uses.
// This speaks that protocol directly over a raw WebSocket — no dependencies.
//
// Usage:
//   hedgedoc <note-url> get                 # print note markdown to stdout
//   hedgedoc <note-url> set    < new.md     # replace whole note from stdin
//   hedgedoc <note-url> append < extra.md   # append stdin to the note
//
// Auth: anonymous works only when the note permission is "freely". For
// "editable"/"limited"/"private" notes export a logged-in session cookie:
//   HEDGEDOC_COOKIE='connect.sid=s%3A...'  (copy from a browser dev-tools)
//
// Exit codes: 0 ok · 1 runtime/connection error · 2 usage · 3 edit rejected.

import { argv, env, stdin, stdout, exit } from "node:process";

const [, , noteUrl, cmd = "get"] = argv;
const VALID = new Set(["get", "set", "append"]);
if (!noteUrl || !VALID.has(cmd)) {
  console.error(
    "usage: hedgedoc <note-url> get|set|append   (set/append read stdin)",
  );
  exit(2);
}

const u = new URL(noteUrl);
const base = `${u.protocol}//${u.host}`;
const wsBase = base.replace(/^http/, "ws");
const noteId = u.pathname.replace(/^\/+/, "").split("/")[0];
if (!noteId) {
  console.error("could not parse note id from url");
  exit(2);
}

function readStdin() {
  return new Promise((res) => {
    if (stdin.isTTY) return res("");
    let d = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (c) => (d += c));
    stdin.on("end", () => res(d));
  });
}

// Grab an anonymous express session cookie (the realtime `secure` middleware
// rejects sockets with no cookie at all) and detect the engine.io version.
async function bootstrap() {
  let cookie = env.HEDGEDOC_COOKIE || "";
  if (!cookie) {
    const r = await fetch(`${base}/${noteId}`, { redirect: "manual" });
    cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  }
  let eio = 4;
  try {
    const p = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    eio = (await p.text()).startsWith("0{") ? 4 : 3;
  } catch {
    /* default to 4 */
  }
  return { cookie, eio };
}

// ot.js TextOperation JSON: +n retain, "str" insert, -n delete.
// baseLength MUST equal current doc length in UTF-16 code units (== JS .length,
// which is what CodeMirror/HedgeDoc count), so emoji/surrogate pairs are safe.
const opReplaceAll = (oldS, newS) =>
  [oldS.length ? -oldS.length : 0, newS].filter((x) => x !== 0 && x !== "");
const opAppend = (oldS, addS) =>
  [oldS.length || 0, addS].filter((x) => x !== 0 && x !== "");

const input = cmd === "get" ? "" : await readStdin();
const { cookie, eio } = await bootstrap();

const ws = new WebSocket(
  `${wsBase}/socket.io/?EIO=${eio}&transport=websocket&noteId=${encodeURIComponent(noteId)}`,
  cookie ? { headers: { Cookie: cookie } } : undefined,
);

let done = false,
  permission = null,
  pingTimer = null;
const finish = (code, msg) => {
  if (done) return;
  done = true;
  if (pingTimer) clearInterval(pingTimer);
  if (msg) console.error(msg);
  try {
    ws.close();
  } catch {}
  exit(code);
};
const watchdog = setTimeout(
  () => finish(1, "timeout waiting for server"),
  25000,
);

const send = (s) => {
  try {
    ws.send(s);
  } catch {}
};
const emit = (...args) => send("42" + JSON.stringify(args));

ws.onerror = (e) =>
  finish(
    1,
    "websocket error: " + (e?.message || e?.error?.message || "unknown"),
  );

ws.onmessage = (ev) => {
  const d = typeof ev.data === "string" ? ev.data : ev.data.toString();
  if (d[0] === "0") {
    // engine.io OPEN
    const h = JSON.parse(d.slice(1));
    emitConnect();
    if (eio === 3) {
      // EIO3 = client-initiated heartbeat
      const iv = h.pingInterval || 25000;
      pingTimer = setInterval(() => send("2"), iv);
    }
    return;
  }
  if (d === "2") return send("3"); // EIO4 server ping -> pong
  if (d === "3") return; // EIO3 pong
  if (d.startsWith("44")) return finish(1, "connect_error: " + d.slice(2)); // socket.io CONNECT_ERROR
  if (d.startsWith("42")) {
    // socket.io EVENT
    let arr;
    try {
      arr = JSON.parse(d.slice(2));
    } catch {
      return;
    }
    return onEvent(arr[0], arr.slice(1));
  }
};

function emitConnect() {
  send("40");
} // socket.io CONNECT to default namespace

function onEvent(name, args) {
  if (name === "refresh") {
    permission = args[0]?.permission ?? permission;
    return;
  }
  if (name === "info")
    return finish(
      args[0]?.code === 403 ? 3 : 1,
      `server rejected connection (code ${args[0]?.code}) — note may be private/limited; set HEDGEDOC_COOKIE`,
    );
  if (name === "delete") return finish(1, "note was deleted");
  if (name === "doc") return onDoc(args[0]);
}

function onDoc(doc) {
  const text = doc?.str || "";
  const revision = doc?.revision || 0;
  if (cmd === "get") {
    stdout.write(text);
    return finish(0);
  }

  const op = cmd === "set" ? opReplaceAll(text, input) : opAppend(text, input);
  if (op.length === 0) return finish(0); // nothing to write

  // If the server silently drops the op (no edit permission) we never get `ack`.
  const noack = setTimeout(
    () =>
      finish(
        3,
        `edit rejected — note permission is "${permission ?? "unknown"}"; ` +
          `anonymous editing needs "freely". Set HEDGEDOC_COOKIE to a logged-in session.`,
      ),
    8000,
  );

  let acked = false;
  const origOnEvent = onEvent;
  // intercept the ack event
  ws.addEventListener("message", (ev) => {
    const d = typeof ev.data === "string" ? ev.data : ev.data.toString();
    if (!acked && d.startsWith("42")) {
      try {
        if (JSON.parse(d.slice(2))[0] === "ack") {
          acked = true;
          clearTimeout(noack);
          // dirty-flush runs every 1s server-side; linger so it persists, then
          // disconnect (last-client disconnect also forces an immediate flush).
          setTimeout(() => finish(0), 1700);
        }
      } catch {}
    }
  });
  emit("operation", revision, op, null);
}
