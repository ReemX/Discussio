import {
  addonBuilder,
  serveHTTP,
  Stream,
  StreamHandlerArgs,
} from "npm:stremio-addon-sdk";

// Cache for show names to improve performance
const showNameCache = new Map<string, string>();

const builder = new addonBuilder({
  id: "com.discussio",
  version: "1.0.0",
  name: "Discussio",
  description:
    "Opens Google search for TV show episode discussions with one click. Simply select an episode to search for its discussions online.",
  resources: ["stream"],
  types: ["series"],
  idPrefixes: ["tt"],
  catalogs: [],
});

async function getShowName(imdbId: string): Promise<string> {
  // Check cache first
  const cachedName = showNameCache.get(imdbId);
  if (cachedName) return cachedName;

  const url = `https://www.imdb.com/title/${imdbId}/`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    clearTimeout(timeout);

    const html = await response.text();
    const titleMatch = html.match(/<title>(.*?) - IMDb<\/title>/);
    const showName =
      titleMatch?.[1]?.replace(/\s*\([^)]*\)\s*$/, "").trim() ?? imdbId;

    // Cache the result
    showNameCache.set(imdbId, showName);
    return showName;
  } catch (error) {
    console.error(`Error fetching IMDB page for ${imdbId}:`, error);
    return imdbId;
  }
}

builder.defineStreamHandler(
  async (args: StreamHandlerArgs): Promise<{ streams: Stream[] }> => {
    if (args.type !== "series") return { streams: [] };

    try {
      const match = args.id.match(/tt(\d+):(\d+):(\d+)/);
      if (!match) return { streams: [] };

      const [_, imdbId, season, episode] = match;
      const showName = await getShowName(`tt${imdbId}`);
      const query = encodeURIComponent(
        `${showName} Season ${season} Episode ${episode} discussion reviews`
      );

      return {
        streams: [
          {
            title: "Search Episode Discussions",
            externalUrl: `https://www.google.com/search?q=${query}`,
            behavior: "Open",
          },
        ],
      };
    } catch (error) {
      console.error("Error in stream handler:", error);
      return { streams: [] };
    }
  }
);

serveHTTP(builder.getInterface(), {
  port: 7000,
  cache: {
    max: 1000, // Cache up to 1000 requests
    ttl: 24 * 60 * 60, // Cache for 24 hours
  },
});
