#!/usr/bin/env node
// Lens Protocol activity collector -> data/days/*.json + site/data.json
//
// Source: the public Lens API (https://api.lens.xyz/graphql). Free, no key, live data.
// Usage:  node collect.mjs            (Node 18+, no dependencies)
//
// Each run re-fetches the last REFETCH_DAYS complete days plus today, and backfills any
// missing day inside the window. Each day is stored once in data/days/YYYY-MM-DD.json.
//
// Env (all optional):
//   LENS_DAYS      days shown on the dashboard (default 90)
//   LENS_TZ        time zone for daily buckets (default UTC)
//   REFETCH_DAYS   complete days re-fetched every run (default 1)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ------------------------------------------------------------------ shared core
// (this block is environment-neutral: it also runs in a browser)

export const API = "https://api.lens.xyz/graphql";
export const KINDS = ["post", "comment", "quote", "repost"];
export const RANGES = [1, 7, 30, 90];

// Known client app addresses on Lens Chain (lower-case). Always shown as their own series.
export const HIGHLIGHT = {
  "0x1efa8f82d9e919f6b6a5f1701131c9cb1a943baa": "Hey",
  "0x3c8029ffe72ef83cff2b7a770bab3a0a2960eeb8": "Orb",
  "0x2f205d5bbdb60c170adf81fb6c0f2f79331f3fae": "Firefly",
  "0xca01da446811d76aa7ad885e5fa39df2031096cb": "Palus",
};
export const TOP_OTHER_APPS = 3; // 4 highlighted + 3 + "Other" = 8 series

// Apps whose content is automated spam. Hidden when the dashboard's "Hide spam apps" filter is on.
export const SPAM_APPS = {
  "0x840f9759d25ca59b025d95e43ed0aafccb1137c7": "Gallery Publisher", // mass link spam from throwaway accounts
};

// Filter combinations precomputed for the dashboard: spam apps shown (s) or hidden (n) x minimum account score.
// Lens account score: 1..10000, an ML estimate of how likely the account is genuine (0 = not scored / flagged).
export const MIN_SCORES = [0, 1, 5000, 9000];
export const VARIANTS = Object.fromEntries([true, false].flatMap(spam =>
  MIN_SCORES.map(min => [(spam ? "s" : "n") + min, { spam, min }])));

const POSTS_Q = `query P($c: Cursor){ posts(request:{pageSize: FIFTY, cursor: $c, filter:{postTypes:[ROOT,COMMENT,QUOTE,REPOST]}}){
  items{ __typename
    ... on Post { timestamp author{ address score username{ localName } } app{ address } commentOn{ id } quoteOf{ id } }
    ... on Repost { timestamp author{ address score username{ localName } } app{ address } } }
  pageInfo{ next } } }`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function gql(query, variables = {}, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "lens-activity-dashboard" },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
      const j = await res.json();
      if (j.errors) throw new Error(j.errors.map(e => e.message).join("; "));
      return j.data;
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1000 * 2 ** i);
    }
  }
}

export function dayOf(ts, tz) {
  // YYYY-MM-DD of a timestamp in the given IANA time zone
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

export function dayList(days, tz, now = new Date()) {
  const today = dayOf(now, tz);
  const out = [];
  const base = new Date(today + "T12:00:00Z");
  for (let i = days; i >= 0; i--) out.push(new Date(base.getTime() - i * 864e5).toISOString().slice(0, 10));
  return out; // oldest .. today
}

export function classify(p) {
  if (p.__typename === "Repost") return "repost";
  if (p.commentOn) return "comment";
  if (p.quoteOf) return "quote";
  return "post";
}

// Fetch posts newest-first until the day boundary `fromDay` (inclusive) is passed.
// Returns { agg: {day: {"app|account|kind": n}}, handles: {account: localName}, scores: {account: score} }
export async function fetchSince(fromDay, tz, log = () => {}) {
  const agg = {}, handles = {}, scores = {};
  let cursor = null, pages = 0, n = 0;
  for (;;) {
    const d = await gql(POSTS_Q, { c: cursor });
    const items = d.posts.items;
    pages++;
    let passed = false;
    for (const p of items) {
      const day = dayOf(p.timestamp, tz);
      if (day < fromDay) { passed = true; continue; }
      const acct = (p.author?.address || "").toLowerCase();
      const app = (p.app?.address || "none").toLowerCase();
      const key = app + "|" + acct + "|" + classify(p);
      (agg[day] ||= {})[key] = ((agg[day] ||= {})[key] || 0) + 1;
      if (p.author?.username?.localName) handles[acct] ||= p.author.username.localName;
      if (typeof p.author?.score === "number" && !(acct in scores)) scores[acct] = p.author.score;
      n++;
    }
    if (pages % 50 === 0) log(`  ${pages} pages, ${n} posts, at ${items.at(-1)?.timestamp}`);
    cursor = d.posts.pageInfo.next;
    if (passed || !cursor || !items.length) break;
  }
  log(`  fetched ${n} posts in ${pages} pages`);
  return { agg, handles, scores };
}

// Current Lens account score for many accounts (the API takes 50 per request)
export async function fetchScores(accounts, log = () => {}) {
  const out = {};
  for (let i = 0; i < accounts.length; i += 50) {
    const batch = accounts.slice(i, i + 50);
    try {
      const d = await gql(`query S($a: [EvmAddress!]!){ accountsBulk(request:{addresses:$a}){ address score } }`, { a: batch });
      for (const a of d.accountsBulk) out[a.address.toLowerCase()] = a.score;
    } catch (e) { log("  score batch failed: " + e.message); }
  }
  return out;
}

export async function fetchAppNames(addrs) {
  const out = {};
  for (const a of addrs) {
    if (a === "none") continue;
    try {
      const d = await gql(`query A($a: EvmAddress!){ app(request:{app:$a}){ metadata{ name } } }`, { a });
      if (d.app?.metadata?.name) out[a] = d.app.metadata.name.trim();
    } catch { /* keep unnamed */ }
  }
  return out;
}

// Build the dashboard data file from per-day aggregates: one block per filter combination.
export function buildData({ agg, handles, appNames, scores = {}, days, tz, generatedAt }) {
  const variants = {};
  for (const [name, v] of Object.entries(VARIANTS)) {
    const keep = (app, acct) => (v.spam || !SPAM_APPS[app]) && (typeof scores[acct] !== "number" || scores[acct] >= v.min);
    variants[name] = buildVariant({ agg, handles, appNames, days, keep });
  }
  const accts = new Set(); for (const d of days) for (const k of Object.keys(agg[d] || {})) accts.add(k.split("|")[1]);
  const known = [...accts].filter(a => typeof scores[a] === "number");
  return {
    demo: false,
    generated_at: generatedAt,
    timezone: tz,
    source: "Lens API (api.lens.xyz), live",
    days,
    spam_apps: Object.values(SPAM_APPS),
    accounts_total: accts.size,
    accounts_score_known: known.length,
    accounts_score_zero: known.filter(a => scores[a] === 0).length,
    accounts_by_min_score: Object.fromEntries(MIN_SCORES.map(m => [m, known.filter(a => scores[a] >= m).length])),
    min_scores: MIN_SCORES,
    top_format: ["address", "handle", "post", "comment", "quote", "repost"],
    variants,
  };
}

// Per-account data for the searchable accounts section (site/users.json).
// users: [address, handle, score, [post, comment, quote, repost], [appIdx, n, ...], [dayIdx, n, ...]], most active first.
export function buildUsers({ agg, handles, appNames, scores = {}, days }) {
  const appIdx = {}, apps = [];
  const nameOf = a => HIGHLIGHT[a] || appNames[a] || SPAM_APPS[a] || (a === "none" ? "Unknown / no app" : a.slice(0, 8) + "…" + a.slice(-4));
  const u = {};
  days.forEach((d, i) => {
    for (const [k, n] of Object.entries(agg[d] || {})) {
      const [app, acct, kind] = k.split("|");
      if (!(app in appIdx)) { appIdx[app] = apps.length; apps.push([app, nameOf(app), !!SPAM_APPS[app]]); }
      const x = (u[acct] ||= { t: [0, 0, 0, 0], a: {}, d: {} });
      x.t[KINDS.indexOf(kind)] += n;
      x.a[appIdx[app]] = (x.a[appIdx[app]] || 0) + n;
      x.d[i] = (x.d[i] || 0) + n;
    }
  });
  const users = Object.entries(u)
    .map(([acct, x]) => [acct, handles[acct] || null, typeof scores[acct] === "number" ? scores[acct] : null, x.t,
      Object.entries(x.a).sort((p, q) => q[1] - p[1]).flat().map(Number),
      Object.entries(x.d).flat().map(Number)])
    .sort((p, q) => (q[3][0] + q[3][1] + q[3][2] + q[3][3]) - (p[3][0] + p[3][1] + p[3][2] + p[3][3]));
  return { days, apps, users };
}

function buildVariant({ agg, handles, appNames, days, keep }) {
  const N = days.length, idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const rows = d => Object.entries(agg[d] || {}).filter(([k]) => { const [a, acct] = k.split("|"); return keep(a, acct); });

  const vol = {};
  for (const d of days) for (const [k, n] of rows(d)) { const a = k.split("|")[0]; vol[a] = (vol[a] || 0) + n; }

  const name = a => HIGHLIGHT[a] || appNames[a] || SPAM_APPS[a] || (a === "none" ? "Unknown / no app" : a.slice(0, 8) + "…" + a.slice(-4));
  const highlighted = Object.keys(HIGHLIGHT);
  const others = Object.entries(vol).filter(([a]) => !HIGHLIGHT[a] && vol[a] > 0).sort((x, y) => y[1] - x[1]).slice(0, TOP_OTHER_APPS).map(([a]) => a);
  const shown = [...highlighted, ...others];
  const shownSet = new Set(shown);
  const bucket = a => (shownSet.has(a) ? a : "other");
  const keys = ["all", ...shown, "other"];

  const daily = Object.fromEntries(keys.map(k => [k, { ...Object.fromEntries(KINDS.map(x => [x, Array(N).fill(0)])), active: Array(N).fill(0) }]));
  const activeSets = {};
  const acctDay = []; // [key, acct, i, kind, n]

  for (const d of days) {
    const i = idx[d];
    for (const [k, n] of rows(d)) {
      const [app, acct, kind] = k.split("|");
      for (const key of ["all", bucket(app)]) {
        daily[key][kind][i] += n;
        (activeSets[key + "|" + i] ||= new Set()).add(acct);
        acctDay.push([key, acct, i, kind, n]);
      }
    }
  }
  for (const [ki, s] of Object.entries(activeSets)) { const [k, i] = ki.split("|"); daily[k].active[+i] = s.size; }

  // windows of complete days, today excluded
  const rangeActive = {}, topUsers = {};
  for (const r of RANGES) {
    const hi = N - 1, lo = hi - r;
    const by = {};
    for (const [key, acct, i, kind, n] of acctDay) {
      if (i < lo || i >= hi) continue;
      const u = ((by[key] ||= {})[acct] ||= { post: 0, comment: 0, quote: 0, repost: 0 });
      u[kind] += n;
    }
    rangeActive[r] = {}; topUsers[r] = {};
    for (const key of keys) {
      const accts = Object.entries(by[key] || {});
      rangeActive[r][key] = accts.length;
      topUsers[r][key] = accts
        .map(([a, c]) => [a, handles[a] || null, c.post, c.comment, c.quote, c.repost])
        .sort((x, y) => (y[2] + y[3] + y[4] + y[5]) - (x[2] + x[3] + x[4] + x[5])).slice(0, 10);
    }
  }

  return {
    apps: [...shown.map(a => ({ key: a, address: a === "none" ? null : a, name: name(a), highlighted: !!HIGHLIGHT[a] })),
           { key: "other", address: null, name: "Other apps", highlighted: false }],
    daily,
    range_active: rangeActive,
    top_users: topUsers,
  };
}

// ------------------------------------------------------------------ Node runner

async function main() {
  const root = dirname(fileURLToPath(import.meta.url));
  const DAYS = +(process.env.LENS_DAYS || 90);
  const TZ = process.env.LENS_TZ || "UTC";
  const REFETCH = +(process.env.REFETCH_DAYS || 1);
  const dayDir = join(root, "data", "days");
  mkdirSync(dayDir, { recursive: true });
  const metaPath = join(root, "data", "meta.json");
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : { handles: {}, appNames: {} };
  meta.scores ||= {};
  if (meta.tz && meta.tz !== TZ) { // time zone changed: day files are no longer valid
    for (const f of readdirSync(dayDir)) unlinkSync(join(dayDir, f));
  }
  meta.tz = TZ;

  const days = dayList(DAYS, TZ);
  const have = new Set(readdirSync(dayDir).map(f => f.replace(".json", "")));
  const refetchFrom = days[days.length - 1 - REFETCH];
  const missing = days.filter(d => !have.has(d) && d < refetchFrom);
  const fromDay = missing.length ? missing[0] : refetchFrom;
  console.log(`Lens collector: window ${days[0]}..${days.at(-1)} (${TZ}), fetching from ${fromDay}`);

  const { agg, handles, scores } = await fetchSince(fromDay, TZ, console.log);
  for (const d of days.filter(d => d >= fromDay)) {
    writeFileSync(join(dayDir, d + ".json"), JSON.stringify(agg[d] || {}));
  }
  // prune days that fell out of the window
  for (const f of readdirSync(dayDir)) if (f.replace(".json", "") < days[0]) unlinkSync(join(dayDir, f));

  Object.assign(meta.handles, handles);
  Object.assign(meta.scores, scores);
  const all = {};
  for (const d of days) { const p = join(dayDir, d + ".json"); if (existsSync(p)) all[d] = JSON.parse(readFileSync(p, "utf8")); }

  // Account scores: fill unknown accounts every run, refresh all window accounts once a day
  const windowAccts = [...new Set(Object.values(all).flatMap(o => Object.keys(o).map(k => k.split("|")[1])))];
  const todayStr = days.at(-1);
  const toFetch = meta.scoresDay === todayStr ? windowAccts.filter(a => !(a in meta.scores)) : windowAccts;
  if (toFetch.length) {
    console.log(`  fetching scores for ${toFetch.length} accounts`);
    Object.assign(meta.scores, await fetchScores(toFetch, console.log));
    if (meta.scoresDay !== todayStr) meta.scoresDay = todayStr;
  }
  const inWindow = new Set(windowAccts); // keep meta small: drop accounts no longer in the window
  for (const a of Object.keys(meta.scores)) if (!inWindow.has(a)) delete meta.scores[a];
  for (const a of Object.keys(meta.handles)) if (!inWindow.has(a)) delete meta.handles[a];
  const seenApps = new Set(Object.values(all).flatMap(o => Object.keys(o).map(k => k.split("|")[0])));
  const unnamed = [...seenApps].filter(a => !(a in meta.appNames) && !HIGHLIGHT[a] && a !== "none");
  const named = await fetchAppNames(unnamed);
  for (const a of unnamed) meta.appNames[a] = named[a] || null;
  writeFileSync(metaPath, JSON.stringify(meta));

  const data = buildData({ agg: all, handles: meta.handles, appNames: meta.appNames, scores: meta.scores, days, tz: TZ, generatedAt: new Date().toISOString() });
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site", "data.json"), JSON.stringify(data));
  writeFileSync(join(root, "site", "users.json"), JSON.stringify(buildUsers({ agg: all, handles: meta.handles, appNames: meta.appNames, scores: meta.scores, days })));
  console.log(`Wrote site/data.json (${Object.keys(all).length} days with data)`);
}

if (typeof process !== "undefined" && process.argv?.[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exit(1); });
}
