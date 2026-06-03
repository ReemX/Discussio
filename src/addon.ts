// Discussio — Stremio addon for one-click discussion search.
// Uses Cinemeta (Stremio's official metadata addon) instead of scraping IMDB.

const VERSION = "1.2.0";
const MANIFEST_URL = "https://discussio.elfhosted.com/manifest.json";
const CINEMETA_BASE = "https://v3-cinemeta.strem.io/meta";
const KITSU_BASE = "https://anime-kitsu.strem.fun/meta";

// Maps a content-id scheme to the Stremio meta addon that resolves it.
// All sources speak the same /meta/{type}/{id}.json shape and need no API key.
// Schemes absent here (e.g. "tmdb") fall back to an id-based search query.
const META_SOURCES: Record<string, string> = {
  tt: CINEMETA_BASE,
  kitsu: KITSU_BASE,
};
const TITLE_CACHE_MAX = 5000;
const TITLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_MAX = 1000;
const TOP_IDS_MEM_MAX = 2000;
const CINEMETA_TIMEOUT_MS = 5000;
const HANDLER_TIMEOUT_MS = 6500;
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
    "Opens Google search for TV show episodes and movie discussions with one click. Simply select an episode or movie to search for its discussions online.\n\nHosted by ElfHosted!",
  logo: "https://api.logo.com/api/v2/images?design=lg_aiGdQc9PParm0yrELH&width=250&height=250&fit=contain&margin_ratio=0&background=%23294fff&u=2025-02-19T10%3A24%3A54.398Z&format=png&quality=30",
  resources: ["stream"],
  types: ["series", "movie"],
  idPrefixes: ["tt", "kitsu:"],
  catalogs: [],
  behaviorHints: {
    configurable: false,
    configurationRequired: false,
  },
} as const;

interface CinemetaVideo {
  season?: number;
  episode?: number;
  number?: number;
  name?: string;
  title?: string;
  id?: string;
}

interface CinemetaMeta {
  id: string;
  name: string;
  aliases?: string[];
  genres?: string[];
  country?: string;
  year?: string;
  releaseInfo?: string;
  videos?: CinemetaVideo[];
}

interface CacheEntry {
  meta: CinemetaMeta;
  ts: number;
}

const metaCache = new Map<string, CacheEntry>();

function cacheGet(key: string): CinemetaMeta | undefined {
  const entry = metaCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > TITLE_CACHE_TTL_MS) {
    metaCache.delete(key);
    return undefined;
  }
  metaCache.delete(key);
  metaCache.set(key, entry);
  return entry.meta;
}

function cacheSet(key: string, meta: CinemetaMeta): void {
  if (metaCache.size >= TITLE_CACHE_MAX) {
    const oldest = metaCache.keys().next().value;
    if (oldest !== undefined) metaCache.delete(oldest);
  }
  metaCache.set(key, { meta, ts: Date.now() });
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

async function fetchMeta(
  scheme: string,
  type: "series" | "movie",
  metaId: string,
): Promise<CinemetaMeta | null> {
  const baseUrl = META_SOURCES[scheme];
  if (!baseUrl) {
    logger.info(`No meta source for scheme "${scheme}" (${metaId})`);
    return null;
  }
  const cacheKey = `${type}:${metaId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  if (isNegativeCached(cacheKey)) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CINEMETA_TIMEOUT_MS);
  try {
    const url = `${baseUrl}/${type}/${metaId}.json`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) {
      logger.warn(`Meta ${res.status} for ${metaId}`);
      markFailure(cacheKey);
      return null;
    }
    const data = await res.json();
    const meta: CinemetaMeta | undefined = data?.meta;
    if (!meta?.name) {
      logger.warn(`Empty meta for ${metaId}`);
      markFailure(cacheKey);
      return null;
    }
    cacheSet(cacheKey, meta);
    return meta;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      logger.warn(`Meta timeout for ${metaId}`);
    } else {
      logger.error(`Meta error for ${metaId}:`, err);
    }
    markFailure(cacheKey);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}


interface ParsedSeriesId {
  scheme: string;
  metaId: string;
  season: number;
  episode: number;
}

// Splits a Stremio series stream id into scheme + meta id + season/episode.
// Handles both colon-free schemes (tt: "tt123:1:5") and colon-prefixed ones
// (kitsu: "kitsu:46043:5", where the id itself contains a colon). Anime ids use
// absolute episode numbering with no season segment, so season defaults to 1.
function parseSeriesId(rawId: string): ParsedSeriesId | null {
  const parts = rawId.split(":");
  let scheme: string;
  let metaId: string;
  let rest: string[];
  if (/^tt\d+$/.test(parts[0])) {
    scheme = "tt";
    metaId = parts[0];
    rest = parts.slice(1);
  } else if (parts.length >= 2) {
    scheme = parts[0];
    metaId = `${parts[0]}:${parts[1]}`;
    rest = parts.slice(2);
  } else {
    return null;
  }
  if (rest.length >= 2) {
    const season = Number(rest[0]);
    const episode = Number(rest[1]);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return null;
    return { scheme, metaId, season, episode };
  }
  if (rest.length === 1) {
    const episode = Number(rest[0]);
    if (!Number.isFinite(episode)) return null;
    return { scheme, metaId, season: 1, episode };
  }
  return null;
}

function parseMovieId(
  rawId: string,
): { scheme: string; metaId: string } | null {
  const parts = rawId.split(":");
  if (/^tt\d+$/.test(parts[0])) return { scheme: "tt", metaId: parts[0] };
  if (parts.length >= 2) {
    return { scheme: parts[0], metaId: `${parts[0]}:${parts[1]}` };
  }
  return null;
}

// Picks the best title for the Google query. Cinemeta (tt) names are already
// English. Anime metas carry the native/romaji name plus an aliases list; the
// first latin-script alias is usually the official English title, which gives
// far better discussion-search results than romaji.
function pickTitle(meta: CinemetaMeta, scheme: string): string {
  if (scheme === "tt") return meta.name;
  const alias = meta.aliases?.find(
    (a) => /[a-z]/i.test(a) && a !== meta.name,
  );
  return alias ?? meta.name;
}

// Detects anime so tt-id anime (Cinemeta serves most anime under IMDB ids, not
// kitsu) gets routed to r/anime instead of being treated as a western series.
// kitsu/mal/anilist/anidb ids are anime by definition; for tt ids we use the
// reliable Cinemeta signal: Japanese-country animation.
const ANIME_SCHEMES = new Set(["kitsu", "mal", "anilist", "anidb"]);

function isAnime(meta: CinemetaMeta | null, scheme: string): boolean {
  if (ANIME_SCHEMES.has(scheme)) return true;
  if (scheme !== "tt" || !meta) return false;
  return (meta.genres?.includes("Animation") ?? false) &&
    meta.country === "Japan";
}

function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// The goal of every query is to surface the single highest-engagement Reddit
// discussion thread. Google (not Reddit's own search) ranks these well, so we
// scope the query to the subreddit where that thread lives.

// Anime episodes: r/anime hosts the largest per-episode discussion threads,
// titled "<Title> - Episode <N> discussion". Season prefix only when > 1, since
// most r/anime entries number a single cour from episode 1.
function buildAnimeEpisodeQuery(
  title: string,
  season: number,
  episode: number,
): string {
  const seasonPart = season > 1 ? `season ${season} ` : "";
  return `${title} ${seasonPart}episode ${episode} discussion site:reddit.com/r/anime`;
}

// Western series episodes live in the show's own subreddit, whose name we can't
// derive — so we let Google find it across all of Reddit. Number formats vary by
// sub (1x04 / S01E04 / "Season 1 Episode 4"), so we use natural-language
// numbering (Google normalizes it) and lean on the episode title, which is the
// unique token those threads are titled with, e.g.
//   Severance - 1x04 "The You You Are" - Episode Discussion
function buildSeriesEpisodeQuery(
  title: string,
  season: number,
  episode: number,
  episodeTitle?: string,
): string {
  const ep = episodeTitle ? ` ${episodeTitle}` : "";
  return `${title} season ${season} episode ${episode}${ep} discussion site:reddit.com`;
}

// Pulls an episode's title from the meta's videos list (Cinemeta provides it for
// western series). Used only to sharpen the Reddit query, so a miss is harmless.
function findEpisodeTitle(
  meta: CinemetaMeta,
  season: number,
  episode: number,
): string | undefined {
  const v = meta.videos?.find(
    (v) => v.season === season && (v.episode === episode || v.number === episode),
  );
  return v?.title ?? v?.name;
}

// Anime films: discussion lives in r/anime alongside everything else anime.
function buildAnimeMovieQuery(title: string, year: string | undefined): string {
  const yearSuffix = year ? ` (${year})` : "";
  return `${title}${yearSuffix} movie discussion site:reddit.com/r/anime`;
}

// Non-anime movies link straight to the film's Letterboxd page. For catalog
// films (the typical Stremio case) Letterboxd holds far more persistent
// engagement than a long-archived Reddit megathread, and it is keyless,
// first-party, and deep-linkable by either imdb or tmdb id — so no title lookup
// is needed and tmdb resolves for free.
function letterboxdFilmUrl(scheme: string, metaId: string): string | null {
  if (scheme === "tt") return `https://letterboxd.com/imdb/${metaId}/`;
  if (scheme === "tmdb") {
    const id = metaId.split(":")[1];
    if (id) return `https://letterboxd.com/tmdb/${id}/`;
  }
  return null;
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

async function recordRequest(
  type: "series" | "movie",
  imdbId: string,
): Promise<void> {
  memCounters.total++;
  memCounters[type]++;
  const d = today();
  memCounters.byDay.set(d, (memCounters.byDay.get(d) ?? 0) + 1);
  if (
    memCounters.topIds.size >= TOP_IDS_MEM_MAX &&
    !memCounters.topIds.has(imdbId)
  ) {
    const oldest = memCounters.topIds.keys().next().value;
    if (oldest !== undefined) memCounters.topIds.delete(oldest);
  }
  memCounters.topIds.set(imdbId, (memCounters.topIds.get(imdbId) ?? 0) + 1);
  if (!kv) return;
  try {
    await kv.atomic()
      .sum(["c", "total"], 1n)
      .sum(["c", "type", type], 1n)
      .sum(["c", "day", d], 1n)
      .sum(["c", "id", imdbId], 1n)
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

async function readStats(): Promise<Stats> {
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
      const days: { date: string; count: number }[] = [];
      for await (
        const entry of kv.list<Deno.KvU64>({ prefix: ["c", "day"] })
      ) {
        days.push({
          date: String(entry.key[2]),
          count: Number(entry.value.value),
        });
      }
      base.by_day = days
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 30);
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

interface Stream {
  name?: string;
  title: string;
  externalUrl: string;
  behaviorHints?: Record<string, unknown>;
}

async function handleStream(
  type: string,
  id: string,
): Promise<{ streams: Stream[] }> {
  if (type === "series") {
    const parsed = parseSeriesId(id);
    if (!parsed) {
      logger.warn("Invalid series id", { id });
      return { streams: [] };
    }
    const { scheme, metaId, season, episode } = parsed;
    const meta = await fetchMeta(scheme, "series", metaId);
    recordRequest("series", metaId).catch(() => {});
    let title: string;
    if (meta) {
      title = pickTitle(meta, scheme);
    } else {
      title = metaId;
      logger.info(`Series fallback for ${metaId} S${season}E${episode} (no meta)`);
    }
    let query: string;
    if (isAnime(meta, scheme)) {
      query = buildAnimeEpisodeQuery(title, season, episode);
    } else {
      const episodeTitle = meta
        ? findEpisodeTitle(meta, season, episode)
        : undefined;
      query = buildSeriesEpisodeQuery(title, season, episode, episodeTitle);
    }
    return {
      streams: [{
        name: "Discussio",
        title: "Search Episode Discussions",
        externalUrl: googleUrl(query),
        behaviorHints: { notWebReady: false },
      }],
    };
  }

  if (type === "movie") {
    const parsed = parseMovieId(id);
    if (!parsed) {
      logger.warn("Invalid movie id", { id });
      return { streams: [] };
    }
    const { scheme, metaId } = parsed;
    // tt is fetched only to detect anime (Cinemeta serves anime films too);
    // tmdb has no meta source and resolves to null → non-anime → Letterboxd.
    const meta = await fetchMeta(scheme, "movie", metaId);
    recordRequest("movie", metaId).catch(() => {});

    if (isAnime(meta, scheme)) {
      const title = meta ? pickTitle(meta, scheme) : metaId;
      const year = meta?.year?.match(/\d{4}/)?.[0] ??
        meta?.releaseInfo?.match(/\d{4}/)?.[0];
      return {
        streams: [{
          name: "Discussio",
          title: "Search Movie Discussions",
          externalUrl: googleUrl(buildAnimeMovieQuery(title, year)),
          behaviorHints: { notWebReady: false },
        }],
      };
    }

    // Non-anime movie → teleport straight to the Letterboxd film page.
    const letterboxd = letterboxdFilmUrl(scheme, metaId);
    if (letterboxd) {
      return {
        streams: [{
          name: "Discussio",
          title: "Movie Discussion · Letterboxd",
          externalUrl: letterboxd,
          behaviorHints: { notWebReady: false },
        }],
      };
    }

    // Unknown scheme with no Letterboxd id — last-resort id search.
    logger.info(`Movie fallback for ${metaId} (no Letterboxd id)`);
    return {
      streams: [{
        name: "Discussio",
        title: "Search Movie Discussions",
        externalUrl: googleUrl(`${metaId} movie discussion`),
        behaviorHints: { notWebReady: false },
      }],
    };
  }

  return { streams: [] };
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

function renderLanding(): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Discussio</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0f1220;color:#e8eaf6;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
  .card{max-width:560px;background:#1a1f3a;padding:32px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
  h1{margin:0 0 8px;font-size:28px;color:#fff}
  .tag{color:#9aa3d4;font-size:14px;margin-bottom:24px}
  p{line-height:1.6;color:#c0c6e8}
  a{color:#7c8cff;text-decoration:none;font-weight:600}
  a:hover{text-decoration:underline}
  .row{display:flex;gap:12px;margin-top:20px;flex-wrap:wrap}
  .btn{background:#294fff;color:#fff;padding:10px 18px;border-radius:8px;display:inline-block}
  .ghost{background:transparent;border:1px solid #2c3358;color:#c0c6e8}
  code{background:#0f1220;padding:2px 6px;border-radius:4px;font-size:13px}
</style></head><body>
<div class="card">
  <h1>Discussio</h1>
  <div class="tag">Stremio addon · v${VERSION} · Hosted by ElfHosted</div>
  <p>Opens Google search for TV episode and movie discussions with one click. Install via Stremio: <code>${MANIFEST_URL}</code></p>
  <div class="row">
    <a class="btn" href="/manifest.json">Manifest</a>
    <a class="btn ghost" href="/stats">Stats</a>
  </div>
</div>
</body></html>`;
}

function renderStatsHtml(stats: Stats): string {
  const dayRows = stats.by_day
    .map((d) =>
      `<tr><td>${escapeHtml(d.date)}</td><td class="num">${d.count}</td></tr>`
    )
    .join("");
  const idRows = stats.top_ids
    .map((r) =>
      `<tr><td><a href="https://www.imdb.com/title/${
        escapeHtml(r.id)
      }/" target="_blank" rel="noopener">${
        escapeHtml(r.id)
      }</a></td><td class="num">${r.count}</td></tr>`
    )
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
      <table><thead><tr><th>IMDB ID</th><th class="num">Requests</th></tr></thead><tbody>${idRows || '<tr><td colspan="2" style="color:#6e75a3">No data yet</td></tr>'}</tbody></table>
    </div>
  </div>
  <footer>JSON: <a href="/stats.json">/stats.json</a></footer>
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
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "max-age=86400, public");
  }
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(body), { ...init, headers });
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(body, { ...init, headers });
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

  if (path === "/") return htmlResponse(renderLanding());
  if (path === "/manifest.json") {
    // Never cache the manifest: Stremio keys an addon's capabilities (types,
    // idPrefixes) off it, so a stale cached copy silently drops content the
    // addon now supports. A 24h cache here previously hid the kitsu support.
    return jsonResponse(MANIFEST, {
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    });
  }
  if (path === "/healthz") {
    return new Response("ok", {
      headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
    });
  }

  const streamMatch = path.match(/^\/stream\/(series|movie)\/([^/]+?)\.json$/);
  if (streamMatch) {
    const [, type, rawId] = streamMatch;
    const id = decodeURIComponent(rawId);
    const result = await withTimeout(
      handleStream(type, id),
      HANDLER_TIMEOUT_MS,
      { streams: [] },
    );
    return jsonResponse(result);
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

  return new Response("Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain", ...CORS_HEADERS },
  });
});
