/**
 * Express Application Setup
 *
 * This file configures and creates the Express application
 * with all necessary middleware, routes, and error handling.
 */

import express, { Application, Request, Response, NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import Redis from "ioredis";
import { logger } from "./utils/logger";
import { createRedisClient } from "./config/redis";
import { RedisStore } from "./core/store/redis-store";
import { RateLimitService } from "./services/rate-limit.service";
import { createRateLimiterMiddleware } from "./api/middleware/rate-limiter";
import { errorHandler } from "./api/middleware/error-handler";
import { healthRouter } from "./api/routes/health";
import { apiRouter } from "./api/routes/v1/public";
import { adminRouter } from "./api/routes/v1/admin";
import { metricsRouter } from "./api/routes/metrics";
import { AppError, RateLimitExceededError } from "./utils/errors";

/**
 * Application configuration interface
 */
export interface AppConfig {
  port: number;
  redisUrl?: string;
  enableCors: boolean;
  corsOrigin: string[];
  enableCompression: boolean;
  trustProxy: boolean;
  rateLimitConfig: {
    enabled: boolean;
    defaultLimit: number;
    defaultWindowMs: number;
    algorithm:
      | "token-bucket"
      | "fixed-window"
      | "sliding-window"
      | "leaky-bucket";
  };
}

/**
 * Default application configuration
 */
const DEFAULT_CONFIG: AppConfig = {
  port: parseInt(process.env.PORT || "3000", 10),
  redisUrl: process.env.REDIS_URL,
  enableCors: process.env.ENABLE_CORS !== "false",
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["*"],
  enableCompression: process.env.ENABLE_COMPRESSION !== "false",
  trustProxy: process.env.TRUST_PROXY === "true",
  rateLimitConfig: {
    enabled: process.env.RATE_LIMIT_ENABLED !== "false",
    defaultLimit: parseInt(process.env.RATE_LIMIT_DEFAULT_LIMIT || "100", 10),
    defaultWindowMs: parseInt(
      process.env.RATE_LIMIT_DEFAULT_WINDOW_MS || "60000",
      10,
    ),
    algorithm: (process.env.RATE_LIMIT_ALGORITHM || "token-bucket") as any,
  },
};

/**
 * Creates and configures an Express application
 *
 * @param config - Application configuration
 * @returns Configured Express application
 */
export function createApp(config: Partial<AppConfig> = {}): Application {
  // Merge provided config with defaults
  const appConfig: AppConfig = { ...DEFAULT_CONFIG, ...config };

  // Create Express application
  const app: Application = express();

  // Apply configuration
  configureApp(app, appConfig);

  // Set up Redis and services
  const { rateLimitService } = setupServices(appConfig);

  // Apply global middleware
  applyMiddleware(app, appConfig, rateLimitService);

  // Set up routes
  setupRoutes(app, rateLimitService);

  // Set up error handling
  setupErrorHandling(app);

  // Log application startup
  logger.info("Express application configured", {
    port: appConfig.port,
    environment: process.env.NODE_ENV || "development",
    rateLimitEnabled: appConfig.rateLimitConfig.enabled,
  });

  return app;
}

/**
 * Configure Express application settings
 */
function configureApp(app: Application, config: AppConfig): void {
  // Trust proxy headers (important for getting real client IP)
  if (config.trustProxy) {
    app.set("trust proxy", true);
  }

  // Disable X-Powered-By header for security
  app.disable("x-powered-by");

  // Set view engine if needed (for admin dashboard)
  app.set("view engine", "ejs");
  app.set("views", "./src/views");
}

/**
 * Set up Redis and services
 */
function setupServices(config: AppConfig) {
  let redisClient: Redis;
  let rateLimitService: RateLimitService | undefined;

  try {
    // Create Redis client
    redisClient = createRedisClient({
      host: process.env.REDIS_HOST || "localhost",
      port: parseInt(process.env.REDIS_PORT || "6379", 10),
      password: process.env.REDIS_PASSWORD,
      db: parseInt(process.env.REDIS_DB || "0", 10),
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      clusterMode: process.env.REDIS_CLUSTER_MODE === "true",
    });

    // Create Redis store
    const redisStore = new RedisStore(redisClient, {
      prefix: process.env.REDIS_PREFIX || "ratelimit",
      ttl: parseInt(process.env.REDIS_TTL || "86400", 10),
      scanCount: parseInt(process.env.REDIS_SCAN_COUNT || "100", 10),
    });

    // Create rate limit service
    if (config.rateLimitConfig.enabled) {
      rateLimitService = new RateLimitService(redisStore, {
        defaultAlgorithm: config.rateLimitConfig.algorithm,
        defaultLimit: config.rateLimitConfig.defaultLimit,
        defaultWindowMs: config.rateLimitConfig.defaultWindowMs,
        rules: getRateLimitRules(),
        fallbackToMemory: process.env.RATE_LIMIT_FALLBACK_TO_MEMORY !== "false",
        enableMetrics: process.env.RATE_LIMIT_ENABLE_METRICS !== "false",
        cleanupInterval: parseInt(
          process.env.RATE_LIMIT_CLEANUP_INTERVAL || "3600000",
          10,
        ),
      });
    }

    // Store services in app locals for access in routes/middleware
    app.locals.redisClient = redisClient;
    app.locals.redisStore = redisStore;
    app.locals.rateLimitService = rateLimitService;
  } catch (error) {
    logger.error("Failed to setup services:", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    // If Redis fails but rate limiting is disabled, we can continue
    if (config.rateLimitConfig.enabled) {
      throw new Error("Failed to initialize rate limiting service");
    }
  }

  return { rateLimitService };
}

/**
 * Get rate limiting rules from configuration
 */
function getRateLimitRules() {
  // In a real application, these would come from a database or config file
  return [
    {
      path: "/api/v1/auth/*",
      methods: ["POST"],
      limit: 10,
      windowMs: 15 * 60 * 1000, // 15 minutes
      algorithm: "fixed-window",
      priority: 100,
      clientTypes: ["ip"],
    },
    {
      path: "/api/v1/admin/*",
      methods: ["*"],
      limit: 1000,
      windowMs: 60 * 60 * 1000, // 1 hour
      algorithm: "token-bucket",
      priority: 90,
      clientTypes: ["apikey", "user"],
    },
    {
      path: "/api/v1/*",
      methods: ["GET"],
      limit: 100,
      windowMs: 60 * 1000, // 1 minute
      algorithm: "sliding-window",
      priority: 50,
      clientTypes: ["ip", "apikey", "user"],
    },
  ];
}

/**
 * Apply global middleware to the application
 */
function applyMiddleware(
  app: Application,
  config: AppConfig,
  rateLimitService?: RateLimitService,
): void {
  // Security middleware
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https:"],
        },
      },
    }),
  );

  // CORS middleware
  if (config.enableCors) {
    app.use(
      cors({
        origin: config.corsOrigin,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
        exposedHeaders: [
          "X-RateLimit-Limit",
          "X-RateLimit-Remaining",
          "X-RateLimit-Reset",
        ],
      }),
    );
  }

  // Compression middleware
  if (config.enableCompression) {
    app.use(compression());
  }

  // Body parsing middleware
  app.use(
    express.json({
      limit: process.env.BODY_LIMIT || "10mb",
      verify: (req: any, res, buf) => {
        req.rawBody = buf; // Store raw body for signature verification
      },
    }),
  );

  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    const requestId =
      Date.now().toString(36) + Math.random().toString(36).substr(2);

    // Store request ID for logging
    req.id = requestId;

    // Log request
    logger.info("Request started", {
      requestId,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    // Log response when finished
    res.on("finish", () => {
      const duration = Date.now() - startTime;

      logger.info("Request completed", {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        duration,
        ip: req.ip,
      });
    });

    next();
  });

  // Global rate limiting middleware (if enabled)
  if (rateLimitService && config.rateLimitConfig.enabled) {
    const rateLimiterMiddleware = createRateLimiterMiddleware(
      rateLimitService,
      {
        algorithm: config.rateLimitConfig.algorithm,
        limit: config.rateLimitConfig.defaultLimit,
        windowMs: config.rateLimitConfig.defaultWindowMs,
        message: "Too many requests, please try again later.",
        enableHeaders: true,
        headerPrefix: "X-RateLimit",
      },
    );

    // Apply to all routes except health and metrics
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.path === "/health" || req.path.startsWith("/metrics")) {
        return next();
      }
      rateLimiterMiddleware(req, res, next);
    });
  }
}

/**
 * Set up application routes
 */
function setupRoutes(
  app: Application,
  rateLimitService?: RateLimitService,
): void {
  // Health check route (no rate limiting)
  app.use("/health", healthRouter);

  // Metrics route (no rate limiting)
  app.use("/metrics", metricsRouter);

  // API routes (with rate limiting applied globally)
  app.use("/api/v1", apiRouter);

  // Admin routes (with stricter rate limiting)
  app.use("/api/v1/admin", adminRouter);

  // API documentation route
  app.get("/docs", (req: Request, res: Response) => {
    res.json({
      name: "Rate Limiter Service API",
      version: "1.0.0",
      endpoints: {
        health: "/health",
        metrics: "/metrics",
        api: "/api/v1",
        admin: "/api/v1/admin",
      },
      rateLimiting: rateLimitService
        ? {
            enabled: true,
            defaultLimit: rateLimitService["config"].defaultLimit,
            defaultWindowMs: rateLimitService["config"].defaultWindowMs,
            defaultAlgorithm: rateLimitService["config"].defaultAlgorithm,
          }
        : { enabled: false },
    });
  });

  // 404 handler for undefined routes
  app.use((req: Request, res: Response, next: NextFunction) => {
    logger.warn("Route not found", {
      method: req.method,
      url: req.url,
      ip: req.ip,
    });

    res.status(404).json({
      error: "Not Found",
      message: `Cannot ${req.method} ${req.url}`,
      timestamp: new Date().toISOString(),
    });
  });
}

/**
 * Set up error handling middleware
 */
function setupErrorHandling(app: Application): void {
  // Custom error handler
  app.use(errorHandler);

  // Global error handler (catches any unhandled errors)
  app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
    // Log the error
    logger.error("Unhandled error:", {
      requestId: req.id,
      error: error.message,
      stack: error.stack,
      url: req.url,
      method: req.method,
      ip: req.ip,
    });

    // Determine status code
    let statusCode = 500;
    let message = "Internal Server Error";

    if (error instanceof AppError) {
      statusCode = error.statusCode;
      message = error.message;
    }

    // Send error response
    res.status(statusCode).json({
      error: error.name || "Error",
      message,
      statusCode,
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
    });
  });

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
    logger.error("Unhandled Promise Rejection:", {
      reason: reason?.message || reason,
      stack: reason?.stack,
    });

    // In production, you might want to restart the process
    if (process.env.NODE_ENV === "production") {
      // Graceful shutdown
      process.exit(1);
    }
  });

  // Handle uncaught exceptions
  process.on("uncaughtException", (error: Error) => {
    logger.error("Uncaught Exception:", {
      error: error.message,
      stack: error.stack,
    });

    // Graceful shutdown
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });
}

/**
 * Start the Express server
 */
export function startServer(app: Application, port?: number): void {
  const serverPort = port || parseInt(process.env.PORT || "3000", 10);

  const server = app.listen(serverPort, () => {
    logger.info(`Server is running on port ${serverPort}`, {
      environment: process.env.NODE_ENV || "development",
      pid: process.pid,
    });
  });

  // Graceful shutdown handler
  const gracefulShutdown = (signal: string) => {
    logger.info(`Received ${signal}, starting graceful shutdown...`);

    server.close(async () => {
      // Close services
      if (app.locals.rateLimitService) {
        await app.locals.rateLimitService.close();
      }

      if (app.locals.redisClient) {
        await app.locals.redisClient.quit();
      }

      logger.info("Graceful shutdown completed");
      process.exit(0);
    });

    // Force shutdown after timeout
    setTimeout(() => {
      logger.error("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 10000);
  };

  // Handle shutdown signals
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // Handle server errors
  server.on("error", (error: Error) => {
    logger.error("Server error:", {
      error: error.message,
      stack: error.stack,
    });

    if ((error as any).code === "EADDRINUSE") {
      logger.error(`Port ${serverPort} is already in use`);
      process.exit(1);
    }
  });
}

// Export app creation and server start for use in server.ts
export default { createApp, startServer };
