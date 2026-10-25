#!/usr/bin/env node
// Lens Protocol activity collector -> data/days/*.json + site/data.json, users.json, groups.json
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

// Groups whose content is automated spam (lower-case address -> name). Hidden with "Hide spam" on the Groups page.
export const SPAM_GROUPS = {};

// Filter combinations precomputed for the dashboard: spam apps shown (s) or hidden (n) x minimum account score.
// Lens account score: 1..10000, an ML estimate of how likely the account is genuine (0 = not scored / flagged).
export const MIN_SCORES = [0, 1, 5000, 9000];
export const VARIANTS = Object.fromEntries([true, false].flatMap(spam =>
  MIN_SCORES.map(min => [(spam ? "s" : "n") + min, { spam, min }])));

const POSTS_Q = `query P($c: Cursor){ posts(request:{pageSize: FIFTY, cursor: $c, filter:{postTypes:[ROOT,COMMENT,QUOTE,REPOST]}}){
  items{ __typename
    ... on Post { timestamp author{ address score username{ localName } } app{ address } commentOn{ id } quoteOf{ id } feed{ group{ address } } }
    ... on Repost { timestamp author{ address score username{ localName } } app{ address } repostOf{ feed{ group{ address } } } } }
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

// Group the content was published in ("" = global feed). Comments and quotes share their parent's feed;
// reposts have no feed of their own, so the reposted post's group is used.
export function groupOf(p) {
  const g = p.__typename === "Repost" ? p.repostOf?.feed?.group : p.feed?.group;
  return (g?.address || "").toLowerCase();
}

// Fetch posts newest-first until the day boundary `fromDay` (inclusive) is passed.
// Returns { agg: {day: {"app|account|kind|group": n}}, handles: {account: localName}, scores: {account: score} }
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
      const key = app + "|" + acct + "|" + classify(p) + "|" + groupOf(p);
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

// Name, icon and member count of groups, 5 per request (the API allows 10 top-level aliases)
export async function fetchGroupInfo(addrs, log = () => {}) {
  const out = {};
  for (let i = 0; i < addrs.length; i += 5) {
    const batch = addrs.slice(i, i + 5);
    const q = "query G{" + batch.map((a, j) => `g${j}: group(request:{group:"${a}"}){ metadata{ name icon } } s${j}: groupStats(request:{group:"${a}"}){ totalMembers }`).join(" ") + "}";
    try {
      const d = await gql(q);
      batch.forEach((a, j) => {
        const m = d["g" + j]?.metadata;
        out[a] = { name: m?.name?.trim() || null, icon: m?.icon || null, members: d["s" + j]?.totalMembers ?? null };
      });
    } catch (e) { log("  group batch failed: " + e.message); }
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

// Per-account data for the accounts table and account details (site/users.json).
// users: [address, handle, score, [dayIdx, appIdx, kindIdx, n, ...]], most active first.
export function buildUsers({ agg, handles, appNames, scores = {}, days }) {
  const appIdx = {}, apps = [];
  const nameOf = a => HIGHLIGHT[a] || appNames[a] || SPAM_APPS[a] || (a === "none" ? "Unknown / no app" : a.slice(0, 8) + "…" + a.slice(-4));
  const u = {};
  days.forEach((d, i) => {
    for (const [k, n] of Object.entries(agg[d] || {})) {
      const [app, acct, kind] = k.split("|");
      if (!(app in appIdx)) { appIdx[app] = apps.length; apps.push([app, nameOf(app), !!SPAM_APPS[app]]); }
      const x = (u[acct] ||= { total: 0, e: [] });
      x.e.push(i, appIdx[app], KINDS.indexOf(kind), n);
      x.total += n;
    }
  });
  const users = Object.entries(u)
    .sort((p, q) => q[1].total - p[1].total)
    .map(([acct, x]) => [acct, handles[acct] || null, typeof scores[acct] === "number" ? scores[acct] : null, x.e]);
  return { v: 2, days, apps, users };
}

// Drop the group from the keys ("app|acct|kind|group" -> "app|acct|kind") for data.json and users.json.
export function withoutGroups(agg) {
  const out = {};
  for (const [d, o] of Object.entries(agg)) {
    const x = (out[d] = {});
    for (const [k, n] of Object.entries(o)) { const p = k.split("|"), kk = p[0] + "|" + p[1] + "|" + p[2]; x[kk] = (x[kk] || 0) + n; }
  }
  return out;
}

// Group activity for the Groups page (site/groups.json).
// groups: [address, name, icon, members, membersWeekAgo, isSpam], most active first
// apps: [address, name, isSpam]; accounts: [address, handle, score]
// e: flat [dayIdx, groupIdx, appIdx, accountIdx, kindIdx, n, ...]
export function buildGroups({ agg, handles, appNames, scores = {}, days, groupInfo = {}, members = {} }) {
  const nameOf = a => HIGHLIGHT[a] || appNames[a] || SPAM_APPS[a] || (a === "none" ? "Unknown / no app" : a.slice(0, 8) + "…" + a.slice(-4));
  const vol = {};
  for (const d of days) for (const [k, n] of Object.entries(agg[d] || {})) { const g = k.split("|")[3]; if (g) vol[g] = (vol[g] || 0) + n; }
  const gList = Object.keys(vol).sort((a, b) => vol[b] - vol[a]);
  const gIdx = Object.fromEntries(gList.map((g, i) => [g, i]));
  const appIdx = {}, apps = [], acctIdx = {}, accounts = [], e = [];
  days.forEach((d, i) => {
    for (const [k, n] of Object.entries(agg[d] || {})) {
      const [app, acct, kind, g] = k.split("|");
      if (!g) continue;
      if (!(app in appIdx)) { appIdx[app] = apps.length; apps.push([app, nameOf(app), !!SPAM_APPS[app]]); }
      if (!(acct in acctIdx)) { acctIdx[acct] = accounts.length; accounts.push([acct, handles[acct] || null, typeof scores[acct] === "number" ? scores[acct] : null]); }
      e.push(i, gIdx[g], appIdx[app], acctIdx[acct], KINDS.indexOf(kind), n);
    }
  });
  const today = days.at(-1), weekAgo = days[Math.max(0, days.length - 8)];
  const groups = gList.map(g => {
    const info = groupInfo[g] || {}, hist = members[g] || {};
    return [g, info.name || null, info.icon || null, hist[today] ?? info.members ?? null, hist[weekAgo] ?? null, !!SPAM_GROUPS[g]];
  });
  return { v: 1, days, groups, apps, accounts, e };
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
  // day files from before group tracking (meta.groupsV) are re-fetched once, whole window
  const fromDay = meta.groupsV !== 1 ? days[0] : missing.length ? missing[0] : refetchFrom;
  console.log(`Lens collector: window ${days[0]}..${days.at(-1)} (${TZ}), fetching from ${fromDay}`);

  const { agg, handles, scores } = await fetchSince(fromDay, TZ, console.log);
  for (const d of days.filter(d => d >= fromDay)) {
    writeFileSync(join(dayDir, d + ".json"), JSON.stringify(agg[d] || {}));
  }
  meta.groupsV = 1;
  // prune days that fell out of the window
  for (const f of readdirSync(dayDir)) if (f.replace(".json", "") < days[0]) unlinkSync(join(dayDir, f));

  Object.assign(meta.handles, handles);
  Object.assign(meta.scores, scores);
  const all = {};
  for (const d of days) { const p = join(dayDir, d + ".json"); if (existsSync(p)) all[d] = JSON.parse(readFileSync(p, "utf8")); }
  const flat = withoutGroups(all);

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

  // Groups: name, icon and member count of every group active in the window, refreshed once a day;
  // member counts are kept per day so the Groups page can show the weekly change.
  const gPath = join(root, "data", "group_meta.json");
  const gm = existsSync(gPath) ? JSON.parse(readFileSync(gPath, "utf8")) : { info: {}, members: {} };
  const seenGroups = [...new Set(Object.values(all).flatMap(o => Object.keys(o).map(k => k.split("|")[3]).filter(Boolean)))];
  const gTodo = gm.day === todayStr ? seenGroups.filter(g => !(g in gm.info)) : seenGroups;
  if (gTodo.length) {
    console.log(`  fetching info for ${gTodo.length} groups`);
    for (const [g, x] of Object.entries(await fetchGroupInfo(gTodo, console.log))) {
      gm.info[g] = x;
      if (x.members != null) (gm.members[g] ||= {})[todayStr] = x.members;
    }
    gm.day = todayStr;
  }
  const seenSet = new Set(seenGroups);
  for (const g of Object.keys(gm.info)) if (!seenSet.has(g)) { delete gm.info[g]; delete gm.members[g]; }
  for (const h of Object.values(gm.members)) for (const d of Object.keys(h)) if (d < days[0]) delete h[d];
  writeFileSync(gPath, JSON.stringify(gm));

  const data = buildData({ agg: flat, handles: meta.handles, appNames: meta.appNames, scores: meta.scores, days, tz: TZ, generatedAt: new Date().toISOString() });
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site", "data.json"), JSON.stringify(data));
  writeFileSync(join(root, "site", "users.json"), JSON.stringify(buildUsers({ agg: flat, handles: meta.handles, appNames: meta.appNames, scores: meta.scores, days })));
  writeFileSync(join(root, "site", "groups.json"), JSON.stringify(buildGroups({ agg: all, handles: meta.handles, appNames: meta.appNames, scores: meta.scores, days, groupInfo: gm.info, members: gm.members })));
  console.log(`Wrote site/data.json (${Object.keys(all).length} days with data)`);
}

if (typeof process !== "undefined" && process.argv?.[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exit(1); });
}
