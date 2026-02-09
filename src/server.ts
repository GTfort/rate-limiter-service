/**
 * Server Entry Point with Clustering Support
 *
 * This enables horizontal scaling by leveraging all CPU cores.
 * Each worker runs its own Express instance, sharing the Redis connection.
 *
 * Benefits:
 * - Better CPU utilization on multi-core systems
 * - Isolation: if one worker crashes, others continue
 * - Graceful restart capabilities
 */

import cluster from "cluster";
import os from "os";
import { createApp } from "./app";
import { logger } from "./utils/logger";
import { createRedisClient } from "./config/redis";
import { getRedisConfig } from "./config/redis";

// Maximum number of workers (can be configured via env)
const MAX_WORKERS = process.env.MAX_WORKERS
  ? parseInt(process.env.MAX_WORKERS)
  : os.cpus().length;

/**
 * Master Process Responsibilities:
 * 1. Fork worker processes
 * 2. Manage worker lifecycle
 * 3. Handle graceful shutdown
 */
if (cluster.isMaster) {
  logger.info(`Master process ${process.pid} is running`);

  // Fork workers
  const numWorkers = Math.min(MAX_WORKERS, os.cpus().length);
  logger.info(`Forking ${numWorkers} workers`);

  for (let i = 0; i < numWorkers; i++) {
    cluster.fork();
  }

  // Handle worker exit
  cluster.on("exit", (worker, code, signal) => {
    const exitCode = worker.process.exitCode;
    logger.warn(
      `Worker ${worker.process.pid} died (code: ${exitCode}, signal: ${signal})`,
    );

    // Restart worker unless it was intentional shutdown
    if (code !== 0 && signal !== "SIGTERM") {
      logger.info("Restarting worker...");
      cluster.fork();
    }
  });

  // Graceful shutdown handler
  const gracefulShutdown = (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);

    // Notify workers to stop accepting new connections
    Object.values(cluster.workers || {}).forEach((worker) => {
      if (worker) {
        worker.send("shutdown");
      }
    });

    // Wait for workers to finish, then exit
    setTimeout(() => {
      logger.info("Shutdown complete");
      process.exit(0);
    }, 5000);
  };

  // Handle termination signals
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
} else {
  /**
   * Worker Process Responsibilities:
   * 1. Create and run Express app
   * 2. Handle incoming requests
   * 3. Report health status to master
   */

  (async () => {
    try {
      logger.info(`Worker ${process.pid} started`);

      // Create Redis client for this worker
      const redisConfig = getRedisConfig();
      const redisClient = createRedisClient(redisConfig);

      // Wait for Redis connection
      await new Promise((resolve, reject) => {
        redisClient.on("ready", resolve);
        redisClient.on("error", reject);
      });

      // Create Express app with Redis client
      const app = createApp(redisClient);

      // Start server
      const PORT = process.env.PORT || 3000;
      const server = app.listen(PORT, () => {
        logger.info(`Worker ${process.pid} listening on port ${PORT}`);
      });

      // Graceful shutdown for worker
      process.on("message", (msg) => {
        if (msg === "shutdown") {
          logger.info(`Worker ${process.pid} shutting down...`);

          server.close(() => {
            redisClient.disconnect();
            logger.info(`Worker ${process.pid} shutdown complete`);
            process.exit(0);
          });

          // Force close after timeout
          setTimeout(() => {
            logger.warn(`Worker ${process.pid} forced shutdown`);
            process.exit(1);
          }, 10000);
        }
      });

      // Handle uncaught errors
      process.on("uncaughtException", (error) => {
        logger.error(`Worker ${process.pid} uncaught exception:`, error);
        // Don't exit immediately, let the master restart us
      });
    } catch (error) {
      logger.error(`Worker ${process.pid} failed to start:`, error);
      process.exit(1);
    }
  })();
}
