// Discussio — Stremio addon for one-click discussion links.
// Routing lives in discussio.ts; this file is the HTTP server, metadata cache
// and anonymous stats.

import {
  type ContentType,
  META_SOURCES,
  movieStreams,
  parseId,
  type RawMeta,
  seriesStreams,
  type Stream,
  type TitleInfo,
  toTitleInfo,
} from "./discussio.ts";

const VERSION = "1.3.0";
const REPO_URL = "https://github.com/ReemX/Discussio";
const LOGO_URL =
  "https://api.logo.com/api/v2/images?design=lg_aiGdQc9PParm0yrELH&width=250&height=250&fit=contain&margin_ratio=0&background=%23294fff&u=2025-02-19T10%3A24%3A54.398Z&format=png&quality=30";
const TITLE_CACHE_MAX = 5000;
const TITLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_MAX = 1000;
const TOP_IDS_MEM_MAX = 2000;
const META_TIMEOUT_MS = 5000;
const HANDLER_TIMEOUT_MS = 6500;
const STATS_CACHE_MS = 60 * 1000;
// Full answers are stable for a day; degraded ones (metadata unavailable)
// are retried soon instead of pinning a poor link in Stremio's cache.
const CACHE_OK = "max-age=86400, stale-while-revalidate=86400, stale-if-error=604800";
const CACHE_DEGRADED = "max-age=300";
const STARTED_AT = new Date().toISOString();

enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const CURRENT_LOG_LEVEL = Number(Deno.env.get("LOG_LEVEL") ?? LogLevel.INFO);

const logger = {
  debug: (m: string, d?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.DEBUG) console.debug(`[DEBUG] ${m}`, d ?? "");
  },
  info: (m: string, d?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.INFO) console.log(`[INFO] ${m}`, d ?? "");
  },
  warn: (m: string, d?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.WARN) console.warn(`[WARN] ${m}`, d ?? "");
  },
  error: (m: string, d?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.ERROR) console.error(`[ERROR] ${m}`, d ?? "");
  },
};

addEventListener("unhandledrejection", (event) => {
  logger.error("Unhandled rejection:", event.reason);
  event.preventDefault();
});

addEventListener("error", (event) => {
  logger.error("Uncaught error:", event.error ?? event.message);
});

const MANIFEST = {
  id: "com.discussio",
  version: VERSION,
  name: "Discussio | ElfHosted",
  description:
    "One click from any episode or movie to where people are discussing it: r/anime episode threads for anime, the show's subreddit thread for TV, and Letterboxd plus r/movies for films.\n\nHosted by ElfHosted!",
  logo: LOGO_URL,
  resources: ["stream"],
  types: ["series", "movie"],
  // No idPrefixes on purpose: Stremio then offers every series/movie id, and
  // ids we can't route get an empty answer. Stremio never refreshes an
  // installed manifest, so claiming everything up front means new id schemes
  // supported server-side reach existing installs without a reinstall.
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
} as const;

// ===== Metadata cache =====

interface CacheEntry {
  info: TitleInfo;
  ts: number;
}

const metaCache = new Map<string, CacheEntry>();

function cacheGet(key: string): TitleInfo | undefined {
  const entry = metaCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TITLE_CACHE_TTL_MS) {
    metaCache.delete(key);
    return undefined;
  }
  metaCache.delete(key);
  metaCache.set(key, entry);
  return entry.info;
}

function cacheSet(key: string, info: TitleInfo): void {
  if (metaCache.size >= TITLE_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(key, { info, ts: Date.now() });
}

const failureCache = new Map<string, number>();

function isNegativeCached(key: string): boolean {
  const ts = failureCache.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > NEGATIVE_CACHE_TTL_MS) {
    failureCache.delete(key);
    return false;
  }
  return true;
}

function markFailure(key: string): void {
  if (failureCache.size >= NEGATIVE_CACHE_MAX) {
    const oldest = failureCache.keys().next().value;
    if (oldest !== undefined) failureCache.delete(oldest);
  }
  failureCache.set(key, Date.now());
}

// Concurrent requests for the same title share one upstream fetch.
const inFlight = new Map<string, Promise<TitleInfo | null>>();

function fetchMeta(
  scheme: string,
  type: ContentType,
  metaId: string,
): Promise<TitleInfo | null> {
  const baseUrl = META_SOURCES[scheme];
  if (!baseUrl) return Promise.resolve(null);
  const cacheKey = `${type}:${metaId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return Promise.resolve(cached);
  if (isNegativeCached(cacheKey)) return Promise.resolve(null);
  let p = inFlight.get(cacheKey);
  if (!p) {
    p = loadMeta(`${baseUrl}/${type}/${metaId}.json`, scheme, metaId, cacheKey)
      .finally(() => inFlight.delete(cacheKey));
    inFlight.set(cacheKey, p);
  }
  return p;
}

async function loadMeta(
  url: string,
  scheme: string,
  metaId: string,
  cacheKey: string,
): Promise<TitleInfo | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      logger.warn(`Meta ${res.status} for ${metaId}`);
      markFailure(cacheKey);
      return null;
    }
    const data = await res.json();
    const info = data?.meta ? toTitleInfo(data.meta as RawMeta, scheme) : null;
    if (!info) {
      logger.warn(`Empty meta for ${metaId}`);
      markFailure(cacheKey);
      return null;
    }
    cacheSet(cacheKey, info);
    return info;
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      logger.warn(`Meta timeout for ${metaId}`);
    } else {
      logger.error(`Meta error for ${metaId}:`, err);
    }
    markFailure(cacheKey);
    return null;
  }
}

// ===== Metrics =====

let kv: Deno.Kv | null = null;
try {
  kv = await Deno.openKv();
  logger.info("Deno KV opened");
} catch (err) {
  logger.warn("Deno KV unavailable, metrics in-memory only", err);
}

const memCounters = {
  total: 0,
  series: 0,
  movie: 0,
  byDay: new Map<string, number>(),
  topIds: new Map<string, number>(),
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function recordRequest(type: ContentType, metaId: string): Promise<void> {
  memCounters.total++;
  memCounters[type]++;
  const d = today();
  memCounters.byDay.set(d, (memCounters.byDay.get(d) ?? 0) + 1);
  if (
    memCounters.topIds.size >= TOP_IDS_MEM_MAX &&
    !memCounters.topIds.has(metaId)
  ) {
    const oldest = memCounters.topIds.keys().next().value;
    if (oldest !== undefined) memCounters.topIds.delete(oldest);
  }
  memCounters.topIds.set(metaId, (memCounters.topIds.get(metaId) ?? 0) + 1);
  if (!kv) return;
  try {
    await kv.atomic()
      .sum(["c", "total"], 1n)
      .sum(["c", "type", type], 1n)
      .sum(["c", "day", d], 1n)
      .sum(["c", "id", metaId], 1n)
      .commit();
  } catch (err) {
    logger.warn("KV write failed", err);
  }
}

interface Stats {
  version: string;
  started_at: string;
  total: number;
  series: number;
  movie: number;
  cache_size: number;
  backend: "kv" | "memory";
  by_day: { date: string; count: number }[];
  top_ids: { id: string; count: number }[];
}

// /stats is public and the per-id scan grows with the catalog, so reads are
// cached briefly rather than hitting KV on every page view.
let statsCache: { stats: Stats; ts: number } | null = null;

async function readStats(): Promise<Stats> {
  if (statsCache && Date.now() - statsCache.ts < STATS_CACHE_MS) {
    return statsCache.stats;
  }
  const stats = await computeStats();
  statsCache = { stats, ts: Date.now() };
  return stats;
}

async function computeStats(): Promise<Stats> {
  const base: Stats = {
    version: VERSION,
    started_at: STARTED_AT,
    total: 0,
    series: 0,
    movie: 0,
    cache_size: metaCache.size,
    backend: kv ? "kv" : "memory",
    by_day: [],
    top_ids: [],
  };
  if (kv) {
    try {
      const [total, series, movie] = await kv.getMany<
        [Deno.KvU64, Deno.KvU64, Deno.KvU64]
      >([
        ["c", "total"],
        ["c", "type", "series"],
        ["c", "type", "movie"],
      ]);
      base.total = Number(total.value?.value ?? 0n);
      base.series = Number(series.value?.value ?? 0n);
      base.movie = Number(movie.value?.value ?? 0n);
      // Day keys are ISO dates, so reverse key order is newest first.
      for await (
        const entry of kv.list<Deno.KvU64>({ prefix: ["c", "day"] }, {
          reverse: true,
          limit: 30,
        })
      ) {
        base.by_day.push({
          date: String(entry.key[2]),
          count: Number(entry.value.value),
        });
      }
      const ids: { id: string; count: number }[] = [];
      for await (
        const entry of kv.list<Deno.KvU64>({ prefix: ["c", "id"] })
      ) {
        ids.push({
          id: String(entry.key[2]),
          count: Number(entry.value.value),
        });
      }
      base.top_ids = ids
        .sort((a, b) => b.count - a.count)
        .slice(0, 25);
      return base;
    } catch (err) {
      logger.warn("KV read failed, using memory", err);
      base.backend = "memory";
    }
  }
  base.total = memCounters.total;
  base.series = memCounters.series;
  base.movie = memCounters.movie;
  base.by_day = [...memCounters.byDay.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);
  base.top_ids = [...memCounters.topIds.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 25);
  return base;
}

// ===== Stream handler =====

interface StreamResult {
  streams: Stream[];
  degraded: boolean;
}

async function handleStream(type: ContentType, id: string): Promise<StreamResult> {
  const parsed = parseId(type, id);
  if (!parsed) {
    logger.warn("Invalid id", { type, id });
    return { streams: [], degraded: false };
  }
  const info = await fetchMeta(parsed.scheme, type, parsed.metaId);
  // tmdb never has metadata, and that's expected rather than degraded.
  const degraded = !info && parsed.scheme in META_SOURCES;
  if (degraded) logger.info(`No metadata for ${id}, serving fallback`);
  const streams = type === "series"
    ? seriesStreams(parsed, info)
    : movieStreams(parsed, info);
  // Only count ids we serve, so unroutable schemes don't pile up in KV.
  if (streams.length) recordRequest(type, parsed.metaId).catch(() => {});
  return { streams, degraded };
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        logger.error("Handler rejected:", err);
        resolve(fallback);
      },
    );
  });
}

// ===== HTML =====

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Links a stats id to its page on the id's home site.
function idUrl(id: string): string | null {
  const [scheme, num] = id.split(":");
  if (/^tt\d+$/.test(id)) return `https://www.imdb.com/title/${id}/`;
  const sites: Record<string, string> = {
    kitsu: "https://kitsu.app/anime/",
    mal: "https://myanimelist.net/anime/",
    anilist: "https://anilist.co/anime/",
    anidb: "https://anidb.net/anime/",
    tmdb: "https://www.themoviedb.org/movie/",
  };
  return sites[scheme] && num ? `${sites[scheme]}${num}` : null;
}

// The public manifest URL for this deployment, from the request so self-hosted
// instances advertise themselves. Proxies (ElfHosted) terminate TLS upstream.
function manifestUrl(req: Request): URL {
  const url = new URL("/manifest.json", req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim();
  if (host) url.host = host;
  return url;
}

function renderLanding(req: Request): string {
  const manifest = manifestUrl(req);
  const httpsUrl = manifest.href;
  const stremioUrl = `stremio://${manifest.host}${manifest.pathname}`;
  const webUrl = `https://web.stremio.com/#/addons?addon=${encodeURIComponent(httpsUrl)}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Discussio · Stremio Addon</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="One click from any episode or movie in Stremio to where people are discussing it.">
<link rel="icon" href="${escapeHtml(LOGO_URL)}">
<style>
  :root{--bg:#0b0e1a;--card:#151a30;--line:#262d50;--text:#eceefb;--muted:#9aa3d4;--accent:#294fff;--accent2:#7c8cff}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);min-height:100vh;
    background:radial-gradient(1200px 600px at 50% -10%,rgba(41,79,255,.28),transparent 60%),var(--bg);
    display:flex;align-items:center;justify-content:center;padding:32px 16px}
  main{width:100%;max-width:620px;text-align:center}
  .logo{width:112px;height:112px;border-radius:28px;box-shadow:0 18px 50px rgba(41,79,255,.45)}
  h1{margin:20px 0 4px;font-size:40px;letter-spacing:-.5px}
  .ver{color:var(--muted);font-size:13px}
  .lede{font-size:18px;line-height:1.55;color:#c8cdf0;margin:18px auto 28px;max-width:520px}
  .install{display:inline-flex;align-items:center;gap:10px;background:var(--accent);color:#fff;font-weight:700;font-size:18px;
    padding:16px 34px;border-radius:14px;text-decoration:none;box-shadow:0 10px 30px rgba(41,79,255,.45);transition:transform .12s,box-shadow .12s}
  .install:hover{transform:translateY(-1px);box-shadow:0 14px 36px rgba(41,79,255,.6)}
  .alt{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:14px}
  .ghost{background:transparent;border:1px solid var(--line);color:var(--text);padding:10px 16px;border-radius:10px;
    font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
  .ghost:hover{border-color:var(--accent2)}
  .url{margin:18px auto 0;max-width:520px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;
    font:13px ui-monospace,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}
  .how{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:40px 0 0;text-align:left}
  @media (max-width:600px){.how{grid-template-columns:1fr}h1{font-size:34px}}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
  .tile b{display:block;font-size:15px;margin-bottom:6px}
  .tile span{color:var(--muted);font-size:14px;line-height:1.5}
  .steps{color:var(--muted);font-size:14px;line-height:1.6;margin:28px auto 0;max-width:520px}
  .note{display:inline-block;margin:16px auto 0;max-width:520px;padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;
    color:var(--muted);background:rgba(124,140,255,.08);border:1px solid var(--line)}
  footer{margin-top:36px;color:#6e75a3;font-size:13px}
  footer a{color:var(--accent2);text-decoration:none}
  footer a:hover{text-decoration:underline}
</style></head><body>
<main>
  <img class="logo" src="${escapeHtml(LOGO_URL)}" alt="">
  <h1>Discussio</h1>
  <div class="ver">Stremio addon · v${VERSION} · Hosted by ElfHosted</div>
  <p class="lede">Finished an episode? One click takes you to the thread where everyone is talking about it.</p>
  <a class="install" href="${escapeHtml(stremioUrl)}">Install in Stremio</a>
  <div class="alt">
    <a class="ghost" href="${escapeHtml(webUrl)}" target="_blank" rel="noopener">Install on Stremio Web</a>
    <button class="ghost" id="copy" type="button">Copy manifest URL</button>
  </div>
  <div class="url" id="url">${escapeHtml(httpsUrl)}</div>
  <section class="how">
    <div class="tile"><b>📺 Anime</b><span>The r/anime discussion thread for that exact episode.</span></div>
    <div class="tile"><b>🎞️ TV shows</b><span>The episode discussion in the show's own subreddit.</span></div>
    <div class="tile"><b>🎬 Movies</b><span>Letterboxd reviews, plus the r/movies official discussion.</span></div>
  </section>
  <p class="steps">After installing, open any episode or movie and look in the <b>streams</b> list for <b>Discussio</b>.</p>
  <p class="note">Installed before v1.3? Install once more to add MyAnimeList, AniList, AniDB and TMDB titles. Future updates apply automatically.</p>
  <footer>
    <a href="/stats">Stats</a> · <a href="${REPO_URL}" target="_blank" rel="noopener">GitHub</a> · <a href="https://elfhosted.com" target="_blank" rel="noopener">ElfHosted</a>
  </footer>
</main>
<script>
  document.getElementById("copy").addEventListener("click", async (e) => {
    const text = document.getElementById("url").textContent;
    try { await navigator.clipboard.writeText(text); e.target.textContent = "Copied!"; }
    catch { e.target.textContent = "Select the URL below to copy"; }
    setTimeout(() => { e.target.textContent = "Copy manifest URL"; }, 2000);
  });
</script>
</body></html>`;
}

function renderStatsHtml(stats: Stats): string {
  const dayRows = stats.by_day
    .map((d) =>
      `<tr><td>${escapeHtml(d.date)}</td><td class="num">${d.count}</td></tr>`
    )
    .join("");
  const idRows = stats.top_ids
    .map((r) => {
      const href = idUrl(r.id);
      const label = escapeHtml(r.id);
      const cell = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`
        : label;
      return `<tr><td>${cell}</td><td class="num">${r.count}</td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Discussio · Stats</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1220;color:#e8eaf6;margin:0;padding:24px;box-sizing:border-box}
  .wrap{max-width:960px;margin:0 auto}
  h1{margin:0 0 8px;font-size:28px}
  .tag{color:#9aa3d4;font-size:13px;margin-bottom:24px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
  .stat{background:#1a1f3a;padding:18px;border-radius:12px}
  .label{color:#9aa3d4;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  .value{font-size:28px;font-weight:700;color:#fff;margin-top:4px}
  .panels{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  @media (max-width:720px){.panels{grid-template-columns:1fr}}
  .panel{background:#1a1f3a;padding:20px;border-radius:12px}
  h2{margin:0 0 14px;font-size:16px;color:#fff}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{padding:8px 4px;text-align:left;border-bottom:1px solid #2c3358}
  th{color:#9aa3d4;font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  a{color:#7c8cff;text-decoration:none}
  a:hover{text-decoration:underline}
  footer{margin-top:24px;color:#6e75a3;font-size:12px}
</style></head><body>
<div class="wrap">
  <h1>Discussio Stats</h1>
  <div class="tag">v${stats.version} · started ${escapeHtml(stats.started_at)} · backend: ${stats.backend} · cache: ${stats.cache_size}</div>
  <div class="grid">
    <div class="stat"><div class="label">Total requests</div><div class="value">${stats.total.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Series</div><div class="value">${stats.series.toLocaleString()}</div></div>
    <div class="stat"><div class="label">Movies</div><div class="value">${stats.movie.toLocaleString()}</div></div>
  </div>
  <div class="panels">
    <div class="panel">
      <h2>Last 30 days</h2>
      <table><thead><tr><th>Date</th><th class="num">Requests</th></tr></thead><tbody>${dayRows || '<tr><td colspan="2" style="color:#6e75a3">No data yet</td></tr>'}</tbody></table>
    </div>
    <div class="panel">
      <h2>Top titles</h2>
      <table><thead><tr><th>Title ID</th><th class="num">Requests</th></tr></thead><tbody>${idRows || '<tr><td colspan="2" style="color:#6e75a3">No data yet</td></tr>'}</tbody></table>
    </div>
  </div>
  <footer><a href="/">Home</a> · JSON: <a href="/stats.json">/stats.json</a></footer>
</div>
</body></html>`;
}

// ===== Server =====

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", CACHE_OK);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
  });
}

const PORT = Number(Deno.env.get("PORT") ?? 7000);

Deno.serve({
  port: PORT,
  hostname: "0.0.0.0",
  onListen: ({ hostname, port }) => {
    logger.info(`Discussio v${VERSION} listening on http://${hostname}:${port}`);
  },
}, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  logger.debug(`REQ ${req.method} ${path}`);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (path === "/" || path === "/configure") {
    return htmlResponse(renderLanding(req), {
      headers: { "Cache-Control": "max-age=3600" },
    });
  }
  if (path === "/manifest.json") {
    // Never cache the manifest: Stremio keys an addon's capabilities (types,
    // idPrefixes) off it, so a stale cached copy silently drops content the
    // addon now supports. A 24h cache here previously hid the kitsu support.
    return jsonResponse(MANIFEST, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    });
  }
  if (path === "/healthz") return textResponse("ok");

  const streamMatch = path.match(/^\/stream\/(series|movie)\/([^/]+?)\.json$/);
  if (streamMatch) {
    const [, type, rawId] = streamMatch;
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return textResponse("Bad Request", 400);
    }
    const result = await withTimeout(
      handleStream(type as ContentType, id),
      HANDLER_TIMEOUT_MS,
      { streams: [], degraded: true },
    );
    return jsonResponse({ streams: result.streams }, {
      headers: { "Cache-Control": result.degraded ? CACHE_DEGRADED : CACHE_OK },
    });
  }

  if (path === "/stats.json") {
    const stats = await readStats();
    return jsonResponse(stats, {
      headers: { "Cache-Control": "no-cache, no-store" },
    });
  }
  if (path === "/stats") {
    const stats = await readStats();
    return htmlResponse(renderStatsHtml(stats));
  }

  return textResponse("Not Found", 404);
});
