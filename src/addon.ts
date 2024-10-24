import {
  addonBuilder,
  serveHTTP,
  Stream,
  StreamHandlerArgs,
  publishToCentral,
} from "npm:stremio-addon-sdk";

// Global error handlers
addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled Promise Rejection:", {
    error: event.reason,
    timestamp: new Date().toISOString(),
    stack: event.reason?.stack
  });
});

addEventListener("error", (event) => {
  console.error("Uncaught Error:", {
    error: event.error,
    timestamp: new Date().toISOString(),
    stack: event.error?.stack
  });
});

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
  try {
    // Check cache first
    const cachedName = showNameCache.get(imdbId);
    if (cachedName) return cachedName;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(`https://www.imdb.com/title/${imdbId}/`, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const html = await response.text();
      const titleMatch = html.match(/<title>(.*?) - IMDb<\/title>/);
      const showName =
        titleMatch?.[1]?.replace(/\s*\([^)]*\)\s*$/, "").trim() ?? imdbId;

      showNameCache.set(imdbId, showName);
      return showName;

    } finally {
      clearTimeout(timeoutId);
    }

  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`Timeout fetching IMDB page for ${imdbId}`);
    } else {
      console.error(`Error fetching IMDB page for ${imdbId}:`, {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString()
      });
    }
    return imdbId;
  }
}

builder.defineStreamHandler(
  async (args: StreamHandlerArgs): Promise<{ streams: Stream[] }> => {
    try {
      if (args.type !== "series") {
        console.log("Non-series request rejected", { type: args.type });
        return { streams: [] };
      }

      const match = args.id.match(/tt(\d+):(\d+):(\d+)/);
      if (!match) {
        console.log("Invalid ID format rejected", { id: args.id });
        return { streams: [] };
      }

      const [_, imdbId, season, episode] = match;

      // Add timeout for the entire handler
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Handler timeout')), 8000);
      });

      const handlerPromise = (async () => {
        const showName = await getShowName(`tt${imdbId}`);
        const query = encodeURIComponent(
          `${showName} Season ${season} Episode ${episode} discussion`
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
      })();

      // Race between timeout and handler
      return await Promise.race([handlerPromise, timeoutPromise]);

    } catch (error) {
      console.error("Stream handler error:", {
        error: error.message,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        args: JSON.stringify(args)
      });
      return { streams: [] };
    }
  }
);

// Wrap server startup in error handling
try {
  serveHTTP(builder.getInterface(), {
    port: Deno.env.get("PORT") ? Number(Deno.env.get("PORT")) : 7000,
    cache: {
      max: 1000,
      ttl: 24 * 60 * 60,
    },
  });
  console.log("Server started successfully");
} catch (error) {
  console.error("Server startup error:", {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
}

// Publish to central with error handling
try {
  await publishToCentral("https://discussio.deno.dev/manifest.json");
  console.log("Successfully published to Stremio Central!");
} catch (error) {
  console.error("Failed to publish to central:", {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  });
}