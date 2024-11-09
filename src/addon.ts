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

const builder = new addonBuilder({
  id: "com.discussio",
  version: "1.0.0",
  name: "Discussio (Deprecated)",
  description: `⚠️ This version is deprecated. Please update to the latest version of Discussio for continued functionality.`,
  resources: ["stream"],
  types: ["series"],
  idPrefixes: ["tt"],
  catalogs: [],
});

builder.defineStreamHandler(
  async (args: StreamHandlerArgs): Promise<{ streams: Stream[] }> => {
    try {
      // Return deprecation message for all valid requests
      if (args.type === "series" && args.id.match(/tt(\d+):(\d+):(\d+)/)) {
        return {
          streams: [
            {
              title: "⚠️ Discussio has moved!",
              externalUrl: "https://discussio.elfhosted.com", // Update this to your new server URL
              behavior: "Open",
            },
          ],
        };
      }

      // Silently return empty streams for invalid requests
      logger.debug("Invalid request received", {
        type: args.type,
        id: args.id,
      });
      return { streams: [] };
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
    logger.info("Deprecated server started successfully");

    // Only publish during deployment when explicitly requested
    if (options.shouldPublish) {
      try {
        await publishToCentral("https://discussio.deno.dev/manifest.json");
        logger.info(
          "Successfully published deprecated version to Stremio Central!"
        );
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
