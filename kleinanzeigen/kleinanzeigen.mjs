#!/usr/bin/env node
// kleinanzeigen — CLI for the kleinanzeigen.de mobile app API.
//
// Two hosts, two auth schemes:
//
//   api.kleinanzeigen.de      classifieds ("ECG common API"): search, ads,
//                             categories, locations, own ads, watchlist,
//                             notifications. Always HTTP Basic with the app's
//                             own credentials; account calls add the user's
//                             Auth0 access token in two extra headers.
//                             Payloads are JAXB-flavoured JSON — see unwrap().
//
//   gateway.kleinanzeigen.de  chat ("messagebox"): conversations and messages.
//                             Plain JSON, plain `Authorization: Bearer`.
//
// The user login is Auth0 authorization-code + PKCE against
// login.kleinanzeigen.de, done once in a browser (`kleinanzeigen login`); the
// refresh token is then kept in the session file and silently exchanged for
// access tokens.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

// Output is long and routinely piped into head/less.
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const API = "https://api.kleinanzeigen.de";
const GATEWAY = "https://gateway.kleinanzeigen.de";

// Credentials of the Android app itself; they identify the client, not the user.
// Do NOT send `X-ECG-USER-AGENT: ebayk-android-app-13.4.2`: that ancient client
// version is blacklisted and everything answers 403 "IP-Bereich vorübergehend
// gesperrt".
const APP_VERSION = "2026.25.0";
const APP_HEADERS = {
  Authorization: "Basic YW5kcm9pZDpUYVI2MHBFdHRZ",
  "User-Agent": "okhttp/4.10.0",
  "X-ECG-USER-AGENT": `ebayk-android-app-${APP_VERSION}`,
  "X-ECG-USER-VERSION": APP_VERSION,
  Accept: "application/json",
  "Accept-Language": "de-DE",
};

// Auth0 public client shipped in the app.
const AUTH0 = {
  authorize: "https://login.kleinanzeigen.de/authorize",
  token: "https://login.kleinanzeigen.de/oauth/token",
  clientId: "uV5j90myVPc2XzEOFuWUD2At17OACEGQ",
  redirect:
    "https://login.kleinanzeigen.de/android/com.ebay.kleinanzeigen/callback",
  scope: "openid email profile offline_access",
};

// Holds the refresh token, i.e. a password equivalent — state, not cache.
const SESSION_FILE =
  process.env.KLEINANZEIGEN_SESSION ||
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"),
    "kleinanzeigen",
    "session.json",
  );

class Fail extends Error {}

// ---------------------------------------------------------------- payloads

// Text values arrive HTML-escaped ("Sattel schwarz&#x2F;blau"); decode centrally.
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  String(s).replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (m, e) => {
    if (e[0] !== "#") return NAMED[e] ?? m;
    const hex = e[1] === "x" || e[1] === "X";
    return String.fromCodePoint(
      parseInt(hex ? e.slice(2) : e.slice(1), hex ? 16 : 10),
    );
  });

// Descriptions and messages are HTML fragments (<br /> for line breaks).
const plain = (s) =>
  s
    ? decode(s)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .trim()
    : "";

// Undo the JAXB wrapping of the classifieds API: {"value": x} collapses to x,
// localized enums collapse to their raw code, bookkeeping keys are dropped.
const NOISE = new Set(["otherAttributes", "declaredType", "scope", "name"]);
function unwrap(node) {
  if (Array.isArray(node)) return node.map(unwrap);
  if (typeof node === "string") return decode(node);
  if (node === null || typeof node !== "object") return node;
  const keys = Object.keys(node);
  if (
    keys.includes("value") &&
    keys.every((k) => k === "value" || k === "localized-label" || NOISE.has(k))
  ) {
    return unwrap(node.value);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (NOISE.has(k)) continue;
    const u = unwrap(v);
    if (u === undefined) continue;
    if (
      u &&
      typeof u === "object" &&
      !Array.isArray(u) &&
      Object.keys(u).length === 0
    )
      continue;
    out[k] = u;
  }
  return out;
}

// Collections arrive as {"{http://schema}ads": {"value": {...}}}.
function envelope(json) {
  const key = Object.keys(json ?? {}).find((k) => k.startsWith("{http"));
  return unwrap(key ? json[key].value : json);
}

const list = (x) =>
  x === undefined || x === null ? [] : Array.isArray(x) ? x : [x];

// The ad list endpoints return a stub unless the wanted fields are named.
const AD_FIELDS =
  "id,title,description,start-date-time,category.id,category.localized_name," +
  "ad-address.state,ad-address.zip-code,price,link,ad-status,ad-type,poster-type,user-id,pictures";

function adUrl(ad) {
  return (
    list(ad.link).find((l) => l.rel === "self-public-website")?.href ??
    `https://www.kleinanzeigen.de/s-anzeige/-/${ad.id}`
  );
}

function priceOf(ad) {
  const p = ad.price;
  if (!p) return "";
  if (p["price-type"] === "GIVE_AWAY") return "zu verschenken";
  if (p.amount === undefined)
    return p["price-type"] === "PLEASE_CONTACT" ? "VB" : "";
  return `${p.amount} €${p["price-type"] === "PLEASE_CONTACT" ? " VB" : ""}`;
}

const when = (s) =>
  String(s ?? "")
    .slice(0, 16)
    .replace("T", " ");
const pad = (s, n) => String(s ?? "").padEnd(n);

function ad2row(ad) {
  const a = ad["ad-address"] ?? {};
  const where = [a["zip-code"], a.state].filter(Boolean).join(" ");
  return [
    ad.id,
    priceOf(ad).padStart(12),
    pad(String(ad.title).slice(0, 60), 60),
    pad(where, 28),
    when(ad["start-date-time"]),
    adUrl(ad),
  ].join("  ");
}

// ------------------------------------------------------------------- auth

function loadSession() {
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSession(s) {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

const b64url = (buf) => buf.toString("base64url");

function jwtClaims(token) {
  try {
    return JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
  } catch {
    return {};
  }
}

async function exchange(payload) {
  const res = await fetch(AUTH0.token, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `Kleinanzeigen Android ${APP_VERSION}`,
    },
    body: JSON.stringify({ client_id: AUTH0.clientId, ...payload }),
  });
  if (!res.ok)
    throw new Fail(
      `Auth0 token endpoint: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`,
    );
  const data = await res.json();
  const s = loadSession();
  s.access_token = data.access_token;
  s.expires_at = Date.now() + (Number(data.expires_in) || 600) * 1000;
  if (data.refresh_token) s.refresh_token = data.refresh_token;
  if (data.id_token) s.email = jwtClaims(data.id_token).email ?? s.email;
  delete s.pending;
  return saveSession(s);
}

// Without `prompt=login` an existing kleinanzeigen.de browser session is reused
// and the sign-in page is skipped entirely — the browser goes straight to the
// callback with a code. `--force` demands a fresh password entry.
function beginLogin({ force = false } = {}) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const s = loadSession();
  s.pending = { verifier, state };
  saveSession(s);
  const q = new URLSearchParams({
    client_id: AUTH0.clientId,
    response_type: "code",
    redirect_uri: AUTH0.redirect,
    scope: AUTH0.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    ...(force ? { prompt: "login" } : {}),
  });
  return `${AUTH0.authorize}?${q}`;
}

async function finishLogin(redirectUrl) {
  const { pending } = loadSession();
  if (!pending)
    throw new Fail(
      "no login in progress — run `kleinanzeigen login` first to get the sign-in URL",
    );
  const qs = new URL(redirectUrl.trim()).searchParams;
  if (qs.get("error"))
    throw new Fail(
      `Auth0 error: ${qs.get("error")} ${qs.get("error_description") ?? ""}`,
    );
  const code = qs.get("code");
  if (!code)
    throw new Fail(
      "that URL has no ?code= — paste the full URL the browser ended up on after signing in",
    );
  if (qs.get("state") !== pending.state)
    throw new Fail("state mismatch — login aborted");
  return exchange({
    grant_type: "authorization_code",
    code,
    code_verifier: pending.verifier,
    redirect_uri: AUTH0.redirect,
  });
}

let session = null;
async function accessToken() {
  session ??= loadSession();
  if (!session.refresh_token) {
    throw new Fail(
      "not logged in — run `kleinanzeigen login` once (browser sign-in), then retry",
    );
  }
  // Refresh a minute early so a long-running command never sends a dead token.
  if (
    !session.access_token ||
    Date.now() >= (session.expires_at ?? 0) - 60_000
  ) {
    session = await exchange({
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
    });
  }
  return session.access_token;
}

// -------------------------------------------------------------- transport

function withParams(url, params = {}) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  return u;
}

async function request(
  url,
  { method = "GET", params, body, authed = false, gateway = false } = {},
) {
  const headers = gateway
    ? { "User-Agent": APP_HEADERS["User-Agent"], Accept: "application/json" }
    : { ...APP_HEADERS };
  if (authed) {
    const token = await accessToken();
    if (gateway) headers.Authorization = `Bearer ${token}`;
    else {
      headers["X-EBAYK-USERID-TOKEN"] = token;
      headers["X-ECG-Authorization-User"] =
        `email=${session.email},access=${token}`;
    }
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const target = withParams(url, params);
  const res = await fetch(target, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " (token rejected — try `kleinanzeigen login` again)"
        : "";
    throw new Fail(
      `HTTP ${res.status} ${method} ${target.pathname}${hint}\n${(await res.text()).slice(0, 400)}`,
    );
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

const apiJson = (path, opts) => request(API + path, opts).then(envelope);
const gwJson = (path, opts) =>
  request(GATEWAY + path, { ...opts, authed: true, gateway: true });

// The chat and own-ad URLs are keyed by the numeric account id, which is only
// reachable through the profile of the logged-in email.
async function userId() {
  session ??= loadSession();
  if (session.user_id) return session.user_id;
  await accessToken();
  const body = await request(
    `${API}/api/users/${encodeURIComponent(session.email)}/profile.json`,
    { authed: true },
  );
  const id = body?.data?.id ?? body?.id ?? envelope(body)?.id;
  if (!id)
    throw new Fail(
      `could not read the account id from profile.json: ${JSON.stringify(body).slice(0, 200)}`,
    );
  session.user_id = String(id);
  saveSession(session);
  return session.user_id;
}

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

// -------------------------------------------------------------- locations

// Matches come back as whole ancestor chains (Bundesland > Stadt > Ortsteil)
// nested through `location`, so most nodes are context, not hits. Keep the ones
// whose own name matches, broadest first: "Köln" must yield the city, not its
// first Ortsteil.
function locationMatches(payload, query = "") {
  const norm = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/ö/g, "o")
      .replace(/ä/g, "a")
      .replace(/ü/g, "u")
      .replace(/ß/g, "ss");
  const q = norm(query);
  const all = [];
  const walk = (node, path) => {
    const name = node["localized-name"] ?? node["id-name"] ?? "";
    const here = [...path, name];
    all.push({
      id: node.id,
      name,
      path: here.join(" > "),
      depth: here.length,
      lat: node.latitude,
      lon: node.longitude,
    });
    for (const kid of list(node.location)) walk(kid, here);
  };
  for (const root of list(payload.location)) walk(root, []);
  const seen = new Set();
  const unique = all.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const hits = q ? unique.filter((m) => norm(m.name).includes(q)) : unique;
  return (hits.length ? hits : unique)
    .sort((a, b) => a.depth - b.depth || a.name.length - b.name.length)
    .map(({ depth, ...m }) => m);
}

async function resolveLocation(name) {
  if (/^\d+$/.test(name)) return name;
  const matches = locationMatches(
    await apiJson("/api/locations.json", { params: { q: name } }),
    name,
  );
  if (!matches.length) throw new Fail(`no location matches '${name}'`);
  return matches[0].id;
}

// ------------------------------------------------------------------- chat

function conv2row(c) {
  const other =
    (c.role ?? "").toUpperCase() === "BUYER" ? c.sellerName : c.buyerName;
  const unread = Number(c.unreadMessagesCount ?? 0);
  return [
    pad(c.id, 12),
    pad(unread ? `${unread} new` : "", 6),
    when(c.receivedDate),
    pad(other ?? "", 18),
    pad(String(c.adTitle ?? "").slice(0, 40), 40),
    `ad ${c.adId ?? ""}`,
  ].join("  ");
}

function conversationText(conv) {
  const c = conv.data ?? conv;
  const other =
    (c.role ?? "").toUpperCase() === "BUYER" ? c.sellerName : c.buyerName;
  const head = `${c.adTitle ?? ""} [ad ${c.adId ?? ""}]  with ${other ?? "?"}  (conversation ${c.id}, you are ${c.role ?? "?"})`;
  const msgs = list(c.messages)
    .map((m) => {
      const dir = String(m.boundness ?? "")
        .toUpperCase()
        .includes("IN")
        ? "them"
        : "me";
      const body = plain(m.text ?? m.textShort ?? m.title ?? "").replace(
        /\n/g,
        "\n              ",
      );
      return `[${when(m.receivedDate)}] ${pad(dir, 4)}  ${body}`;
    })
    .join("\n");
  return `${head}\n${"-".repeat(Math.min(head.length, 100))}\n${msgs}`;
}

// --------------------------------------------------------------- commands

const SORT = {
  new: "DATE_DESCENDING",
  old: "DATE_ASCENDING",
  cheap: "PRICE_ASCENDING",
  expensive: "PRICE_DESCENDING",
  near: "DISTANCE_ASCENDING",
};

const commands = {
  async search({ opts, rest }) {
    const q = rest.join(" ");
    if (!q && !opts.category)
      throw new Fail("search needs a query or --category");
    const params = {
      _in: AD_FIELDS,
      q,
      size: opts.size ?? 25,
      page: opts.page ?? 0,
      categoryId: opts.category,
      minPrice: opts.min,
      maxPrice: opts.max,
      pictureRequired: opts.pictures ? "true" : undefined,
      includeTopAds: opts["no-topads"] ? "false" : "true",
      sortType: opts.sort ? (SORT[opts.sort] ?? opts.sort) : undefined,
      adType: opts.type,
      buyNowOnly: opts["buy-now"] ? "true" : undefined,
    };
    if (opts.location) {
      params.locationId = await resolveLocation(String(opts.location));
      params.distance = opts.radius ?? 0;
    }
    const ads = list((await apiJson("/api/ads.json", { params })).ad);
    if (opts.json) return out(ads);
    out(ads.length ? ads.map(ad2row).join("\n") : "no results");
  },

  async ad({ rest, opts }) {
    const id = rest[0];
    if (!id) throw new Fail("usage: kleinanzeigen ad <ad-id>");
    const ad = await apiJson(`/api/ads/${id}.json`);
    if (opts.json) return out(ad);
    const a = ad["ad-address"] ?? {};
    const attrs = list(ad.attributes?.attribute)
      .map(
        (x) =>
          `  ${x["localized-label"] ?? x.name}: ${list(x.value)
            .map((v) => v["localized-label"] ?? v.value ?? v)
            .join(", ")}`,
      )
      .join("\n");
    out(
      [
        `${ad.title}   [${ad.id}]`,
        `${priceOf(ad)}   ${a["zip-code"] ?? ""} ${a.state ?? ""}`,
        `posted ${ad["start-date-time"]}   ${ad["ad-type"] ?? ""}   ${ad["ad-status"] ?? ""}   seller ${ad["poster-type"] ?? ""} (user ${ad["user-id"] ?? "?"})`,
        adUrl(ad),
        attrs && `attributes:\n${attrs}`,
        "",
        plain(ad.description),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  },

  async locations({ rest, opts }) {
    const q = rest.join(" ");
    if (!q) throw new Fail("usage: kleinanzeigen locations <name>");
    const matches = locationMatches(
      await apiJson("/api/locations.json", { params: { q } }),
      q,
    );
    if (opts.json) return out(matches);
    out(
      matches.map((m) => `${pad(m.id, 10)} ${m.path}`).join("\n") ||
        "no matches",
    );
  },

  async categories({ rest, opts }) {
    const data = await apiJson(
      rest[0] ? `/api/categories/${rest[0]}.json` : "/api/categories.json",
    );
    const cats = list(data.category ?? data);
    if (opts.json) return out(cats);
    const walk = (nodes, depth = 0) =>
      nodes.flatMap((c) => [
        `${"  ".repeat(depth)}${pad(c.id, 6)} ${c["localized-name"] ?? c["id-name"]}`,
        ...(depth < Number(opts.depth ?? 1)
          ? walk(list(c.children?.category ?? c.category), depth + 1)
          : []),
      ]);
    out(walk(cats).join("\n"));
  },

  // ---- account

  async login({ opts }) {
    if (opts.url && opts.url !== true) {
      const s = await finishLogin(String(opts.url));
      session = s;
      return out(`logged in as ${s.email}. Session in ${SESSION_FILE}`);
    }
    const url = beginLogin({ force: Boolean(opts.force) });
    if (!process.stdin.isTTY) {
      return out(
        `Open this URL in a browser and sign in:\n\n${url}\n\n` +
          `You land on a ${AUTH0.redirect} page carrying ?code=... — that page itself may look broken, ` +
          `that is fine. Copy the FULL address-bar URL and finish with:\n\n  kleinanzeigen login --url '<pasted-url>'`,
      );
    }
    out(`Open this URL and sign in:\n\n${url}\n`);
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const redirect = await rl.question(
      "Paste the full URL the browser ended up on: ",
    );
    rl.close();
    const s = await finishLogin(redirect);
    session = s;
    out(`logged in as ${s.email}. Session in ${SESSION_FILE}`);
  },

  async logout() {
    rmSync(SESSION_FILE, { force: true });
    session = null;
    out("session removed (the token is not revoked server-side)");
  },

  async whoami({ opts }) {
    const id = await userId();
    if (opts.json)
      return out({ email: session.email, userId: id, session: SESSION_FILE });
    out(`${session.email}  user-id ${id}`);
  },

  async conversations({ opts }) {
    const body = await gwJson(
      `/messagebox/api/users/${await userId()}/conversations`,
      {
        params: { page: opts.page ?? 0, size: opts.size ?? 30 },
      },
    );
    let convs = list(
      body.conversations ?? body.data?.conversations ?? body.data,
    );
    if (opts.unread)
      convs = convs.filter((c) => Number(c.unreadMessagesCount ?? 0) > 0);
    if (opts.json) return out(convs);
    out(convs.length ? convs.map(conv2row).join("\n") : "no conversations");
  },

  // Opening a thread is a PUT: the server treats it as "conversation loaded".
  async conversation({ rest, opts }) {
    const id = rest[0];
    if (!id)
      throw new Fail("usage: kleinanzeigen conversation <conversation-id>");
    const conv = await gwJson(
      `/messagebox/api/users/${await userId()}/conversations/${id}`,
      {
        method: "PUT",
        params: { contentWarnings: "true" },
      },
    );
    out(opts.json ? conv : conversationText(conv));
  },

  async reply({ rest }) {
    const [id, ...words] = rest;
    const text = words.join(" ");
    if (!id || !text)
      throw new Fail(
        'usage: kleinanzeigen reply <conversation-id> "<message>"',
      );
    await gwJson(
      `/messagebox/api/users/${await userId()}/conversations/${id}`,
      {
        method: "POST",
        params: {
          warnPhoneNumber: "false",
          warnEmail: "false",
          warnBankDetails: "false",
        },
        body: { message: text },
      },
    );
    out(`sent to conversation ${id}`);
  },

  // First contact on an ad: the API creates the empty thread, the text is a
  // normal reply into it.
  async contact({ rest, opts }) {
    const [adId, ...words] = rest;
    const text = words.join(" ");
    if (!adId || !text)
      throw new Fail('usage: kleinanzeigen contact <ad-id> "<message>"');
    const uid = await userId();
    const name =
      opts.name && opts.name !== true
        ? String(opts.name)
        : (session.email ?? "").split("@")[0];
    const created = await request(
      `${API}/api/users/${uid}/create-conversation/${adId}`,
      {
        method: "POST",
        params: { contactName: name },
        authed: true,
      },
    );
    const convId = created?.data?.id ?? created?.id ?? created?.conversationId;
    if (!convId)
      throw new Fail(
        `conversation created but no id in response: ${JSON.stringify(created).slice(0, 300)}`,
      );
    await gwJson(`/messagebox/api/users/${uid}/conversations/${convId}`, {
      method: "POST",
      params: {
        warnPhoneNumber: "false",
        warnEmail: "false",
        warnBankDetails: "false",
      },
      body: { message: text },
    });
    out(`sent to the seller of ad ${adId} (conversation ${convId})`);
  },

  async "mark-read"({ rest }) {
    if (!rest.length)
      throw new Fail("usage: kleinanzeigen mark-read <conversation-id>...");
    await gwJson(`/messagebox/api/users/${await userId()}/conversations/read`, {
      method: "POST",
      params: { ids: rest.join(",") },
    });
    out(`marked read: ${rest.join(", ")}`);
  },

  // The feed is grouped: data.notifications is an array of arrays. Saved-search
  // hits, followed-ad updates and the like all land here.
  async notifications({ opts }) {
    const body = await apiJson(
      `/api/users/${await userId()}/notifications.json`,
      { authed: true },
    );
    let items = list(body.data?.notifications ?? body.notifications).flat();
    if (opts.unread) items = items.filter((n) => !n.read);
    if (opts.size && opts.size !== true)
      items = items.slice(0, Number(opts.size));
    if (opts.json) return out(items);
    out(
      items.length
        ? items
            .map((n) =>
              [
                when(n.timestamp),
                n.read ? "   " : "NEW",
                pad(n.notificationType, 22),
                plain(n.data?.body ?? n.data?.title ?? ""),
                n.data?.url ?? "",
              ].join("  "),
            )
            .join("\n")
        : "no notifications",
    );
  },

  async "my-ads"({ opts }) {
    const data = await apiJson(`/api/users/${await userId()}/ads.json`, {
      params: { _in: AD_FIELDS, page: opts.page ?? 0, size: opts.size ?? 25 },
      authed: true,
    });
    const ads = list(data.ad);
    if (opts.json) return out(ads);
    out(
      ads.length
        ? ads
            .map(
              (a) =>
                `${a.id}  ${pad(a["ad-status"], 9)} ${priceOf(a).padStart(10)}  ${a.title}`,
            )
            .join("\n")
        : "no ads",
    );
  },

  async watchlist({ opts }) {
    const data = await apiJson(`/api/users/${await userId()}/watchlist.json`, {
      params: { _in: AD_FIELDS, page: opts.page ?? 0, size: opts.size ?? 25 },
      authed: true,
    });
    const ads = list(data.ad);
    if (opts.json) return out(ads);
    out(ads.length ? ads.map(ad2row).join("\n") : "watchlist empty");
  },
};

const USAGE = `kleinanzeigen — kleinanzeigen.de from the command line

public (no login):
  search <query...>          [--location <name|id> --radius <km> --min <€> --max <€>
                              --category <id> --sort new|old|cheap|expensive|near
                              --type OFFERED|WANTED --pictures --size N --page N --json]
  ad <ad-id>                 [--json]      full listing incl. description
  locations <name>           [--json]      resolve a place to a location id
  categories [category-id]   [--depth N]

account:
  login [--url <redirect>] [--force]       one-time browser sign-in (Auth0)
  logout
  whoami
  notifications              [--json]
  conversations              [--unread --page N --size N --json]
  conversation <id>          [--json]      full message thread
  reply <conversation-id> "<text>"
  contact <ad-id> "<text>"   [--name X]    first message to a seller
  mark-read <conversation-id>...
  my-ads / watchlist         [--json]

Session (refresh token) lives in ${SESSION_FILE}.`;

const { opts, rest } = parseArgs(process.argv.slice(2));
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
