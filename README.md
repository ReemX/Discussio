# Discussio - Stremio Episode Discussion Finder

A simple yet powerful Stremio addon that helps you find episode discussions with one click. When watching a TV show, simply click the addon to open a Google search for discussions about the current episode.

![Stremio Badge](https://img.shields.io/badge/Stremio-Addon-red.svg)
![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)

## 🚀 Features

- One-click access to episode discussions
- Works with any TV series on Stremio
- Automatically fetches correct show names from IMDB
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

1. Install the addon
2. Open any TV series in Stremio
3. Select a season and episode you want to discuss
4. Look for the "Streams" button (usually shows a number of available streams)
5. Click the "Streams" button to see available streaming options
6. In the streams list, you'll find "Search Episode Discussions"
7. Click it to open Google search results for discussions about that episode

For example:
- Open "Breaking Bad"
- Go to Season 1, Episode 1
- Click the "Streams" button
- Find "Search Episode Discussions" in the list
- Click to find discussions about Breaking Bad S01E01

## 🔍 Can't Find the Addon?

If you've installed the addon but can't find it:
1. Make sure you're looking at a TV series (the addon doesn't work with movies)
2. Go into a specific episode
3. Click the "Streams" button (the same place where you'd find streaming sources)
4. Scroll through the list of streams - "Search Episode Discussions" should be there
5. If it's not showing up, try:
   - Checking if the addon is properly installed in your addons list
   - Restarting Stremio
   - Try searching manually with the same show name and episode

## 🛠️ Technical Details

- Built with Deno and TypeScript
- Uses Stremio Addon SDK
- Implements caching for better performance
- Runs on port 11470 by default

## ⚙️ Configuration

No configuration is needed! The addon works out of the box.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 💌 Contact

If you have any questions or suggestions, please open an issue on GitHub.

---

Made with ❤️ for the Stremio community.