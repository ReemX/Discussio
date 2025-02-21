# Discussio - Stremio Discussion Finder

A simple yet powerful Stremio addon that helps you find discussions with one click. Whether you're watching a TV show episode or a movie, simply click the addon to open a Google search for relevant discussions.

![Stremio Badge](https://img.shields.io/badge/Stremio-Addon-red.svg)
![Version](https://img.shields.io/badge/version-1.0.3-blue.svg)

## 🚀 Features

- One-click access to discussions for both TV shows and movies
- Works with any TV series or movie on Stremio
- Automatically fetches correct titles and years from IMDB
- Specialized search queries for optimal results
- Fast and lightweight
- No configuration needed

## 📦 Installation

### Method 1: Install from Stremio Addon Repository

1. Open Stremio
2. Click the puzzle piece icon (addons)
3. Click 'Community Addons'
4. Search for "Discussio"
5. Click 'Install'

### Method 2: Local Development Setup

```bash
# Clone the repository
git clone https://github.com/yourusername/discussio.git
# Navigate to the directory
cd discussio
# Install dependencies
deno install
# Run the addon
deno run --allow-net main.ts
# Once running, add to Stremio:
# 1. Open Stremio
# 2. Go to the addons section
# 3. Add addon URL: http://127.0.0.1:11470/manifest.json
```

## 🎯 How to Use

### For TV Shows:

1. Open any TV series in Stremio
2. Select a season and episode you want to discuss
3. Look for the "Streams" button (usually shows a number of available streams)
4. Click the "Streams" button to see available streaming options
5. In the streams list, you'll find "Search Episode Discussions"
6. Click it to open Google search results for discussions about that episode

For example:

- Open "Breaking Bad"
- Go to Season 1, Episode 1
- Click the "Streams" button
- Find "Search Episode Discussions" in the list
- Click to find discussions about Breaking Bad S01E01

### For Movies:

1. Open any movie in Stremio
2. Click the "Streams" button
3. Find "Search Movie Discussions" in the list
4. Click to find discussions about the movie

The search will automatically include:

- The movie's release year (when available)
- Results from popular discussion platforms like Reddit and Letterboxd
- Relevant movie discussion forums

## 🔍 Can't Find the Addon?

If you've installed the addon but can't find it:

1. Make sure you're looking at either a TV series episode or a movie
2. For TV shows, make sure you're in a specific episode
3. Click the "Streams" button (the same place where you'd find streaming sources)
4. Scroll through the list of streams - "Search Episode Discussions" or "Search Movie Discussions" should be there
5. If it's not showing up, try:
   - Checking if the addon is properly installed in your addons list
   - Restarting Stremio
   - Try searching manually with the same title

## 🛠️ Technical Details

- Built with Deno and TypeScript
- Uses Stremio Addon SDK
- Implements caching for better performance
- Runs on port 11470 by default
- Intelligent search query construction for different content types

## ⚙️ Configuration

No configuration is needed! The addon works out of the box.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 💌 Contact

If you have any questions or suggestions, please open an issue on GitHub.

---

Made with ❤️ for the Stremio community.
