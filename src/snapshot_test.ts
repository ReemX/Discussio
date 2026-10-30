import { assertEquals } from "@std/assert";
import { baselineFor, emptySnapshot, mergeSnapshot, type RawStats } from "./snapshot.ts";

const raw = (instance: string, views: number, titles: Record<string, number>): RawStats => ({
  instance,
  backend: "github",
  counters: { views },
  titles,
  names: { tt1: "One" },
});

Deno.test("mergeSnapshot adds only what is new within an instance", () => {
  let s = mergeSnapshot(emptySnapshot(), raw("a", 10, { tt1: 4 }));
  s = mergeSnapshot(s, raw("a", 15, { tt1: 6 }));
  assertEquals(s.totals.counters.views, 15);
  assertEquals(s.totals.titles.tt1, 6);
  assertEquals(s.totals.names.tt1, "One");
});

Deno.test("mergeSnapshot counts a restarted instance from zero", () => {
  let s = mergeSnapshot(emptySnapshot(), raw("a", 10, { tt1: 4 }));
  s = mergeSnapshot(s, raw("b", 3, { tt1: 1 }));
  assertEquals(s.totals.counters.views, 13);
  assertEquals(s.totals.titles.tt1, 5);
});

Deno.test("mergeSnapshot treats a dropped title count as evicted and re-counted", () => {
  let s = mergeSnapshot(emptySnapshot(), raw("a", 10, { tt1: 4 }));
  s = mergeSnapshot(s, raw("a", 12, { tt1: 2 }));
  assertEquals(s.totals.titles.tt1, 6);
});

Deno.test("mergeSnapshot handles replicas read in alternation", () => {
  let s = emptySnapshot();
  s = mergeSnapshot(s, raw("a", 10, { tt1: 4 }));
  s = mergeSnapshot(s, raw("b", 7, { tt1: 2 }));
  s = mergeSnapshot(s, raw("a", 12, { tt1: 5 }));
  s = mergeSnapshot(s, raw("b", 7, { tt1: 2 }));
  assertEquals(s.totals.counters.views, 19);
  assertEquals(s.totals.titles.tt1, 7);
  assertEquals(baselineFor(s, "a").counters.views, 7);
});

Deno.test("mergeSnapshot forgets instances unseen for two days", () => {
  let s = mergeSnapshot(emptySnapshot(), raw("a", 10, {}), new Date("2026-01-01T00:00:00Z"));
  s = mergeSnapshot(s, raw("b", 1, {}), new Date("2026-01-04T00:00:00Z"));
  assertEquals(Object.keys(s.instances!), ["b"]);
  assertEquals(s.totals.counters.views, 11);
});

Deno.test("baselineFor removes this instance's already-merged counts", () => {
  let s = mergeSnapshot(emptySnapshot(), raw("a", 10, { tt1: 4 }));
  s = mergeSnapshot(s, raw("b", 3, { tt1: 1 }));
  assertEquals(baselineFor(s, "b").counters.views, 10);
  assertEquals(baselineFor(s, "b").titles.tt1, 4);
  assertEquals(baselineFor(s, "c").counters.views, 13);
});
