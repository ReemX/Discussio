# Discussio - Stremio Discussion Finder

A simple yet powerful Stremio addon that helps you find discussions with one click. Whether you're watching a TV show episode or a movie, simply click the addon to open a Google search for relevant discussions.

![Stremio Badge](https://img.shields.io/badge/Stremio-Addon-red.svg)
![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)

## 🚀 Features

- One-click access to discussions for both TV shows and movies
- Works with any TV series or movie on Stremio
- Metadata sourced from **Cinemeta** (Stremio's official metadata addon) — no more broken titles
- Episode titles included in series searches for sharper results
- Specialized search queries for optimal results
- Public anonymous stats page (`/stats`) — no PII, just request counts
- Fast and lightweight, in-process LRU cache + persistent Deno KV counters
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
# Then in Stremio, add: http://127.0.0.1:7000/manifest.json
```

## 🎯 How to Use

### For TV Shows

1. Open any TV series in Stremio
2. Select a season and episode you want to discuss
3. Click the "Streams" button
4. Find "Search Episode Discussions" in the list
5. Click to open Google search results for that episode

### For Movies

1. Open any movie in Stremio
2. Click the "Streams" button
3. Click "Search Movie Discussions"

The search will automatically include:
- The movie's release year (when available)
- Results from Reddit, Letterboxd, and general film discussion forums

## 📊 Stats

Anonymous usage counters are exposed at:
- `https://discussio.elfhosted.com/stats` — human-readable page
- `https://discussio.elfhosted.com/stats.json` — machine-readable JSON

Tracked: total request count, type breakdown (series vs movie), per-day counts (last 30 days), top requested IMDB IDs (top 25). No IPs, no user agents, no identifiers.

## 🛠️ Technical Details

- Built with Deno and TypeScript
- Uses **Cinemeta** (`https://v3-cinemeta.strem.io`) for title/episode metadata
- Native `Deno.serve` HTTP server (no SDK runtime dependency)
- LRU + TTL in-memory cache (5000 entries × 24h)
- Persistent counters via Deno KV (falls back to memory if unavailable)
- Default port: `7000` (override with `PORT` env var)
- Log level via `LOG_LEVEL` env var (`0`=debug, `1`=info, `2`=warn, `3`=error)

### Endpoints

| Path | Description |
|------|-------------|
| `/` | Landing page |
| `/manifest.json` | Stremio addon manifest |
| `/stream/series/:id.json` | Stream handler for series episodes |
| `/stream/movie/:id.json` | Stream handler for movies |
| `/stats` | Public stats page |
| `/stats.json` | Public stats JSON |
| `/healthz` | Health check |

## 🔧 What Changed in 1.1.0

- **Fixed**: Titles showing as raw IMDB IDs (e.g. `tt31889371`) — IMDB changed their HTML, breaking the old scraper. Replaced with Cinemeta.
- **Fixed**: Discussio entry sometimes missing entirely — addon now always emits a stream, falling back to an IMDB-ID-based search when metadata lookup fails (rare/new titles, Cinemeta hiccups).
- **Added**: Episode titles in series search queries.
- **Added**: `/stats` and `/stats.json` endpoints.
- **Added**: Bounded LRU cache + negative cache (avoids retry storms on bad IDs).
- **Changed**: Native `Deno.serve` router replaces SDK runtime — fewer deps, more control.

## ⚙️ Configuration

No configuration is needed.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 💌 Contact

If you have any questions or suggestions, please open an issue on GitHub.

---

Made with ❤️ for the Stremio community.
