// Merges the live instances' raw counts into the all-time stats snapshot.
// Run by .github/workflows/stats-snapshot.yml:
//   deno run --allow-net --allow-read --allow-write scripts/snapshot.ts <file> <raw-stats-url>
//
// The host load-balances across replicas, so the URL is read several times,
// each over a fresh connection, to reach every instance.

import { emptySnapshot, mergeSnapshot, type RawStats, type Snapshot } from "../src/snapshot.ts";

const READS = 12;

const [file, url] = Deno.args;
if (!file || !url) {
  console.error("usage: snapshot.ts <snapshot.json> <raw-stats-url>");
  Deno.exit(2);
}

let snap: Snapshot;
try {
  snap = JSON.parse(await Deno.readTextFile(file));
} catch {
  snap = emptySnapshot();
}

const seen = new Set<string>();
for (let i = 0; i < READS; i++) {
  // A new client per read means a new connection, so the load balancer can
  // route it to a different replica.
  const client = Deno.createHttpClient({});
  try {
    const res = await fetch(url, { client, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) {
      await res.body?.cancel();
      console.log("Live instance doesn't expose raw stats yet (not deployed); skipping.");
      Deno.exit(0);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json() as RawStats;
    if (raw.backend === "upstash") {
      console.log("Instances persist to Upstash; snapshot not needed.");
      Deno.exit(0);
    }
    // Re-reading an instance is harmless: merges only add what's new.
    snap = mergeSnapshot(snap, raw);
    seen.add(raw.instance);
  } catch (err) {
    console.warn(`Read ${i + 1} failed:`, err);
  } finally {
    client.close();
  }
}

if (!seen.size) throw new Error("No instance could be read");
await Deno.writeTextFile(file, JSON.stringify(snap) + "\n");
console.log(
  `Merged ${seen.size} instance(s): ${snap.totals.counters.views ?? 0} views, ` +
    `${snap.totals.counters.clicks ?? 0} clicks all-time`,
);
