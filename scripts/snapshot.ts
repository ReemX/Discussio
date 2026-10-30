// Merges the live instance's raw counts into the all-time stats snapshot.
// Run by .github/workflows/stats-snapshot.yml:
//   deno run --allow-net --allow-read --allow-write scripts/snapshot.ts <file> <raw-stats-url>

import { emptySnapshot, mergeSnapshot, type RawStats, type Snapshot } from "../src/snapshot.ts";

const [file, url] = Deno.args;
if (!file || !url) {
  console.error("usage: snapshot.ts <snapshot.json> <raw-stats-url>");
  Deno.exit(2);
}

let prev: Snapshot;
try {
  prev = JSON.parse(await Deno.readTextFile(file));
} catch {
  prev = emptySnapshot();
}

const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
if (res.status === 404) {
  console.log("Live instance doesn't expose raw stats yet (not deployed); skipping.");
  Deno.exit(0);
}
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const raw = await res.json() as RawStats;

if (raw.backend === "upstash") {
  console.log("Instance persists to Upstash; snapshot not needed.");
  Deno.exit(0);
}

const next = mergeSnapshot(prev, raw);
await Deno.writeTextFile(file, JSON.stringify(next) + "\n");
console.log(
  `Merged ${raw.instance}: ${next.totals.counters.views ?? 0} views, ` +
    `${next.totals.counters.clicks ?? 0} clicks all-time`,
);
