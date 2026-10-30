// Discussio routing: turns a Stremio content id plus its metadata into links to
// where that title is actually discussed. Pure functions only — no I/O — so the
// whole routing surface is unit-testable (see discussio_test.ts).

export const CINEMETA_BASE = "https://v3-cinemeta.strem.io/meta";
export const KITSU_BASE = "https://anime-kitsu.strem.fun/meta";

// Maps a content-id scheme to the Stremio meta addon that resolves it. All
// sources speak the same /meta/{type}/{id}.json shape and need no API key. The
// Kitsu addon also resolves mal/anilist/anidb ids. Schemes absent here (tmdb)
// have no keyless title source.
export const META_SOURCES: Record<string, string> = {
  tt: CINEMETA_BASE,
  kitsu: KITSU_BASE,
  mal: KITSU_BASE,
  anilist: KITSU_BASE,
  anidb: KITSU_BASE,
};

const ANIME_SCHEMES = new Set(["kitsu", "mal", "anilist", "anidb"]);

export type ContentType = "series" | "movie";

// The subset of a Stremio meta response we read.
export interface RawMeta {
  name?: string;
  aliases?: string[];
  genres?: string[];
  country?: string;
  year?: string;
  releaseInfo?: string;
  imdb_id?: string;
  videos?: {
    season?: number;
    episode?: number;
    number?: number;
    name?: string;
    title?: string;
  }[];
}

// What we keep per title. Raw metas can be huge (One Piece is ~1.4 MB on
// Cinemeta), so only the fields routing needs are cached.
export interface TitleInfo {
  title: string;
  anime: boolean;
  year?: string;
  imdbId?: string;
  // [season, episode, episode title] for every numbered episode.
  episodes: [number, number, string | undefined][];
}

export interface ParsedId {
  scheme: string;
  metaId: string;
  season?: number;
  episode?: number;
}

// Where a link leads; used to attribute clicks.
export type Venue = "anime" | "reddit" | "movies" | "letterboxd" | "search";

export interface Stream {
  venue: Venue;
  name: string;
  title: string; // deprecated by Stremio in favor of description; kept for old clients
  description: string;
  externalUrl: string;
}

// Splits a Stremio stream id into scheme + meta id (+ season/episode for
// series). Handles colon-free schemes ("tt123:1:5") and colon-prefixed ones
// ("kitsu:46043:5", where the id itself contains a colon). Anime ids use
// per-entry episode numbering with no season segment, so season defaults to 1.
export function parseId(type: ContentType, rawId: string): ParsedId | null {
  const parts = rawId.split(":");
  let scheme: string;
  let metaId: string;
  let rest: string[];
  if (/^tt\d+$/.test(parts[0])) {
    scheme = "tt";
    metaId = parts[0];
    rest = parts.slice(1);
  } else if (parts.length >= 2 && /^[a-z]+$/.test(parts[0]) && parts[1]) {
    scheme = parts[0];
    metaId = `${parts[0]}:${parts[1]}`;
    rest = parts.slice(2);
  } else {
    return null;
  }
  if (type === "movie") return { scheme, metaId };
  const nums = rest.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (nums.length >= 2) return { scheme, metaId, season: nums[0], episode: nums[1] };
  if (nums.length === 1) return { scheme, metaId, season: 1, episode: nums[0] };
  return null;
}

export function toTitleInfo(meta: RawMeta, scheme: string): TitleInfo | null {
  if (!meta.name) return null;
  const episodes: TitleInfo["episodes"] = [];
  for (const v of meta.videos ?? []) {
    const episode = v.episode ?? v.number;
    if (typeof v.season !== "number" || typeof episode !== "number") continue;
    episodes.push([v.season, episode, v.title ?? v.name]);
  }
  const yearMatch = (meta.year ?? meta.releaseInfo)?.match(/\d{4}/);
  return {
    title: pickTitle(meta, scheme),
    anime: isAnime(meta, scheme),
    year: yearMatch?.[0],
    imdbId: /^tt\d+$/.test(meta.imdb_id ?? "") ? meta.imdb_id : undefined,
    episodes,
  };
}

// Cinemeta (tt) names are already English. Kitsu names are the canonical
// title, often romaji; its first alias is the English title when one exists,
// which Google matches far better for English-speaking communities.
function pickTitle(meta: RawMeta, scheme: string): string {
  if (scheme === "tt") return meta.name!;
  return meta.aliases?.find((a) => /[a-z]/i.test(a)) ?? meta.name!;
}

// kitsu/mal/anilist/anidb ids are anime by definition. Cinemeta serves most
// anime under IMDB ids, where the reliable signal is Japanese animation.
function isAnime(meta: RawMeta, scheme: string): boolean {
  if (ANIME_SCHEMES.has(scheme)) return true;
  return scheme === "tt" && (meta.genres?.includes("Animation") ?? false) &&
    (meta.country?.includes("Japan") ?? false);
}

// Kitsu lists each season as its own entry ("Frieren: Beyond Journey's End
// Season 2", "Sousou no Frieren 2nd Season") with episodes numbered from 1.
// r/anime titles those threads "<Title> Season 2 - Episode 3 discussion", so
// the season is lifted out of the name to build that exact phrase.
export function splitSeason(title: string): { title: string; season?: number } {
  const m = title.match(
    /[\s:,-]+(?:(\d+)(?:st|nd|rd|th) Season|Season (\d+))\s*$/i,
  );
  if (!m) return { title };
  return { title: title.slice(0, m.index), season: Number(m[1] ?? m[2]) };
}

// Episode placeholders ("Episode 5", "Episode #1.5", "TBA") add noise to a
// query instead of the unique token a real episode title provides.
function isGenericEpisodeTitle(t: string): boolean {
  return /^(?:episode|ep\.?)\s*#?[\d.]+$|^tba$/i.test(t.trim());
}

// Looks up an episode's title and its absolute number across all regular
// seasons (season 0 holds specials). Long-running anime like One Piece are
// split into seasons on Cinemeta but numbered absolutely on r/anime.
export function findEpisode(
  info: TitleInfo,
  season: number,
  episode: number,
): { title?: string; absolute?: number } {
  const hit = info.episodes.find(([s, e]) => s === season && e === episode);
  if (!hit) return {};
  const title = hit[2] && !isGenericEpisodeTitle(hit[2]) ? hit[2] : undefined;
  if (season === 0) return { title };
  const absolute = info.episodes.filter(([s, e]) =>
    s > 0 && (s < season || (s === season && e <= episode))
  ).length;
  return { title, absolute };
}

export function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// Letterboxd deep-links films by imdb or tmdb id — no title lookup needed.
export function letterboxdUrl(imdbId?: string, tmdbId?: string): string | null {
  if (imdbId) return `https://letterboxd.com/imdb/${imdbId}/`;
  if (tmdbId) return `https://letterboxd.com/tmdb/${tmdbId}/`;
  return null;
}

// r/anime's discussion bot titles every thread "<Title> - Episode N
// discussion" (with "Season N - " for later seasons), so the query quotes that
// exact phrase. When the absolute number differs (multi-season shows), both
// forms are OR-ed: r/anime uses per-season numbering for cour-based shows
// (Frieren) and absolute numbering for long-runners (One Piece).
export function animeEpisodeQuery(
  title: string,
  season: number,
  episode: number,
  absolute?: number,
  episodeTitle?: string,
): string {
  if (season === 0) {
    return `${title} ${episodeTitle ?? "special"} discussion site:reddit.com/r/anime`;
  }
  const phrases = [
    season > 1
      ? `"Season ${season} - Episode ${episode} discussion"`
      : `"Episode ${episode} discussion"`,
  ];
  if (absolute && absolute !== episode) {
    phrases.push(`"Episode ${absolute} discussion"`);
  }
  const p = phrases.length > 1 ? `(${phrases.join(" OR ")})` : phrases[0];
  return `${title} ${p} site:reddit.com/r/anime`;
}

// Western shows are discussed in their own subreddit, whose name we can't
// derive, so Google searches all of Reddit. Number formats vary by sub (1x04 /
// S01E04 / "Season 1 Episode 4"); natural-language numbering plus the episode
// title — the unique token those threads carry — finds them reliably.
export function seriesEpisodeQuery(
  title: string,
  season: number,
  episode: number,
  episodeTitle?: string,
): string {
  if (season === 0) {
    return `${title} ${episodeTitle ?? "special"} discussion site:reddit.com`;
  }
  const ep = episodeTitle ? ` ${episodeTitle}` : "";
  return `${title} season ${season} episode ${episode}${ep} discussion site:reddit.com`;
}

function stream(venue: Venue, description: string, externalUrl: string): Stream {
  return { venue, name: "Discussio", title: description, description, externalUrl };
}

export function seriesStreams(parsed: ParsedId, info: TitleInfo | null): Stream[] {
  let season = parsed.season ?? 1;
  const episode = parsed.episode ?? 1;
  if (!info) {
    // Schemes without a title source (tmdb, anything unknown — the manifest
    // claims every id) would only yield a useless bare-id query.
    if (!(parsed.scheme in META_SOURCES)) return [];
    const label = `S${season}E${episode}`;
    return [stream(
      "search",
      `💬 Search episode discussions\n${label}`,
      googleUrl(`${parsed.metaId} season ${season} episode ${episode} discussion`),
    )];
  }
  const ep = findEpisode(info, season, episode);
  let title = info.title;
  if (info.anime && parsed.scheme !== "tt") {
    const split = splitSeason(title);
    title = split.title;
    if (split.season && season === 1) season = split.season;
  }
  if (info.anime) {
    const label = season > 1 ? `Season ${season} · Episode ${episode}` : `Episode ${episode}`;
    // Kitsu entries already number episodes per entry; only Cinemeta's season
    // split needs the absolute alternative.
    const absolute = parsed.scheme === "tt" ? ep.absolute : undefined;
    return [stream(
      "anime",
      `💬 r/anime · Episode discussion\n${title} · ${label}`,
      googleUrl(animeEpisodeQuery(title, season, episode, absolute, ep.title)),
    )];
  }
  const epTitle = ep.title ? ` · ${ep.title}` : "";
  return [stream(
    "reddit",
    `💬 Reddit · Episode discussion\n${title} · S${season}E${episode}${epTitle}`,
    googleUrl(seriesEpisodeQuery(title, season, episode, ep.title)),
  )];
}

// Movies: Letterboxd holds the most persistent engagement for catalog films and
// deep-links by id, so it leads. Reddit follows for recent releases, which get
// an r/movies "Official Discussion" (or an r/anime thread for anime films).
export function movieStreams(parsed: ParsedId, info: TitleInfo | null): Stream[] {
  const imdbId = parsed.scheme === "tt" ? parsed.metaId : info?.imdbId;
  const tmdbId = parsed.scheme === "tmdb" ? parsed.metaId.split(":")[1] : undefined;
  const lb = letterboxdUrl(imdbId, tmdbId);
  const out: Stream[] = [];
  const heading = info ? `\n${info.title}${info.year ? ` (${info.year})` : ""}` : "";
  if (lb) out.push(stream("letterboxd", `🎬 Letterboxd · Reviews & discussion${heading}`, lb));
  if (info) {
    const year = info.year ? ` (${info.year})` : "";
    const reddit = info.anime
      ? stream(
        "anime",
        `💬 r/anime · Movie discussion${heading}`,
        googleUrl(`${info.title}${year} movie discussion site:reddit.com/r/anime`),
      )
      : stream(
        "movies",
        `💬 r/movies · Official discussion${heading}`,
        googleUrl(`${info.title}${year} official discussion site:reddit.com/r/movies`),
      );
    // Anime films are discussed most on r/anime, so it goes first for them.
    if (info.anime) out.unshift(reddit);
    else out.push(reddit);
  }
  if (!out.length && parsed.scheme in META_SOURCES) {
    out.push(stream(
      "search",
      "💬 Search movie discussions",
      googleUrl(`${parsed.metaId} movie discussion`),
    ));
  }
  return out;
}
