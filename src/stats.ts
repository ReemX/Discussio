// Anonymous usage counters. Always counted in memory; when Redis is
// configured they are also flushed there once a minute as a single EVAL.
// Every replica flushes only its own increments, which Redis adds atomically,
// so Redis holds exact all-time totals across replicas and restarts.
// Without Redis, stats cover this instance only.
//
// Redis, in order of preference:
//  - REDIS_URL: native Redis, redis://[[user]:password@]host[:port][/db]
//  - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN: Upstash over REST

import type { ContentType, Venue } from "./discussio.ts";
import { parseRedisUrl, redisCommand } from "./redis.ts";

const FLUSH_INTERVAL_MS = 60 * 1000;
const STATS_CACHE_MS = 60 * 1000;
const REDIS_TIMEOUT_MS = 5000;
const TITLES_MEM_MAX = 5000;
const TOP_TITLES = 25;
const DAYS = 30;

const REDIS_URL = Deno.env.get("REDIS_URL");
const UPSTASH_URL = Deno.env.get("UPSTASH_REDIS_REST_URL");
const UPSTASH_TOKEN = Deno.env.get("UPSTASH_REDIS_REST_TOKEN");

export type Backend = "redis" | "upstash" | "memory";

const backend: Backend = REDIS_URL
  ? "redis"
  : UPSTASH_URL && UPSTASH_TOKEN
  ? "upstash"
  : "memory";
const persistent = backend !== "memory";
const redisTarget = REDIS_URL ? parseRedisUrl(REDIS_URL) : null;

// This instance's counts since start. Counter fields: views, views:<type>,
// views:day:<date>, clicks, clicks:venue:<venue>, clicks:day:<date>.
const counters = new Map<string, number>();
const titles = new Map<string, number>();
const names = new Map<string, string>();

// Counts not yet packed into a batch.
const pending = {
  counters: new Map<string, number>(),
  titles: new Map<string, number>(),
  names: new Map<string, string>(),
};

// Batches not yet confirmed by Redis, oldest first. A batch keeps its id
// across retries: a timed-out EVAL may still have been applied (it was already
// in Redis's input buffer), and the id lets the script skip a duplicate.
interface Batch {
  id: string;
  c: Record<string, number>;
  t: Record<string, number>;
  n: Record<string, string>;
}
const unsent: Batch[] = [];
const UNSENT_MAX = 1440; // a day of minutely batches
let flushing = false;

const FLUSH_SCRIPT = `
if not redis.call('SET', 'discussio:batch:' .. ARGV[2], 1, 'NX', 'EX', 86400) then return 0 end
local p = cjson.decode(ARGV[1])
for f, n in pairs(p.c) do redis.call('HINCRBY', 'discussio:counters', f, n) end
for id, n in pairs(p.t) do redis.call('ZINCRBY', 'discussio:titles', n, id) end
for id, name in pairs(p.n) do redis.call('HSET', 'discussio:names', id, name) end
redis.call('ZREMRANGEBYRANK', 'discussio:titles', 0, -20001)
return 1`;

const READ_SCRIPT = `
local c = redis.call('HGETALL', 'discussio:counters')
local t = redis.call('ZREVRANGE', 'discussio:titles', 0, ${TOP_TITLES - 1}, 'WITHSCORES')
local ids = {}
for i = 1, #t, 2 do ids[#ids + 1] = t[i] end
local n = {}
if #ids > 0 then n = redis.call('HMGET', 'discussio:names', unpack(ids)) end
return cjson.encode({ c = c, t = t, n = n })`;

type Logger = { info: (m: string, d?: unknown) => void; warn: (m: string, d?: unknown) => void };
let log: Logger = console;

function bump(map: Map<string, number>, key: string, n = 1): void {
  map.set(key, (map.get(key) ?? 0) + n);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function count(field: string): void {
  bump(counters, field);
  if (persistent) bump(pending.counters, field);
}

function countTitle(id: string, name?: string): void {
  if (titles.size >= TITLES_MEM_MAX && !titles.has(id)) {
    const oldest = titles.keys().next().value;
    if (oldest !== undefined) {
      titles.delete(oldest);
      names.delete(oldest);
    }
  }
  bump(titles, id);
  if (persistent) bump(pending.titles, id);
  if (name && names.get(id) !== name) {
    names.set(id, name);
    if (persistent) pending.names.set(id, name);
  }
}

export function recordView(type: ContentType, id: string, name?: string): void {
  count("views");
  count(`views:${type}`);
  count(`views:day:${today()}`);
  countTitle(id, name);
}

export function recordClick(venue: Venue): void {
  count("clicks");
  count(`clicks:venue:${venue}`);
  count(`clicks:day:${today()}`);
}

async function redis(command: (string | number)[]): Promise<unknown> {
  if (redisTarget) return await redisCommand(redisTarget, command, REDIS_TIMEOUT_MS);
  const res = await fetch(UPSTASH_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(REDIS_TIMEOUT_MS),
  });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.result;
}

export async function flush(): Promise<void> {
  if (!persistent || flushing) return;
  flushing = true;
  try {
    if (pending.counters.size || pending.titles.size) {
      unsent.push({
        id: crypto.randomUUID(),
        c: Object.fromEntries(pending.counters),
        t: Object.fromEntries(pending.titles),
        n: Object.fromEntries(pending.names),
      });
      pending.counters.clear();
      pending.titles.clear();
      pending.names.clear();
      if (unsent.length > UNSENT_MAX) {
        unsent.shift();
        log.warn("Stats backlog full, dropped the oldest batch");
      }
    }
    while (unsent.length) {
      const { id, ...batch } = unsent[0];
      await redis(["EVAL", FLUSH_SCRIPT, 0, JSON.stringify(batch), id]);
      unsent.shift();
    }
  } catch (err) {
    log.warn(`Stats flush failed, will retry (${unsent.length} batch(es) queued)`, err);
  } finally {
    flushing = false;
  }
}

export function startStats(logger: Logger): void {
  log = logger;
  log.info(`Stats backend: ${backend}`);
  if (!persistent) return;
  setInterval(() => flush(), FLUSH_INTERVAL_MS);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    try {
      Deno.addSignalListener(sig, () => flush().finally(() => Deno.exit(0)));
    } catch {
      // Signal not supported on this platform (e.g. SIGTERM on Windows).
    }
  }
}

interface TopTitle {
  id: string;
  name?: string;
  views: number;
}

export interface Stats {
  version: string;
  started_at: string;
  backend: Backend;
  cache_size: number;
  views: number;
  clicks: number;
  click_through: number;
  by_type: { series: number; movie: number };
  by_venue: { venue: string; clicks: number }[];
  by_day: { date: string; views: number; clicks: number }[];
  top_titles: TopTitle[];
}

type StatsMeta = Pick<Stats, "version" | "started_at" | "cache_size">;

function summarize(
  c: Map<string, number>,
  top: TopTitle[],
  meta: StatsMeta,
  backend: Backend,
): Stats {
  const views = c.get("views") ?? 0;
  const clicks = c.get("clicks") ?? 0;
  const days = new Map<string, { views: number; clicks: number }>();
  const venues: Stats["by_venue"] = [];
  for (const [field, n] of c) {
    const day = field.match(/^(views|clicks):day:(.+)$/);
    if (day) {
      const d = days.get(day[2]) ?? { views: 0, clicks: 0 };
      d[day[1] as "views" | "clicks"] += n;
      days.set(day[2], d);
    }
    const venue = field.match(/^clicks:venue:(.+)$/);
    if (venue) venues.push({ venue: venue[1], clicks: n });
  }
  return {
    ...meta,
    backend,
    views,
    clicks,
    click_through: views ? Math.round((clicks / views) * 1000) / 10 : 0,
    by_type: { series: c.get("views:series") ?? 0, movie: c.get("views:movie") ?? 0 },
    by_venue: venues.sort((a, b) => b.clicks - a.clicks),
    by_day: [...days.entries()]
      .map(([date, d]) => ({ date, ...d }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, DAYS),
    top_titles: top,
  };
}

async function redisSummary(meta: StatsMeta): Promise<Stats> {
  const raw = JSON.parse(await redis(["EVAL", READ_SCRIPT, 0]) as string) as {
    c: string[];
    t: string[];
    n: (string | false)[];
  };
  const c = new Map<string, number>();
  for (let i = 0; i < raw.c.length; i += 2) c.set(raw.c[i], Number(raw.c[i + 1]));
  // Redis holds the flushed totals; add what's still waiting to flush.
  for (const [k, n] of pending.counters) bump(c, k, n);
  for (const b of unsent) for (const [k, n] of Object.entries(b.c)) bump(c, k, n);
  const top: TopTitle[] = [];
  for (let i = 0; i < raw.t.length; i += 2) {
    const id = raw.t[i];
    top.push({ id, name: raw.n[i / 2] || names.get(id), views: Number(raw.t[i + 1]) });
  }
  return summarize(c, top, meta, backend);
}

function memorySummary(meta: StatsMeta): Stats {
  const top = [...titles.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_TITLES)
    .map(([id, views]) => ({ id, name: names.get(id), views }));
  return summarize(counters, top, meta, "memory");
}

let statsCache: { stats: Stats; ts: number } | null = null;

export async function readStats(meta: StatsMeta): Promise<Stats> {
  if (statsCache && Date.now() - statsCache.ts < STATS_CACHE_MS) return statsCache.stats;
  let stats: Stats | null = null;
  if (persistent) {
    try {
      stats = await redisSummary(meta);
    } catch (err) {
      log.warn("Stats read failed, showing this instance only", err);
    }
  }
  stats ??= memorySummary(meta);
  statsCache = { stats, ts: Date.now() };
  return stats;
}
