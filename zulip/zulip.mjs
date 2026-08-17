#!/usr/bin/env node
// zulip — the Zulip REST API from the command line.
//
// Plain Node ESM, no dependencies: everything here is `fetch` against
// `<site>/api/v1/...` with HTTP Basic auth (`email:api_key`), which is the
// whole of Zulip's authentication story for personal API keys and bots.
//
// Two conventions of the API are worth knowing before reading on:
//
//   * Non-string parameter values are JSON, in the query string as well as in
//     form bodies — `narrow=[{"operator":"channel",...}]`, `apply_markdown=false`,
//     `messages=[1,2]`. See jsonParams()/form().
//   * Messages are fetched with `apply_markdown=false` so `content` is the
//     original Markdown instead of rendered HTML: better for reading, and it
//     round-trips through `edit`.
//
// Everything that names a channel, topic or user accepts what a human would
// type; ids are resolved here so callers never have to look them up first.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

// Output is long and routinely piped into head/less.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

class Fail extends Error {}

// ------------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const next = argv[i + 1];
      if (eq !== -1) opts[key] = a.slice(eq + 1);
      else if (next === undefined || next.startsWith("--")) opts[key] = true;
      else opts[key] = argv[++i];
    } else rest.push(a);
  }
  return { opts, rest };
}

const out = (v) =>
  process.stdout.write(
    typeof v === "string"
      ? v.endsWith("\n")
        ? v
        : v + "\n"
      : JSON.stringify(v, null, 2) + "\n",
  );

const { opts, rest } = parseArgs(process.argv.slice(2));

function num(v, what) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Fail(`${what}: '${v}' is not a number`);
  return n;
}

// Message text comes from argv, or from stdin when argv has none (or says "-").
function textArg(words) {
  const joined = words.join(" ").trim();
  if (joined && joined !== "-") return joined;
  const stdin = readFileSync(0, "utf8");
  if (!stdin.trim())
    throw new Fail("no message text given (pass it as arguments or on stdin)");
  return stdin.replace(/\n+$/, "");
}

// ------------------------------------------------------------------ config

// Resolution order, first hit wins:
//   1. ZULIP_SITE + ZULIP_EMAIL + ZULIP_API_KEY in the environment
//   2. --zuliprc <path> / $ZULIPRC
//   3. --passage <entry> / $ZULIP_PASSAGE_ENTRY  (`passage show <entry>`)
//   4. ~/.zuliprc
// 2–4 all hold a zuliprc: an INI file with an [api] section (email/key/site),
// exactly what the Zulip web UI hands out and what the Python client reads.
function parseZuliprc(text, where) {
  let section = "";
  const cfg = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1].trim();
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || section !== "api") continue;
    cfg[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  if (!cfg.email || !cfg.key || !cfg.site)
    throw new Fail(
      `${where}: [api] section must set email, key and site (got ${Object.keys(cfg).join(", ") || "nothing"})`,
    );
  return cfg;
}

function loadConfig() {
  const env = process.env;
  if (env.ZULIP_SITE && env.ZULIP_EMAIL && env.ZULIP_API_KEY)
    return {
      site: env.ZULIP_SITE,
      email: env.ZULIP_EMAIL,
      key: env.ZULIP_API_KEY,
      source: "environment",
    };

  const rcPath = opts.zuliprc || env.ZULIPRC;
  if (rcPath && rcPath !== true) {
    let text;
    try {
      text = readFileSync(rcPath, "utf8");
    } catch (e) {
      throw new Fail(`cannot read zuliprc ${rcPath}: ${e.code ?? e.message}`);
    }
    return { ...parseZuliprc(text, rcPath), source: rcPath };
  }

  const entry = opts.passage || env.ZULIP_PASSAGE_ENTRY;
  if (entry) {
    let text;
    try {
      text = execFileSync("passage", ["show", entry], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      throw new Fail(
        `passage show ${entry} failed: ${String(e.stderr || e.message).trim()}`,
      );
    }
    return {
      ...parseZuliprc(text, `passage:${entry}`),
      source: `passage:${entry}`,
    };
  }

  const home = join(homedir(), ".zuliprc");
  try {
    return { ...parseZuliprc(readFileSync(home, "utf8"), home), source: home };
  } catch (e) {
    if (e instanceof Fail) throw e;
    throw new Fail(
      `no Zulip credentials found. Provide one of:\n` +
        `  ZULIP_SITE + ZULIP_EMAIL + ZULIP_API_KEY in the environment\n` +
        `  --zuliprc <path> or $ZULIPRC pointing at a zuliprc\n` +
        `  --passage <entry> or $ZULIP_PASSAGE_ENTRY (decrypted with \`passage show\`)\n` +
        `  ${home}\n` +
        `A zuliprc is:\n  [api]\n  email=you@example.com\n  key=<api key>\n  site=https://zulip.example.com\n` +
        `Get the key from the web UI: Settings → Account & privacy → API key.`,
    );
  }
}

let cfg = null;
const config = () => (cfg ??= loadConfig());

// `site` may be given with or without scheme and with a trailing slash. It is
// resolvable without a key so `zulip server` can vet a URL before login.
const siteRoot = (site) => {
  const raw = (site ?? config().site).replace(/\/+$/, "");
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
};
const apiBase = (site) => `${siteRoot(site)}/api/v1`;

// --------------------------------------------------------------- transport

// Zulip wants JSON for anything that is not a plain string.
const encodeValue = (v) => (typeof v === "string" ? v : JSON.stringify(v));

function withParams(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "")
      u.searchParams.set(k, encodeValue(v));
  return u;
}

function form(params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") body.set(k, encodeValue(v));
  return body;
}

async function request(
  path,
  { method = "GET", params, body, auth = true, raw, site } = {},
) {
  const headers = { Accept: "application/json" };
  if (auth) {
    const { email, key } = config();
    headers.Authorization =
      "Basic " + Buffer.from(`${email}:${key}`).toString("base64");
  }
  let payload = raw;
  if (body !== undefined) {
    payload = form(body);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  const target = withParams(apiBase(site) + path, params);
  let res;
  try {
    res = await fetch(target, { method, headers, body: payload });
  } catch (e) {
    throw new Fail(
      `cannot reach ${target.origin}: ${e.cause?.code ?? e.cause?.message ?? e.message}` +
        (target.protocol === "https:" &&
        /^(127\.|localhost|\[::1\])/.test(target.hostname)
          ? " (site has no scheme, so https was assumed)"
          : ""),
    );
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page; reported below */
  }

  if (json?.result === "error" || !res.ok) {
    const retry = json?.["retry-after"];
    const hint =
      res.status === 401
        ? ` (credentials from ${config().source} rejected — regenerate the API key in the web UI)`
        : res.status === 429
          ? ` (rate limited; retry in ${retry ?? "a while"}s)`
          : "";
    const msg = json?.msg ?? text.slice(0, 400);
    const code =
      json?.code && json.code !== "BAD_REQUEST" ? ` [${json.code}]` : "";
    throw new Fail(`zulip: ${msg}${code}${hint}`);
  }
  // FL 167+: the server names parameters it did not understand instead of
  // failing, which would otherwise hide a typo as a silently ignored filter.
  if (json?.ignored_parameters_unsupported?.length)
    process.stderr.write(
      `warning: server ignored unsupported parameter(s): ${json.ignored_parameters_unsupported.join(", ")}\n`,
    );
  return json;
}

const get = (path, params) => request(path, { params });
const post = (path, body) => request(path, { method: "POST", body });

// -------------------------------------------------------------- resolving

let meCache = null;
const me = async () => (meCache ??= await get("/users/me"));

let channelCache = null;
async function channels() {
  if (channelCache) return channelCache;
  // Subscriptions first: those are the ones a user means by name. Fall back to
  // every visible channel so an unsubscribed one can still be addressed.
  const subs = (await get("/users/me/subscriptions")).subscriptions ?? [];
  const seen = new Map(
    subs.map((s) => [s.stream_id, { ...s, subscribed: true }]),
  );
  try {
    for (const s of (await get("/streams")).streams ?? [])
      if (!seen.has(s.stream_id))
        seen.set(s.stream_id, { ...s, subscribed: false });
  } catch {
    /* /streams needs more permission on some realms; subscriptions suffice */
  }
  return (channelCache = [...seen.values()]);
}

// Accepts an id, an exact name, or a unique case-insensitive substring.
async function resolveChannel(spec) {
  if (spec === undefined || spec === null || spec === "")
    throw new Fail("no channel given");
  const all = await channels();
  if (/^\d+$/.test(String(spec))) {
    const id = Number(spec);
    const hit = all.find((c) => c.stream_id === id);
    return hit ?? { stream_id: id, name: String(spec) };
  }
  const q = String(spec).toLowerCase();
  const exact = all.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const hits = all.filter((c) => c.name.toLowerCase().includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0)
    throw new Fail(
      `no channel matches '${spec}' (try \`zulip channels\` to list them)`,
    );
  throw new Fail(
    `'${spec}' matches ${hits.length} channels: ${hits.map((c) => c.name).join(", ")}`,
  );
}

let userCache = null;
async function users() {
  return (userCache ??= (await get("/users")).members ?? []);
}

// Accepts a user id, an email, or a unique case-insensitive name substring.
async function resolveUser(spec) {
  if (/^\d+$/.test(String(spec))) return { user_id: Number(spec), email: spec };
  const all = await users();
  const q = String(spec).toLowerCase();
  const byEmail = all.find(
    (u) =>
      (u.email ?? "").toLowerCase() === q ||
      (u.delivery_email ?? "").toLowerCase() === q,
  );
  if (byEmail) return byEmail;
  const hits = all.filter(
    (u) =>
      (u.full_name ?? "").toLowerCase().includes(q) ||
      (u.email ?? "").toLowerCase().includes(q),
  );
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Fail(`no user matches '${spec}'`);
  throw new Fail(
    `'${spec}' matches ${hits.length} users: ${hits
      .map((u) => `${u.full_name} <${u.email}>`)
      .join("; ")}`,
  );
}

const userList = (spec) =>
  Promise.all(
    String(spec)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(resolveUser),
  );

// ----------------------------------------------------------------- narrows

// Build the `narrow` parameter from the filter flags, in the object form
// ({operator, operand}); the legacy 2-tuple form cannot carry integer operands.
// Operands are ids wherever the API takes them, so names never round-trip.
async function buildNarrow(o) {
  if (o.narrow && o.narrow !== true) return JSON.parse(o.narrow);
  const n = [];
  const csv = (v) =>
    String(v === true ? "" : (v ?? ""))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const channelSpec = o.channel ?? o.stream;
  if (channelSpec) {
    const c = await resolveChannel(channelSpec);
    n.push({ operator: "channel", operand: c.stream_id });
  }
  if (o.topic) n.push({ operator: "topic", operand: String(o.topic) });
  if (o.dm)
    n.push({
      operator: "dm",
      operand: (await userList(o.dm)).map((u) => u.user_id),
    });
  if (o.sender)
    n.push({
      operator: "sender",
      operand: (await resolveUser(o.sender)).user_id,
    });
  if (o.search) n.push({ operator: "search", operand: String(o.search) });
  if (o.has) n.push({ operator: "has", operand: String(o.has) });
  // Without a channel term the search covers only your own message history;
  // `--channels public` widens it to every public channel's shared history.
  if (o.channels) n.push({ operator: "channels", operand: String(o.channels) });
  for (const flag of csv(o.is)) n.push({ operator: "is", operand: flag });
  if (o.id) n.push({ operator: "id", operand: num(o.id, "--id") });
  return n;
}

// One page of messages. `anchor` decides the direction: from the newest (or a
// given id) we look back, from the oldest or the first unread we look forward.
async function fetchMessages(o, { limit = 20 } = {}) {
  const anchor = String(o.anchor && o.anchor !== true ? o.anchor : "newest");
  const forward = anchor === "oldest" || anchor === "first_unread";
  return get("/messages", {
    anchor,
    num_before: forward ? 0 : limit,
    num_after: forward ? limit : 0,
    narrow: await buildNarrow(o),
    apply_markdown: false,
  });
}

// ---------------------------------------------------------------- rendering

const fmtTime = (ts) =>
  new Date(ts * 1000).toLocaleString("sv-SE", {
    dateStyle: "short",
    timeStyle: "short",
  });

// Zulip's URL-hash encoding (zerver/lib/url_encoding.py:13-23): percent-encode
// everything unsafe, then `%` → `.` and a literal `.` → `.2E`, because some
// browsers eagerly decode `location.hash`. Python's quote(safe="") also escapes
// !'()*, which encodeURIComponent leaves alone, hence the first pass.
const hashPart = (s) =>
  encodeURIComponent(String(s ?? ""))
    .replace(
      /[!'()*]/g,
      (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    )
    .replace(/[%.]/g, (c) => (c === "%" ? "." : ".2E"));

// `<id>-<name>` for channels, `<sorted,ids>[-group]` for DMs. Only the numeric
// prefix is parsed by the client, so the readable part is a courtesy.
const channelSlug = (id, name) => `${id}-${hashPart(name)}`;

const channelUrl = (id, name, topic, messageId) =>
  `${siteRoot()}/#narrow/channel/${channelSlug(id, name)}/topic/${hashPart(topic)}` +
  (messageId ? `/near/${messageId}` : "");

function permalink(m) {
  if (m.type === "stream")
    return channelUrl(
      m.stream_id,
      String(m.display_recipient ?? ""),
      m.subject,
      m.id,
    );
  const ids = [...new Set((m.display_recipient ?? []).map((r) => r.id))].sort(
    (a, b) => a - b,
  );
  return `${siteRoot()}/#narrow/dm/${ids.join(",")}${ids.length >= 3 ? "-group" : ""}/near/${m.id}`;
}

const where = (m) =>
  m.type === "stream"
    ? `#${m.display_recipient} > ${m.subject}`
    : `DM: ${(m.display_recipient ?? []).map((r) => r.full_name).join(", ")}`;

function renderMessage(m) {
  const reactions = (m.reactions ?? []).length
    ? "  " +
      [
        ...(m.reactions ?? []).reduce(
          (acc, r) => acc.set(r.emoji_name, (acc.get(r.emoji_name) ?? 0) + 1),
          new Map(),
        ),
      ]
        .map(([e, c]) => `:${e}:${c > 1 ? `×${c}` : ""}`)
        .join(" ")
    : "";
  const flags = (m.flags ?? []).includes("read") ? "" : "  [unread]";
  const head = `#${m.id}  ${fmtTime(m.timestamp)}  ${m.sender_full_name}  ${where(m)}${flags}${reactions}`;
  const body = String(m.content ?? "")
    .split("\n")
    .map((l) => "    " + l)
    .join("\n");
  return `${head}\n${body}`;
}

const renderMessages = (msgs) =>
  msgs.length ? msgs.map(renderMessage).join("\n\n") : "no messages";

// ---------------------------------------------------------------- sending

// `read_by_sender` is guessed from the client name when omitted, which would
// leave your own message sitting in your unread count; say it outright.
const sendChannel = (streamId, topic, content) =>
  post("/messages", {
    type: "channel",
    to: streamId,
    topic,
    content,
    read_by_sender: true,
  });

const sendDm = (userIds, content) =>
  post("/messages", {
    type: "direct",
    to: userIds,
    content,
    read_by_sender: true,
  });

// ---------------------------------------------------------------- commands

const commands = {
  async whoami() {
    const u = await me();
    if (opts.json) return out(u);
    out(
      [
        `${u.full_name} <${u.email}>  (user_id ${u.user_id})`,
        `site      ${siteRoot()}`,
        `role      ${u.is_owner ? "owner" : u.is_admin ? "admin" : u.is_bot ? "bot" : "member"}`,
        `timezone  ${u.timezone || "unset"}`,
        `creds     ${config().source}`,
      ].join("\n"),
    );
  },

  // Needs no credentials, so it also answers "is this URL a Zulip realm, and
  // how would I log in?" before any key exists: argument, else the configured
  // credentials, else a bare $ZULIP_SITE.
  async server({ rest }) {
    let site = rest[0];
    if (!site)
      try {
        site = config().site;
      } catch (e) {
        if (!process.env.ZULIP_SITE) throw e;
        site = process.env.ZULIP_SITE;
      }
    const s = await request("/server_settings", { auth: false, site });
    if (opts.json) return out(s);
    out(
      [
        `realm     ${s.realm_name} (${s.realm_uri})`,
        `version   ${s.zulip_version}  feature level ${s.zulip_feature_level}`,
        `auth      ${Object.entries(s.authentication_methods ?? {})
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ")}`,
      ].join("\n"),
    );
  },

  async channels() {
    const all = (await channels()).sort((a, b) => a.name.localeCompare(b.name));
    const shown = opts.all ? all : all.filter((c) => c.subscribed);
    if (opts.json) return out(shown);
    out(
      shown.length
        ? shown
            .map(
              (c) =>
                `${String(c.stream_id).padStart(5)}  ${c.subscribed ? "*" : " "} ${c.name}` +
                (c.description
                  ? `  — ${c.description.replace(/\n/g, " ")}`
                  : ""),
            )
            .join("\n") + `\n\n${shown.length} channels (* = subscribed)`
        : "no channels",
    );
  },

  async topics({ rest }) {
    const c = await resolveChannel(rest[0]);
    const limit = opts.limit ? num(opts.limit, "--limit") : 30;
    const topics = (
      (await get(`/users/me/${c.stream_id}/topics`)).topics ?? []
    ).slice(0, limit);
    if (opts.json) return out(topics);
    out(
      topics.length
        ? `#${c.name} (id ${c.stream_id})\n` +
            topics
              .map((t) => `  ${String(t.max_id).padStart(8)}  ${t.name}`)
              .join("\n")
        : `#${c.name}: no topics`,
    );
  },

  async messages() {
    const limit = opts.limit ? num(opts.limit, "--limit") : 20;
    const res = await fetchMessages(opts, { limit });
    if (opts.json) return out(res);
    const more = res.found_oldest === false ? "\n\n(older messages exist)" : "";
    out(renderMessages(res.messages ?? []) + more);
  },

  async message({ rest }) {
    const id = num(rest[0], "message id");
    const res = await get(`/messages/${id}`, { apply_markdown: false });
    if (opts.json) return out(res);
    out(`${renderMessage(res.message)}\n\n    ${permalink(res.message)}`);
  },

  async link({ rest }) {
    const id = num(rest[0], "message id");
    const res = await get(`/messages/${id}`, { apply_markdown: false });
    out(permalink(res.message));
  },

  // Grouped view of what is unread, newest activity first.
  async unread() {
    const limit = opts.limit ? num(opts.limit, "--limit") : 200;
    const res = await fetchMessages({ ...opts, is: "unread" }, { limit });
    const msgs = res.messages ?? [];
    if (opts.json) return out(msgs);
    if (!msgs.length) return out("nothing unread");
    const groups = new Map();
    for (const m of msgs) {
      const k = where(m);
      const g = groups.get(k) ?? { count: 0, last: m, senders: new Set() };
      g.count++;
      g.last = m;
      g.senders.add(m.sender_full_name);
      groups.set(k, g);
    }
    out(
      [...groups]
        .sort((a, b) => b[1].last.timestamp - a[1].last.timestamp)
        .map(
          ([k, g]) =>
            `${String(g.count).padStart(4)}  ${k}\n      last ${fmtTime(g.last.timestamp)} by ${[...g.senders].join(", ")}: ${String(
              g.last.content,
            )
              .replace(/\s+/g, " ")
              .slice(0, 120)}`,
        )
        .join("\n") +
        `\n\n${msgs.length} unread message(s) in ${groups.size} conversation(s)` +
        (res.found_oldest === false ? " (truncated, raise --limit)" : ""),
    );
  },

  async users({ rest }) {
    const all = await users();
    const q = (rest[0] ?? "").toLowerCase();
    const hits = (
      q
        ? all.filter(
            (u) =>
              (u.full_name ?? "").toLowerCase().includes(q) ||
              (u.email ?? "").toLowerCase().includes(q),
          )
        : all
    ).filter((u) => opts.bots || !u.is_bot);
    if (opts.json) return out(hits);
    out(
      hits.length
        ? hits
            .sort((a, b) =>
              (a.full_name ?? "").localeCompare(b.full_name ?? ""),
            )
            .map(
              (u) =>
                `${String(u.user_id).padStart(6)}  ${u.is_active ? " " : "-"} ${u.full_name} <${u.email}>` +
                (u.is_bot ? "  [bot]" : ""),
            )
            .join("\n") + `\n\n${hits.length} users`
        : "no users match",
    );
  },

  // send <channel> <topic> [text...]
  async send({ rest }) {
    const [channelSpec, topic, ...words] = rest;
    if (!channelSpec || !topic)
      throw new Fail('usage: zulip send <channel> <topic> "<text>"');
    const c = await resolveChannel(channelSpec);
    const res = await sendChannel(c.stream_id, topic, textArg(words));
    out(
      opts.json
        ? res
        : `sent #${res.id} to #${c.name} > ${topic}\n${channelUrl(c.stream_id, c.name, topic, res.id)}`,
    );
  },

  // dm <user[,user...]> [text...]
  async dm({ rest }) {
    const [recipients, ...words] = rest;
    if (!recipients) throw new Fail('usage: zulip dm <user[,user]> "<text>"');
    const to = await userList(recipients);
    const res = await sendDm(
      to.map((u) => u.user_id),
      textArg(words),
    );
    out(
      opts.json
        ? res
        : `sent #${res.id} to ${to.map((u) => u.full_name ?? u.email).join(", ")}`,
    );
  },

  // reply <message-id> [text...] — same channel+topic, or same DM thread.
  async reply({ rest }) {
    const [idArg, ...words] = rest;
    const id = num(idArg, "message id");
    const { message } = await get(`/messages/${id}`, { apply_markdown: false });
    const content = textArg(words);
    if (message.type === "stream") {
      const res = await sendChannel(
        message.stream_id,
        message.subject,
        content,
      );
      return out(
        opts.json
          ? res
          : `sent #${res.id} to #${message.display_recipient} > ${message.subject}`,
      );
    }
    const meId = (await me()).user_id;
    const to = (message.display_recipient ?? [])
      .map((r) => r.id)
      .filter((rid) => rid !== meId);
    const res = await sendDm(to.length ? to : [meId], content);
    out(opts.json ? res : `sent #${res.id} as DM reply to #${id}`);
  },

  // edit <message-id> [text...] [--topic T] [--channel C] [--propagate MODE]
  async edit({ rest }) {
    const [idArg, ...words] = rest;
    const id = num(idArg, "message id");
    const body = {};
    const joined = words.join(" ").trim();
    if (joined) body.content = joined;
    else if (opts.stdin) body.content = textArg([]);
    if (opts.topic) body.topic = String(opts.topic);
    if (opts.channel || opts.stream)
      body.stream_id = (
        await resolveChannel(opts.channel ?? opts.stream)
      ).stream_id;
    if (!Object.keys(body).length)
      throw new Fail("nothing to change: give new text, --topic or --channel");
    // A move without an explicit mode only touches this one message.
    if (body.topic || body.stream_id)
      body.propagate_mode = String(opts.propagate ?? "change_one");
    await request(`/messages/${id}`, { method: "PATCH", body });
    out(`edited #${id}${body.topic ? ` (topic → ${body.topic})` : ""}`);
  },

  async delete({ rest }) {
    const id = num(rest[0], "message id");
    if (!opts.yes)
      throw new Fail(
        `deleting a message is irreversible — re-run with --yes to delete #${id}`,
      );
    await request(`/messages/${id}`, { method: "DELETE" });
    out(`deleted #${id}`);
  },

  // react <message-id> <emoji-name> [--remove]
  async react({ rest }) {
    const [idArg, emoji] = rest;
    const id = num(idArg, "message id");
    if (!emoji) throw new Fail("usage: zulip react <message-id> <emoji-name>");
    const name = emoji.replace(/^:|:$/g, "");
    const body = { emoji_name: name };
    if (opts.remove) {
      // DELETE defaults reaction_type to unicode_emoji instead of inferring it,
      // so a custom realm emoji would not be found. Copy what the server stored.
      const [{ message }, meId] = await Promise.all([
        get(`/messages/${id}`, { apply_markdown: false }),
        me().then((u) => u.user_id),
      ]);
      const mine = (message.reactions ?? []).find(
        (r) => r.emoji_name === name && r.user_id === meId,
      );
      if (!mine) throw new Fail(`you have no :${name}: reaction on #${id}`);
      body.emoji_code = mine.emoji_code;
      body.reaction_type = mine.reaction_type;
    }
    await request(`/messages/${id}/reactions`, {
      method: opts.remove ? "DELETE" : "POST",
      body,
    });
    out(`${opts.remove ? "removed" : "added"} :${name}: on #${id}`);
  },

  // mark-read [<message-id>...] | [narrow flags] | --all
  async "mark-read"({ rest }) {
    if (rest.length) {
      const ids = rest.map((r) => num(r, "message id"));
      const res = await post("/messages/flags", {
        messages: ids,
        op: "add",
        flag: "read",
      });
      return out(`marked ${(res.messages ?? ids).length} message(s) read`);
    }
    const narrow = opts.all ? [] : await buildNarrow(opts);
    if (!narrow.length && !opts.all)
      throw new Fail(
        "refusing to mark everything read without --all (or pass --channel/--topic/--dm/message ids)",
      );
    // `is:unread` keeps the batches to what actually needs updating, and hits
    // the index the server documents for exactly this call.
    narrow.push({ operator: "is", operand: "unread" });
    // The server clamps each batch to 5000, so walk forward until it says the
    // newest message was reached.
    let anchor = "oldest";
    let total = 0;
    for (let i = 0; i < 100; i++) {
      const res = await post("/messages/flags/narrow", {
        anchor,
        include_anchor: i === 0,
        num_before: 0,
        num_after: 1000,
        narrow,
        op: "add",
        flag: "read",
      });
      total += res.updated_count ?? 0;
      if (res.found_newest || !res.last_processed_id) break;
      anchor = String(res.last_processed_id);
    }
    out(`marked ${total} message(s) read`);
  },

  // upload <file> — returns the URL to embed in a message.
  async upload({ rest }) {
    const path = rest[0];
    if (!path) throw new Fail("usage: zulip upload <file>");
    const fd = new FormData();
    // The view accepts a single file part under any name; `filename` is what the
    // OpenAPI schema and the official examples use.
    fd.set("filename", new Blob([readFileSync(path)]), basename(path));
    const res = await request("/user_uploads", { method: "POST", raw: fd });
    const url = res.url ?? res.uri;
    const abs = url.startsWith("http") ? url : siteRoot() + url;
    out(opts.json ? res : `${abs}\n[${basename(path)}](${url})`);
  },
};

const USAGE = `zulip — Zulip from the command line

read:
  server [<site>]                           realm info (no credentials needed)
  whoami                                    verify credentials
  channels [--all] [--json]                 subscribed channels (--all: every visible one)
  topics <channel> [--limit N] [--json]
  messages [filters] [--limit N] [--json]
  message <id> [--json]                     one message, with permalink
  unread [--limit N] [--json]               grouped by conversation
  users [query] [--bots] [--json]
  link <id>                                 permalink to a message

write:
  send <channel> <topic> "<text>"           text may also come from stdin
  dm <user[,user...]> "<text>"
  reply <message-id> "<text>"               same channel+topic, or same DM thread
  edit <message-id> ["<text>"] [--topic T] [--channel C] [--propagate change_one|change_later|change_all]
  react <message-id> <emoji> [--remove]
  mark-read [<message-id>...] | [filters] | --all
  delete <message-id> --yes                 irreversible
  upload <file>

filters (combine freely; channels/users accept id, name or unique substring):
  --channel X --topic Y --dm USER[,USER] --sender USER --search TEXT
  --is unread,starred,mentioned,dm --has link|image|attachment|reaction
  --channels public                        widen a search beyond your own history
  --id N --anchor newest|oldest|first_unread|<id> --narrow '<raw json>'

credentials (first hit wins):
  ZULIP_SITE + ZULIP_EMAIL + ZULIP_API_KEY
  --zuliprc <path> / $ZULIPRC
  --passage <entry> / $ZULIP_PASSAGE_ENTRY
  ~/.zuliprc`;

const cmd = rest.shift();
if (!cmd || cmd === "help" || (opts.help && !commands[cmd])) {
  out(USAGE);
  process.exit(cmd ? 0 : 1);
}
if (!commands[cmd]) {
  process.stderr.write(`unknown command '${cmd}'\n\n${USAGE}\n`);
  process.exit(2);
}
try {
  await commands[cmd]({ opts, rest });
} catch (e) {
  process.stderr.write(
    `${e instanceof Fail ? e.message : (e.stack ?? String(e))}\n`,
  );
  process.exit(1);
}
