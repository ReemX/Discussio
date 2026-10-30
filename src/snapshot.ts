// Secret-free persistence for stats. The server only counts in memory and
// exposes its raw counts at /stats/raw.json. A scheduled GitHub Action (with
// GitHub's built-in token — nothing for the host to keep secret) merges
// readings into an all-time snapshot on the stats-data branch, and the server
// reads that public file back to show all-time totals. Pure functions only.
//
// The host may run several replicas behind a load balancer, each counting on
// its own, so the snapshot remembers the last reading of every instance and
// only ever adds the difference since that instance's previous reading.

export type Counts = Record<string, number>;

// What /stats/raw.json serves: one instance's counts since it started.
export interface RawStats {
  instance: string;
  backend: string;
  counters: Counts;
  titles: Counts;
  names: Record<string, string>;
}

interface InstanceReading {
  seen: string;
  counters: Counts;
  titles: Counts;
}

export interface Snapshot {
  updated_at?: string;
  totals: { counters: Counts; titles: Counts; names: Record<string, string> };
  // Last reading merged per instance, so the next one only adds what's new.
  instances?: Record<string, InstanceReading>;
}

export const SNAPSHOT_TITLES_MAX = 2000;
// Instances unseen this long are gone (restarted or scaled down).
const INSTANCE_TTL_MS = 2 * 24 * 60 * 60 * 1000;

export function emptySnapshot(): Snapshot {
  return { totals: { counters: {}, titles: {}, names: {} }, instances: {} };
}

// Counts only grow within an instance, so a lower reading means the key was
// evicted from memory and restarted from zero: all of it is new.
function delta(now: Counts, before: Counts = {}): Counts {
  const out: Counts = {};
  for (const [k, n] of Object.entries(now)) {
    const prev = before[k] ?? 0;
    const d = n >= prev ? n - prev : n;
    if (d > 0) out[k] = d;
  }
  return out;
}

function add(into: Counts, from: Counts): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

export function mergeSnapshot(prev: Snapshot, raw: RawStats, now = new Date()): Snapshot {
  const before = prev.instances?.[raw.instance];
  const counters = { ...prev.totals.counters };
  const titles = { ...prev.totals.titles };
  add(counters, delta(raw.counters, before?.counters));
  add(titles, delta(raw.titles, before?.titles));
  // Keep the file small: only the top titles and their names survive.
  const kept = Object.entries(titles)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SNAPSHOT_TITLES_MAX);
  const names: Record<string, string> = {};
  for (const [id] of kept) {
    const name = raw.names[id] ?? prev.totals.names[id];
    if (name) names[id] = name;
  }
  const instances: Record<string, InstanceReading> = {};
  for (const [id, r] of Object.entries(prev.instances ?? {})) {
    if (now.getTime() - Date.parse(r.seen) < INSTANCE_TTL_MS) instances[id] = r;
  }
  instances[raw.instance] = {
    seen: now.toISOString(),
    counters: raw.counters,
    titles: raw.titles,
  };
  return {
    updated_at: now.toISOString(),
    totals: { counters, titles: Object.fromEntries(kept), names },
    instances,
  };
}

// The snapshot's totals minus anything it already took from this instance,
// so the server can add its own live counts on top without double counting.
export function baselineFor(snap: Snapshot, instance: string): Snapshot["totals"] {
  const counters = { ...snap.totals.counters };
  const titles = { ...snap.totals.titles };
  const own = snap.instances?.[instance];
  if (own) {
    for (const [k, n] of Object.entries(own.counters)) {
      counters[k] = Math.max(0, (counters[k] ?? 0) - n);
    }
    for (const [k, n] of Object.entries(own.titles)) {
      if (k in titles) titles[k] = Math.max(0, titles[k] - n);
    }
  }
  return { counters, titles, names: snap.totals.names };
}
