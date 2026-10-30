# Discussio - Stremio Discussion Finder

A Stremio addon that takes you to the discussion for whatever you're watching in one click. Pick an episode or a movie, and Discussio sends you straight to where people are actually talking about it — the right venue for the kind of content, not a generic web search.

![Stremio Badge](https://img.shields.io/badge/Stremio-Addon-red.svg)
![Version](https://img.shields.io/badge/version-1.4.0-blue.svg)

## 🚀 Features

- One-click discussions for anime, TV series, and movies
- **Venue-aware routing** — each content type points at where its discussion really lives:
  - **Anime** → the exact [r/anime](https://reddit.com/r/anime) episode discussion thread
  - **TV series** → the show's own subreddit episode-discussion thread
  - **Movies** → the film's [Letterboxd](https://letterboxd.com) page, plus the r/movies official discussion
- **Precise anime matching** — queries quote r/anime's thread title format (`Season 2 - Episode 3 discussion`), and long-running shows split into seasons (One Piece) also match by absolute episode number
- **Every anime id** — Kitsu, MyAnimeList, AniList and AniDB ids, plus anime served under IMDB ids (auto-detected)
- **TMDB movies** deep-link straight to Letterboxd
- Install page with one-click install (`stremio://`), Stremio Web install and copy-URL
- Public anonymous stats page (`/stats`) — views, clicks, click-through per destination, top titles; no PII
- No configuration needed

## 📦 Installation

### Hosted instance (recommended)

Open **https://discussio.elfhosted.com** and click **Install in Stremio**, or add this URL inside Stremio → Addons → "Add addon":

```
https://discussio.elfhosted.com/manifest.json
```

Hosted free of charge by [ElfHosted](https://elfhosted.com).

### Local development

```bash
git clone https://github.com/ReemX/Discussio.git
cd Discussio
deno task dev
# Then in Stremio (desktop app), add: http://127.0.0.1:7000/manifest.json
```

> Use the Stremio **desktop** app for local testing — the web app is served over
> HTTPS and blocks `http://localhost` addons (mixed content).

| Task | What it does |
|---|---|
| `deno task dev` | Run with file watching |
| `deno task start` | Run for production |
| `deno task test` | Unit tests for id parsing and routing |
| `deno task check` | Type-check, lint and test (what CI runs) |

## 🎯 How to Use

Open any episode or movie, open the **Streams** list, and pick a **Discussio** entry:

| Content | Streams |
|---|---|
| Anime episode | 💬 r/anime · Episode discussion |
| TV episode | 💬 Reddit · Episode discussion |
| Movie | 🎬 Letterboxd · Reviews & discussion, 💬 r/movies · Official discussion |
| Anime film | 💬 r/anime · Movie discussion, 🎬 Letterboxd · Reviews & discussion |

## 🧠 How routing works

| Content | Destination | Method |
|---|---|---|
| Anime episode / film | r/anime thread | Google, quoted thread-title phrase, scoped to `site:reddit.com/r/anime` |
| TV series episode | show's subreddit thread | Google with season/episode + episode title, scoped to `site:reddit.com` |
| Movie | Letterboxd film page | direct deep-link by IMDB or TMDB id |
| Movie | r/movies official discussion | Google scoped to `site:reddit.com/r/movies` |

**Why Google search pages, not a direct jump?** Google's "I'm Feeling Lucky"
(`btnI`) now stops on a *Redirect Notice* page — the same one click as the
results page, but without a fallback when the top hit is wrong. Reddit's own
search ranks discussion threads far worse, and Reddit blocks keyless server-side
lookups, so a precise Google query is the most reliable path.

**Anime detection:** ids prefixed `kitsu:` / `mal:` / `anilist:` / `anidb:` are
anime by definition. IMDB-id content is treated as anime when its Cinemeta
metadata is animation *and* the country includes Japan.

**Anime titles:** Kitsu's English alias is preferred over the romaji name, and
per-season Kitsu entries ("Sousou no Frieren 2nd Season") are mapped to
r/anime's `Season 2 - Episode N` phrasing.

## 📊 Stats

Anonymous usage counters are exposed at:
- `https://discussio.elfhosted.com/stats` — human-readable page
- `https://discussio.elfhosted.com/stats.json` — machine-readable JSON

Tracked: **views** (a Discussio stream list was shown), **clicks** (a
discussion link was opened), click-through, clicks per destination, per-day
counts (last 30 days) and the top 25 titles. No IPs, no user agents, no
identifiers. Stats are cached for 60 seconds.

Clicks are counted because stream links point at `/go/...`, which redirects to
the destination. The target is rebuilt server-side (never read from the URL, so
it can't be used as an open redirect), which also means routing improvements
reach stream lists Stremio has already cached.

### Persistence

Stats are kept in memory and persisted one of two ways:

| Backend | When | How |
|---|---|---|
| **Upstash Redis** | `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set | Counts are flushed once a minute as a single `EVAL` (~45K commands / ~0.5 GB a month, well inside the free tier). Upstash is the only source of truth. |
| **GitHub snapshot** | default, needs no secrets | The [Stats snapshot](.github/workflows/stats-snapshot.yml) Action reads `/stats/raw.json` every 15 minutes and merges it into `stats.json` on the `stats-data` branch using only the built-in `GITHUB_TOKEN`. The server reads that public file back for all-time totals. At most ~15 minutes of counts are lost per restart. |

The `stats-data` branch is force-pushed as a single commit, so it never grows,
and it's separate from `main`, so snapshots never trigger a deploy. Set
`STATS_SNAPSHOT_URL` to read the snapshot from elsewhere (e.g. a fork).

## 🛠️ Technical Details

- Built with Deno and TypeScript, native `Deno.serve` (no SDK runtime dependency)
- `src/discussio.ts` — pure routing logic (id parsing, title picking, queries, streams), unit-tested in `src/discussio_test.ts`
- `src/addon.ts` — HTTP server, metadata cache, HTML pages
- `src/stats.ts` — counters and the Upstash / GitHub-snapshot persistence; `src/snapshot.ts` holds the snapshot merge logic (unit-tested), run by `scripts/snapshot.ts`
- **Metadata sources**, all keyless:
  - `tt` → **Cinemeta** (`https://v3-cinemeta.strem.io`)
  - `kitsu` / `mal` / `anilist` / `anidb` → **Kitsu** addon (`https://anime-kitsu.strem.fun`)
  - `tmdb` movies → **Letterboxd** id deep-link (no meta fetch needed)
- Compact LRU + TTL cache (5000 titles × 24h; only the fields routing needs are kept) + short negative cache + in-flight request de-duplication
- Responses are cached 24h; fallback responses (metadata unavailable) only 5 minutes
- The manifest claims no `idPrefixes`, so Stremio offers every series/movie id and unroutable ids get an empty answer. Stremio never refreshes an installed manifest, so this lets new id schemes reach existing installs without a reinstall
- The manifest is served `no-cache` so a fresh install always gets the current copy
- Default port: `7000` (override with `PORT`), log level via `LOG_LEVEL` (`0`=debug … `3`=error)

### Endpoints

| Path | Description |
|------|-------------|
| `/` | Install page |
| `/manifest.json` | Stremio addon manifest |
| `/stream/series/:id.json` | Stream handler for series / anime episodes |
| `/stream/movie/:id.json` | Stream handler for movies / anime films |
| `/stats` | Public stats page |
| `/stats.json` | Public stats JSON |
| `/stats/raw.json` | This instance's raw counts (read by the snapshot Action) |
| `/go/:type/:id/:venue` | Counts a click and redirects to the destination |
| `/healthz` | Health check |

## 🔧 What Changed in 1.4.0

- **Added**: click tracking via `/go` redirects; the stats page shows views, clicks, click-through and clicks per destination.
- **Added**: top titles show names instead of raw ids.
- **Changed**: stats persist without secrets via a GitHub Action snapshot, or via Upstash Redis when its env vars are set. Deno KV is no longer used (production never had a persistent volume, so stats reset on every deploy).

## 🔧 What Changed in 1.3.0

- **Added**: install page with one-click Stremio install, Stremio Web install and copy-URL.
- **Added**: MyAnimeList, AniList and AniDB ids (via the Kitsu addon), and TMDB movie ids (→ Letterboxd).
- **Changed**: the manifest no longer restricts `idPrefixes`, so future id support is server-side only. **Existing users: install once more** to pick this up (Stremio keeps the manifest from install time) — it's the last reinstall needed.
- **Added**: movies get a second link to the r/movies official discussion; anime films also link to Letterboxd.
- **Improved**: anime queries quote r/anime's exact thread-title phrase, map Kitsu season entries to `Season N`, and fall back to absolute numbering for long-runners — e.g. One Piece no longer lands on another show's thread.
- **Fixed**: Kitsu titles picked the romaji name when the canonical name was already English.
- **Fixed**: whole metadata responses (up to ~1.4 MB each) were cached, risking gigabytes of memory; only routing fields are kept now.
- **Fixed**: fallback responses were cached for 24h, pinning poor links after a metadata hiccup.
- **Fixed**: stats links for non-IMDB ids, malformed ids returning 500, and `/stats` scanning all of KV on every view.
- Stream entries now use Stremio's `description` field with a venue + title line.

## 🤝 Contributing

Contributions are welcome! Run `deno task check` before opening a Pull Request.

## 💌 Contact

If you have any questions or suggestions, please open an issue on GitHub.

---

Made with ❤️ for the Stremio community.
