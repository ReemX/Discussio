// Discussio — Stremio addon for one-click discussion links.
// Routing lives in discussio.ts; this file is the HTTP server, metadata cache
// and anonymous stats.

import { readStats, recordClick, recordView, startStats, type Stats } from "./stats.ts";
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

const VERSION = "1.4.0";
const REPO_URL = "https://github.com/ReemX/Discussio";
const LOGO_URL =
  "https://api.logo.com/api/v2/images?design=lg_aiGdQc9PParm0yrELH&width=250&height=250&fit=contain&margin_ratio=0&background=%23294fff&u=2025-02-19T10%3A24%3A54.398Z&format=png&quality=30";
const TITLE_CACHE_MAX = 5000;
const TITLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_MAX = 1000;
const META_TIMEOUT_MS = 5000;
const HANDLER_TIMEOUT_MS = 6500;
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

startStats(logger);

// ===== Stream handler =====

interface StreamResult {
  streams: Stream[];
  degraded: boolean;
}

async function resolveStreams(
  type: ContentType,
  id: string,
): Promise<StreamResult & { name?: string }> {
  const parsed = parseId(type, id);
  if (!parsed) return { streams: [], degraded: false };
  const info = await fetchMeta(parsed.scheme, type, parsed.metaId);
  // tmdb never has metadata, and that's expected rather than degraded.
  const degraded = !info && parsed.scheme in META_SOURCES;
  const streams = type === "series"
    ? seriesStreams(parsed, info)
    : movieStreams(parsed, info);
  return { streams, degraded, name: info?.title };
}

// Stream links point at /go so clicks can be counted and so a link's target
// is computed at click time — Stremio caches stream lists for a day, but
// routing improvements still reach every cached list immediately.
async function handleStream(
  type: ContentType,
  id: string,
  origin: string,
): Promise<StreamResult> {
  const { streams, degraded, name } = await resolveStreams(type, id);
  if (degraded) logger.info(`No metadata for ${id}, serving fallback`);
  // Only count ids we serve, so unroutable schemes don't pile up in stats.
  if (streams.length) recordView(type, parseId(type, id)!.metaId, name);
  return {
    degraded,
    streams: streams.map(({ venue, ...s }) => ({
      ...s,
      externalUrl: `${origin}/go/${type}/${encodeURIComponent(id)}/${venue}`,
    })) as Stream[],
  };
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

// This deployment's public origin, from the request so self-hosted instances
// advertise themselves. Proxies (ElfHosted) terminate TLS upstream.
function publicOrigin(req: Request): URL {
  const url = new URL("/", req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim();
  if (host) url.host = host;
  return url;
}

function renderLanding(req: Request): string {
  const manifest = new URL("/manifest.json", publicOrigin(req));
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

const VENUE_LABELS: Record<string, string> = {
  anime: "r/anime",
  reddit: "Reddit · show subreddits",
  movies: "r/movies",
  letterboxd: "Letterboxd",
  search: "Fallback search",
};

const fmt = (v: number) => v.toLocaleString("en-US");

// Compact axis/tile numbers: 12.3K, 4.5M.
function compact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(v >= 1e5 ? 0 : 1)}K`;
  return fmt(v);
}

// The last 30 UTC days, oldest first, zero-filled so gaps read as gaps.
function dailySeries(stats: Stats): { date: string; views: number; clicks: number }[] {
  const byDate = new Map(stats.by_day.map((d) => [d.date, d]));
  const out = [];
  const now = Date.now();
  for (let i = 29; i >= 0; i--) {
    const date = new Date(now - i * 86400000).toISOString().slice(0, 10);
    out.push(byDate.get(date) ?? { date, views: 0, clicks: 0 });
  }
  return out;
}

function dayLabel(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function barChart(
  days: { date: string; views: number; clicks: number }[],
  key: "views" | "clicks",
  label: string,
): string {
  const max = Math.max(...days.map((d) => d[key]));
  const bars = days.map((d) => {
    const v = d[key];
    const h = max ? Math.max(v ? 3 : 0, (v / max) * 100) : 0;
    const tip = `${fmt(v)} ${key}`;
    return `<div class="col" tabindex="0" data-v="${escapeHtml(tip)}" data-l="${
      escapeHtml(dayLabel(d.date))
    }" aria-label="${escapeHtml(`${dayLabel(d.date)}: ${tip}`)}"><span style="height:${
      h.toFixed(1)
    }%"></span></div>`;
  }).join("");
  return `<figure class="chart">
    <figcaption><span>${label}</span><span class="max">${max ? `peak ${compact(max)}` : ""}</span></figcaption>
    <div class="plot">${bars}</div>
  </figure>`;
}

function renderStatsHtml(stats: Stats): string {
  const days = dailySeries(stats);
  const hasDays = stats.by_day.length > 0;
  const venueMax = Math.max(1, ...stats.by_venue.map((v) => v.clicks));
  const venueRows = stats.by_venue.map((v) => {
    const share = stats.clicks ? Math.round((v.clicks / stats.clicks) * 100) : 0;
    return `<li><div class="vl"><span>${escapeHtml(VENUE_LABELS[v.venue] ?? v.venue)}</span><b>${
      fmt(v.clicks)
    }</b><em>${share}%</em></div><div class="track"><span style="width:${
      ((v.clicks / venueMax) * 100).toFixed(1)
    }%"></span></div></li>`;
  }).join("");
  const titleMax = Math.max(1, ...stats.top_titles.map((t) => t.views));
  const titleRow = (t: Stats["top_titles"][number], i: number) => {
    const href = idUrl(t.id);
    const label = escapeHtml(t.name ?? t.id);
    const name = href
      ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${label}</a>`
      : label;
    return `<li><span class="rank">${i + 1}</span><div class="tt"><div class="tn">${name}<b>${
      fmt(t.views)
    }</b></div><div class="track thin"><span style="width:${
      ((t.views / titleMax) * 100).toFixed(1)
    }%"></span></div></div></li>`;
  };
  const top = stats.top_titles.slice(0, 10).map(titleRow).join("");
  const more = stats.top_titles.slice(10).map((t, i) => titleRow(t, i + 10)).join("");
  const scope = stats.backend === "memory" ? "Since this instance started" : "All-time";
  const split = stats.by_type.series + stats.by_type.movie;
  const seriesPct = split ? Math.round((stats.by_type.series / split) * 100) : 50;
  const empty = (msg: string) => `<p class="empty">${msg}</p>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Discussio · Stats</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="${escapeHtml(LOGO_URL)}">
<style>
  :root{--bg:#0b0e1a;--card:#131830;--card2:#171d38;--line:#242b4d;--grid:#1d2342;--text:#eceefb;--muted:#9aa3d4;--faint:#6e75a3;
    --accent:#294fff;--mark:#5b7bff;--mark-hi:#8098ff}
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{margin:0;min-height:100vh;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);
    background:radial-gradient(900px 400px at 15% -10%,rgba(41,79,255,.18),transparent 60%) no-repeat,var(--bg)}
  .wrap{max-width:1120px;margin:0 auto;padding:24px 16px 28px}
  header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin-bottom:18px}
  header img{width:40px;height:40px;border-radius:11px;box-shadow:0 6px 20px rgba(41,79,255,.4)}
  h1{margin:0;font-size:22px;letter-spacing:-.2px}
  .pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
  .pill{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 10px;background:var(--card)}
  .pill.live::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:#3ddc97;margin-right:6px;vertical-align:1px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:12px}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}
  .kpi .l{color:var(--muted);font-size:12px;font-weight:500}
  .kpi .v{font-size:30px;font-weight:700;letter-spacing:-.5px;margin-top:2px;font-variant-numeric:tabular-nums}
  .kpi .h{color:var(--faint);font-size:12px;margin-top:2px}
  .split{display:flex;height:6px;border-radius:3px;overflow:hidden;gap:2px;margin-top:10px}
  .split i{background:var(--mark);border-radius:3px}
  .split i+i{background:var(--line)}
  .main{display:grid;grid-template-columns:1.6fr 1fr;gap:12px;margin-bottom:12px}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;min-width:0}
  h2{margin:0 0 12px;font-size:14px;font-weight:600;display:flex;justify-content:space-between;align-items:baseline}
  h2 small{color:var(--faint);font-weight:400;font-size:12px}
  .chart{margin:0 0 14px}
  .chart:last-of-type{margin-bottom:6px}
  figcaption{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:6px}
  figcaption .max{color:var(--faint)}
  .plot{height:92px;display:flex;align-items:flex-end;gap:2px;border-bottom:1px solid var(--line);
    background:repeating-linear-gradient(to top,transparent 0 22px,var(--grid) 22px 23px)}
  .col{flex:1;height:100%;display:flex;align-items:flex-end;cursor:default;outline:none}
  .col span{display:block;width:100%;background:var(--mark);border-radius:4px 4px 0 0;transition:background .1s}
  .col:hover span,.col:focus-visible span{background:var(--mark-hi)}
  .col:focus-visible{box-shadow:inset 0 0 0 1px var(--mark-hi);border-radius:4px}
  .axis{display:flex;justify-content:space-between;font-size:11px;color:var(--faint);margin-top:6px}
  #tip{position:fixed;pointer-events:none;background:#0b0e1a;border:1px solid var(--line);border-radius:8px;padding:6px 9px;
    font-size:12px;color:var(--muted);box-shadow:0 8px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .08s;z-index:10}
  #tip b{display:block;color:var(--text);font-size:13px}
  ul,ol{list-style:none;margin:0;padding:0}
  .venues li+li{margin-top:12px}
  .vl{display:flex;align-items:baseline;gap:8px;font-size:13px;margin-bottom:5px}
  .vl span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .vl b{font-variant-numeric:tabular-nums}
  .vl em{font-style:normal;color:var(--faint);font-size:12px;width:34px;text-align:right}
  .track{height:8px;border-radius:4px;background:var(--grid);overflow:hidden}
  .track span{display:block;height:100%;background:var(--mark);border-radius:4px}
  .track.thin{height:4px;margin-top:5px}
  .titles{display:grid;grid-template-columns:1fr 1fr;column-gap:28px;row-gap:10px}
  .titles li{display:flex;gap:10px;align-items:flex-start;min-width:0}
  .rank{width:20px;flex:none;color:var(--faint);font-size:12px;text-align:right;padding-top:2px;font-variant-numeric:tabular-nums}
  .tt{flex:1;min-width:0}
  .tn{display:flex;gap:8px;font-size:13px}
  .tn a,.tn>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .tn b{font-variant-numeric:tabular-nums;font-weight:600}
  details{margin-top:12px}
  summary{cursor:pointer;color:var(--muted);font-size:13px;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"▸ ";color:var(--faint)}
  details[open] summary::before{content:"▾ "}
  details .titles{margin-top:12px}
  .empty{color:var(--faint);font-size:13px;margin:8px 0 0}
  a{color:var(--text);text-decoration:none}
  a:hover{color:var(--mark-hi)}
  footer{margin-top:14px;color:var(--faint);font-size:12px;display:flex;gap:6px 14px;flex-wrap:wrap}
  footer a{color:var(--muted)}
  @media (max-width:860px){.kpis{grid-template-columns:1fr 1fr}.main{grid-template-columns:1fr}}
  @media (max-width:560px){.titles{grid-template-columns:1fr}.pills{margin-left:0}.kpi .v{font-size:24px}}
</style></head><body>
<div class="wrap">
  <header>
    <img src="${escapeHtml(LOGO_URL)}" alt="">
    <h1>Discussio Stats</h1>
    <div class="pills">
      <span class="pill live">${scope}</span>
      <span class="pill">v${stats.version}</span>
      <span class="pill">No personal data</span>
    </div>
  </header>

  <section class="kpis">
    <div class="kpi"><div class="l">Views</div><div class="v">${compact(stats.views)}</div><div class="h">stream lists shown</div></div>
    <div class="kpi"><div class="l">Clicks</div><div class="v">${compact(stats.clicks)}</div><div class="h">discussions opened</div></div>
    <div class="kpi"><div class="l">Click-through</div><div class="v">${stats.click_through}%</div><div class="h">clicks per view</div></div>
    <div class="kpi"><div class="l">Series · Movies</div><div class="v">${seriesPct}% · ${100 - seriesPct}%</div>
      <div class="split" aria-label="${fmt(stats.by_type.series)} series, ${fmt(stats.by_type.movie)} movie views"><i style="flex:${stats.by_type.series || 1}"></i><i style="flex:${stats.by_type.movie || 1}"></i></div></div>
  </section>

  <section class="main">
    <div class="panel">
      <h2>Daily activity <small>last 30 days · UTC</small></h2>
      ${hasDays ? barChart(days, "views", "Views") + barChart(days, "clicks", "Clicks") +
        `<div class="axis"><span>${dayLabel(days[0].date)}</span><span>${dayLabel(days[29].date)}</span></div>` : empty("No activity recorded yet.")}
    </div>
    <div class="panel">
      <h2>Clicks by destination <small>${fmt(stats.clicks)} total</small></h2>
      ${venueRows ? `<ul class="venues">${venueRows}</ul>` : empty("No clicks recorded yet.")}
    </div>
  </section>

  <section class="panel">
    <h2>Top titles <small>by views</small></h2>
    ${top ? `<ol class="titles">${top}</ol>` : empty("No titles yet.")}
    ${more ? `<details><summary>Show ${stats.top_titles.length - 10} more</summary><ol class="titles">${more}</ol></details>` : ""}
  </section>

  <footer>
    <a href="/">Home</a><a href="/stats.json">JSON</a>
    <span>Storage: ${stats.backend}</span>
    <span>Instance started ${escapeHtml(stats.started_at.slice(0, 16).replace("T", " "))} UTC</span>
    <span>Title cache ${fmt(stats.cache_size)}</span>
  </footer>
</div>
<div id="tip" role="tooltip"><b></b><span></span></div>
<script>
  const tip = document.getElementById("tip");
  const show = (el, x, y) => {
    tip.firstChild.textContent = el.dataset.v;
    tip.lastChild.textContent = el.dataset.l;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + "px";
    tip.style.top = Math.max(8, y - r.height - 12) + "px";
    tip.style.opacity = 1;
  };
  const hide = () => { tip.style.opacity = 0; };
  for (const el of document.querySelectorAll(".col")) {
    el.addEventListener("pointermove", (e) => show(el, e.clientX, e.clientY));
    el.addEventListener("pointerleave", hide);
    el.addEventListener("focus", () => { const r = el.getBoundingClientRect(); show(el, r.left + r.width / 2, r.top); });
    el.addEventListener("blur", hide);
  }
</script>
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
      handleStream(type as ContentType, id, publicOrigin(req).origin),
      HANDLER_TIMEOUT_MS,
      { streams: [], degraded: true },
    );
    return jsonResponse({ streams: result.streams }, {
      headers: { "Cache-Control": result.degraded ? CACHE_DEGRADED : CACHE_OK },
    });
  }

  const goMatch = path.match(/^\/go\/(series|movie)\/([^/]+)\/([a-z]+)$/);
  if (goMatch) {
    const [, type, rawId, venue] = goMatch;
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return textResponse("Bad Request", 400);
    }
    // The target is rebuilt server-side, never taken from the URL, so /go
    // can't be used as an open redirect.
    const { streams } = await withTimeout(
      resolveStreams(type as ContentType, id),
      HANDLER_TIMEOUT_MS,
      { streams: [], degraded: true },
    );
    const target = streams.find((s) => s.venue === venue) ?? streams[0];
    if (!target) return textResponse("Not Found", 404);
    recordClick(target.venue);
    return new Response(null, {
      status: 302,
      headers: { Location: target.externalUrl, "Cache-Control": "no-store" },
    });
  }

  const statsMeta = { version: VERSION, started_at: STARTED_AT, cache_size: metaCache.size };
  if (path === "/stats.json") {
    const stats = await readStats(statsMeta);
    return jsonResponse(stats, {
      headers: { "Cache-Control": "no-cache, no-store" },
    });
  }
  if (path === "/stats") {
    const stats = await readStats(statsMeta);
    return htmlResponse(renderStatsHtml(stats));
  }

  return textResponse("Not Found", 404);
});
