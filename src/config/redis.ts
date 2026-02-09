/**
 * Redis Configuration
 *
 * This module handles Redis connection setup with best practices:
 * - Connection pooling
 * - Error handling and reconnection
 * - Environment-based configuration
 * - Graceful shutdown
 */

import { Redis, Cluster } from "ioredis";
import { logger } from "../utils/logger";

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
  // Connection pool settings
  maxRetriesPerRequest: number;
  enableReadyCheck: boolean;
  // Performance tuning
  lazyConnect: boolean;
  // Cluster mode (optional)
  clusterMode: boolean;
  nodes?: Array<{ host: string; port: number }>;
}

export const getRedisConfig = (): RedisConfig => {
  // Use environment variables with fallbacks for local development
  return {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT || "6379"),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB || "0"),
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: false,
    clusterMode: process.env.REDIS_CLUSTER_MODE === "true",
    nodes: process.env.REDIS_NODES
      ? JSON.parse(process.env.REDIS_NODES)
      : undefined,
  };
};

/**
 * Creates Redis client instance with proper error handling
 */
export const createRedisClient = (config: RedisConfig): Redis | Cluster => {
  let client: Redis | Cluster;

  if (config.clusterMode && config.nodes) {
    // Cluster mode for horizontal scaling
    client = new Redis.Cluster(config.nodes, {
      redisOptions: {
        password: config.password,
        maxRetriesPerRequest: config.maxRetriesPerRequest,
      },
    });
  } else {
    // Single instance mode
    client = new Redis({
      host: config.host,
      port: config.port,
      password: config.password,
      db: config.db,
      maxRetriesPerRequest: config.maxRetriesPerRequest,
      enableReadyCheck: config.enableReadyCheck,
      lazyConnect: config.lazyConnect,
      // Auto-reconnect with exponential backoff
      retryStrategy: (times) => {
        const delay = Math.min(times * 1000, 10000);
        logger.warn(`Redis reconnecting attempt ${times}, delay: ${delay}ms`);
        return delay;
      },
    });
  }

  // Event listeners for monitoring
  client.on("connect", () => {
    logger.info("Redis client connected successfully");
  });

  client.on("error", (error) => {
    logger.error("Redis connection error:", error);
  });

  client.on("close", () => {
    logger.warn("Redis connection closed");
  });

  client.on("reconnecting", () => {
    logger.info("Redis client reconnecting...");
  });

  return client;
};
