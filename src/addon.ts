import {
  addonBuilder,
  serveHTTP,
  Stream,
  StreamHandlerArgs,
  publishToCentral,
} from "npm:stremio-addon-sdk";

// Enum for log levels
enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

// Current log level - can be set via environment variable
const CURRENT_LOG_LEVEL = Number(Deno.env.get("LOG_LEVEL") ?? LogLevel.INFO);

// Custom error interface
interface ErrorWithStack {
  message: string;
  stack?: string;
}

// Logger utility
const logger = {
  debug: (message: string, data?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.DEBUG) {
      console.debug(`[DEBUG] ${message}`, data);
    }
  },
  info: (message: string, data?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.INFO) {
      console.log(`[INFO] ${message}`, data);
    }
  },
  warn: (message: string, data?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.WARN) {
      console.warn(`[WARN] ${message}`, data);
    }
  },
  error: (message: string, data?: unknown) => {
    if (CURRENT_LOG_LEVEL <= LogLevel.ERROR) {
      console.error(`[ERROR] ${message}`, data);
    }
  },
};

// Helper function to extract error details
function getErrorDetails(error: unknown): ErrorWithStack {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

// Global error handlers
addEventListener("unhandledrejection", (event) => {
  const errorDetails = getErrorDetails(event.reason);
  logger.error("Unhandled Promise Rejection:", {
    error: errorDetails.message,
    timestamp: new Date().toISOString(),
    stack: errorDetails.stack,
  });
});

addEventListener("error", (event) => {
  const errorDetails = getErrorDetails(event.error);
  logger.error("Uncaught Error:", {
    error: errorDetails.message,
    timestamp: new Date().toISOString(),
    stack: errorDetails.stack,
  });
});

// Cache for show names to improve performance
const showNameCache = new Map<string, string>();

const builder = new addonBuilder({
  id: "com.discussio",
  version: "1.0.0",
  name: "Discussio",
  description: `Opens Google search for TV show episode discussions with one click. Simply select an episode to search for its discussions online.`,
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
  } catch (error: unknown) {
    const errorDetails = getErrorDetails(error);
    if (error instanceof Error && error.name === "AbortError") {
      logger.warn(`Timeout fetching IMDB page for ${imdbId}`);
    } else {
      logger.error(`Error fetching IMDB page for ${imdbId}:`, {
        error: errorDetails.message,
        stack: errorDetails.stack,
        timestamp: new Date().toISOString(),
      });
    }
    return imdbId;
  }
}

builder.defineStreamHandler(
  async (args: StreamHandlerArgs): Promise<{ streams: Stream[] }> => {
    try {
      // Silently return empty streams for non-series content
      if (args.type !== "series") {
        logger.debug("Non-series request received", { type: args.type });
        return { streams: [] };
      }

      const match = args.id.match(/tt(\d+):(\d+):(\d+)/);
      if (!match) {
        logger.warn("Invalid ID format received", { id: args.id });
        return { streams: [] };
      }

      const [_, imdbId, season, episode] = match;

      // Add timeout for the entire handler
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Handler timeout")), 8000);
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
    } catch (error: unknown) {
      const errorDetails = getErrorDetails(error);
      logger.error("Stream handler error:", {
        error: errorDetails.message,
        stack: errorDetails.stack,
        timestamp: new Date().toISOString(),
        args: JSON.stringify(args),
      });
      return { streams: [] };
    }
  }
);

// Wrap server startup and publishing in error handling
async function startServer(options: { shouldPublish?: boolean } = {}) {
  try {
    await serveHTTP(builder.getInterface(), {
      port: Deno.env.get("PORT") ? Number(Deno.env.get("PORT")) : 7000,
      cache: {
        max: 1000,
        ttl: 24 * 60 * 60,
      },
    });
    logger.info("Server started successfully");

    // Only publish during deployment when explicitly requested
    if (options.shouldPublish) {
      try {
        await publishToCentral("https://discussio.deno.dev/manifest.json");
        logger.info("Successfully published to Stremio Central!");
      } catch (error: unknown) {
        const errorDetails = getErrorDetails(error);
        logger.error("Failed to publish to central:", {
          error: errorDetails.message,
          stack: errorDetails.stack,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } catch (error: unknown) {
    const errorDetails = getErrorDetails(error);
    logger.error("Server startup error:", {
      error: errorDetails.message,
      stack: errorDetails.stack,
      timestamp: new Date().toISOString(),
    });
  }
}

// Start server with publishing controlled by environment variable
await startServer({
  shouldPublish: Deno.env.get("PUBLISH_TO_CENTRAL") === "true",
});
