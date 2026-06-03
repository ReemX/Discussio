# Discussio - Stremio Discussion Finder

A Stremio addon that takes you to the discussion for whatever you're watching in one click. Pick an episode or a movie, and Discussio sends you straight to where people are actually talking about it — the right venue for the kind of content, not a generic web search.

![Stremio Badge](https://img.shields.io/badge/Stremio-Addon-red.svg)
![Version](https://img.shields.io/badge/version-1.2.0-blue.svg)

## 🚀 Features

- One-click discussions for anime, TV series, and movies
- **Venue-aware routing** — each content type points at where its discussion really lives:
  - **Anime** → the [r/anime](https://reddit.com/r/anime) episode/film discussion thread (the largest anime community)
  - **TV series** → the show's own subreddit episode-discussion thread (found via Google across Reddit)
  - **Movies** → the film's [Letterboxd](https://letterboxd.com) page — straight to thousands of persistent reviews & comments, no search hop
- **First-class anime support** — works with both Kitsu ids (`kitsu:`) and anime that Stremio serves under IMDB ids, which are auto-detected and routed to r/anime
- Titles resolved from **Cinemeta** (live-action / IMDB) and the **Kitsu** addon (anime) — English titles preferred for sharper anime results
- Public anonymous stats page (`/stats`) — no PII, just request counts
- Fast and lightweight: in-process LRU + negative cache, optional persistent Deno KV counters
- No configuration needed

## 📦 Installation

### Hosted instance (recommended)

Add this URL inside Stremio → Addons → "Add addon":

```
https://discussio.elfhosted.com/manifest.json
```

Hosted free of charge by [ElfHosted](https://elfhosted.com).

### Local development

```bash
git clone https://github.com/yourusername/discussio.git
cd discussio
deno task dev
# Then in Stremio (desktop app), add: http://127.0.0.1:7000/manifest.json
```

> Use the Stremio **desktop** app for local testing — the web app is served over
> HTTPS and blocks `http://localhost` addons (mixed content).

## 🎯 How to Use

### Anime

1. Open any anime in Stremio and pick an episode (or open an anime film)
2. Open the **Streams** list
3. Click **Search Episode Discussions** → lands on the r/anime discussion thread

Works whether the anime is provided under a Kitsu id or an IMDB id — Discussio
detects anime either way.

### TV Shows

1. Open a series, select a season and episode
2. Open the **Streams** list → **Search Episode Discussions**
3. Opens a Reddit search tuned to the show's own episode-discussion thread
   (uses season/episode plus the episode title, which is how those threads are titled)

### Movies

1. Open a movie → open the **Streams** list
2. Click **Movie Discussion · Letterboxd**
3. Teleports directly to the film's Letterboxd page (reviews + comments)

## 🧠 How routing works

| Content | Destination | Method |
|---|---|---|
| Anime episode / film | r/anime thread | Google scoped to `site:reddit.com/r/anime` |
| TV series episode | show's subreddit thread | Google scoped to `site:reddit.com` |
| Movie | Letterboxd film page | direct deep-link, no search |

**Anime detection:** ids prefixed `kitsu:` / `mal:` / `anilist:` / `anidb:` are
anime by definition. IMDB-id content is treated as anime when its Cinemeta
metadata is animation *and* originates from Japan — so Japanese anime served
under `tt` ids reaches r/anime, while Western animation does not.

**Movies → Letterboxd:** for catalog films, Letterboxd holds far more persistent
engagement than a long-archived Reddit megathread, and it is deep-linkable by
both IMDB id (`/imdb/{tt}/`) and TMDB id (`/tmdb/{id}/`) — keyless and
first-party — so movies need no title lookup at all and TMDB ids resolve for free.

## 📊 Stats

Anonymous usage counters are exposed at:
- `https://discussio.elfhosted.com/stats` — human-readable page
- `https://discussio.elfhosted.com/stats.json` — machine-readable JSON

Tracked: total request count, type breakdown (series vs movie), per-day counts
(last 30 days), and top requested title ids (top 25). No IPs, no user agents,
no identifiers.

## 🛠️ Technical Details

- Built with Deno and TypeScript
- **Metadata registry** maps each id scheme to its meta source, all keyless:
  - `tt` → **Cinemeta** (`https://v3-cinemeta.strem.io`)
  - `kitsu` → **Kitsu** addon (`https://anime-kitsu.strem.fun`)
  - `tmdb` movies → **Letterboxd** id deep-link (no meta fetch needed)
- Native `Deno.serve` HTTP server (no SDK runtime dependency)
- LRU + TTL in-memory cache (5000 entries × 24h) + short negative cache
- Persistent counters via Deno KV when available (run with `--unstable-kv`),
  falls back to in-memory
- The manifest is served `no-cache` so capability changes (types / `idPrefixes`)
  are never hidden behind a stale cached copy in Stremio
- `idPrefixes`: `tt`, `kitsu:`
- Default port: `7000` (override with `PORT` env var)
- Log level via `LOG_LEVEL` env var (`0`=debug, `1`=info, `2`=warn, `3`=error)

### Endpoints

| Path | Description |
|------|-------------|
| `/` | Landing page |
| `/manifest.json` | Stremio addon manifest |
| `/stream/series/:id.json` | Stream handler for series / anime episodes |
| `/stream/movie/:id.json` | Stream handler for movies / anime films |
| `/stats` | Public stats page |
| `/stats.json` | Public stats JSON |
| `/healthz` | Health check |

## 🔧 What Changed in 1.2.0

- **Added**: anime support. Anime never reached the addon before because the
  manifest only claimed IMDB (`tt`) ids; it now also claims `kitsu:` ids and
  resolves anime titles via the Kitsu addon.
- **Added**: anime auto-detection for anime served under IMDB ids (Japanese
  animation), routing it to r/anime instead of treating it as a Western series.
- **Changed**: discussion routing is now venue-aware — anime → r/anime, TV →
  the show's subreddit, movies → Letterboxd — replacing the single generic
  Google search.
- **Changed**: movies teleport straight to their Letterboxd film page (IMDB or
  TMDB id), with no title lookup; TMDB ids resolve for free.
- **Changed**: series queries use natural-language numbering plus the episode
  title to better match how subreddit threads are titled.
- **Fixed**: the manifest is now served `no-cache`. A previous 24h cache header
  caused Stremio to keep an addon's old capabilities, silently dropping newly
  supported content (this is what hid anime support).

## ⚙️ Configuration

No configuration is needed.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 💌 Contact

If you have any questions or suggestions, please open an issue on GitHub.

---

Made with ❤️ for the Stremio community.
