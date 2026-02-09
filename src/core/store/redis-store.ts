/**
 * Redis Store Implementation
 *
 * This class abstracts Redis operations for rate limiting.
 * It provides atomic operations, connection management, and
 * error handling specific to rate limiting use cases.
 */

import Redis from "ioredis";
import { logger } from "../../utils/logger";
import { StoreError } from "../../utils/errors";
import { RedisStoreConfig } from "../../types";

/**
 * Store interface that defines the contract for any storage backend
 * This allows us to swap Redis with other stores (e.g., Memcached, in-memory)
 */
export interface Store {
  // Increment counter for a key and return new value
  increment(key: string, windowMs: number): Promise<number>;

  // Get current value without incrementing
  get(key: string): Promise<number | null>;

  // Set a key with expiration
  set(key: string, value: number, ttlSeconds: number): Promise<void>;

  // Delete a key
  delete(key: string): Promise<void>;

  // Reset/delete all keys for a client
  resetClient(identifier: string): Promise<void>;

  // Execute Lua script for atomic operations
  eval<T = any>(script: string, keys: number, ...args: string[]): Promise<T>;

  // Check if store is connected and healthy
  isHealthy(): Promise<boolean>;

  // Close store connection gracefully
  close(): Promise<void>;
}

/**
 * Redis implementation of the Store interface
 *
 * Uses ioredis for Redis operations with:
 * - Connection pooling
 * - Lua script atomicity
 * - Error handling and retries
 * - Connection health monitoring
 */
export class RedisStore implements Store {
  private client: Redis | Redis.Cluster;
  private config: RedisStoreConfig;
  private isClosed: boolean = false;

  constructor(
    redisClient: Redis | Redis.Cluster,
    config: Partial<RedisStoreConfig> = {},
  ) {
    this.client = redisClient;

    // Default configuration with environment overrides
    this.config = {
      prefix: config.prefix || process.env.REDIS_PREFIX || "ratelimit",
      ttl: config.ttl || parseInt(process.env.REDIS_TTL || "86400"), // 24 hours default
      scanCount: config.scanCount || 100,
    };

    // Set up event listeners for monitoring
    this.setupEventListeners();
  }

  /**
   * Set up Redis event listeners for monitoring and debugging
   */
  private setupEventListeners(): void {
    this.client.on("connect", () => {
      logger.info("Redis store connected successfully", {
        store: "redis",
        prefix: this.config.prefix,
      });
    });

    this.client.on("error", (error) => {
      logger.error("Redis store error:", {
        store: "redis",
        error: error.message,
        stack: error.stack,
      });
    });

    this.client.on("close", () => {
      logger.warn("Redis store connection closed");
      this.isClosed = true;
    });

    this.client.on("reconnecting", (delay: number) => {
      logger.info(`Redis store reconnecting in ${delay}ms`);
    });
  }

  /**
   * Generate a namespaced Redis key
   * Format: {prefix}:{type}:{identifier}:{window}
   *
   * This prevents key collisions and allows for easy key pattern matching
   */
  private generateKey(parts: string[]): string {
    return [this.config.prefix, ...parts].join(":");
  }

  /**
   * Increment counter for a key atomically
   *
   * Uses Redis INCR command with EXPIRE to ensure
   * the key is automatically cleaned up after the window
   */
  async increment(key: string, windowMs: number): Promise<number> {
    try {
      if (this.isClosed) {
        throw new StoreError("redis", "increment", "Redis store is closed");
      }

      // Calculate TTL in seconds (round up)
      const ttlSeconds = Math.ceil(windowMs / 1000);

      // Generate final Redis key
      const redisKey = this.generateKey([key]);

      /**
       * Use Lua script for atomic increment and expiration
       * This ensures both operations happen atomically
       * and prevents race conditions
       */
      const luaScript = `
        -- Increment the counter
        local current = redis.call('INCR', KEYS[1])

        -- Set expiration only on first increment (avoid resetting TTL on existing keys)
        if current == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end

        return current
      `;

      const result = await this.client.eval(
        luaScript,
        1,
        redisKey,
        ttlSeconds.toString(),
      );

      return Number(result);
    } catch (error) {
      logger.error("Redis increment failed:", {
        key,
        windowMs,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      if (error instanceof StoreError) {
        throw error;
      }

      throw new StoreError(
        "redis",
        "increment",
        "Failed to increment counter",
        key,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get current value without modifying it
   * Useful for checking remaining limits
   */
  async get(key: string): Promise<number | null> {
    try {
      if (this.isClosed) {
        throw new StoreError("redis", "get", "Redis store is closed");
      }

      const redisKey = this.generateKey([key]);
      const value = await this.client.get(redisKey);

      return value ? parseInt(value, 10) : null;
    } catch (error) {
      logger.error("Redis get failed:", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw new StoreError(
        "redis",
        "get",
        "Failed to get value",
        key,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Set a key with a specific value and TTL
   * Useful for manual overrides or initialization
   */
  async set(key: string, value: number, ttlSeconds: number): Promise<void> {
    try {
      if (this.isClosed) {
        throw new StoreError("redis", "set", "Redis store is closed");
      }

      const redisKey = this.generateKey([key]);

      // Use SET with EX option for atomic set+expire
      await this.client.set(redisKey, value.toString(), "EX", ttlSeconds);
    } catch (error) {
      logger.error("Redis set failed:", {
        key,
        value,
        ttlSeconds,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw new StoreError(
        "redis",
        "set",
        "Failed to set value",
        key,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Delete a specific key
   */
  async delete(key: string): Promise<void> {
    try {
      if (this.isClosed) {
        throw new StoreError("redis", "delete", "Redis store is closed");
      }

      const redisKey = this.generateKey([key]);
      await this.client.del(redisKey);
    } catch (error) {
      logger.error("Redis delete failed:", {
        key,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw new StoreError(
        "redis",
        "delete",
        "Failed to delete key",
        key,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Reset all keys for a client identifier
   *
   * Uses SCAN to find all keys matching the client pattern
   * This is safer than KEYS command in production
   */
  async resetClient(identifier: string): Promise<void> {
    try {
      if (this.isClosed) {
        throw new StoreError("redis", "resetClient", "Redis store is closed");
      }

      const pattern = this.generateKey([`*${identifier}*`]);
      const pipeline = this.client.pipeline();
      let cursor = "0";
      let deletedCount = 0;

      // Use SCAN instead of KEYS to avoid blocking Redis
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          this.config.scanCount,
        );

        cursor = nextCursor;

        // Delete all matching keys
        keys.forEach((key) => {
          pipeline.del(key);
          deletedCount++;
        });
      } while (cursor !== "0");

      // Execute all deletions in pipeline for efficiency
      await pipeline.exec();

      logger.info("Reset client rate limits", {
        identifier,
        deletedCount,
      });
    } catch (error) {
      logger.error("Redis resetClient failed:", {
        identifier,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw new StoreError(
        "redis",
        "resetClient",
        "Failed to reset client",
        identifier,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Execute Lua script with arguments
   *
   * This is the most powerful method, allowing for
   * complex atomic operations specific to each algorithm
   */
  async eval<T = any>(
    script: string,
    numKeys: number,
    ...args: string[]
  ): Promise<T> {
    try {
      if (this.isClosed) {
        throw new StoreError("redis", "eval", "Redis store is closed");
      }

      // Prepend prefix to keys if needed
      const keys = args.slice(0, numKeys).map((key) => this.generateKey([key]));
      const scriptArgs = args.slice(numKeys);

      const result = await this.client.eval(
        script,
        keys.length,
        ...keys,
        ...scriptArgs,
      );

      return result as T;
    } catch (error) {
      logger.error("Redis eval failed:", {
        scriptLength: script.length,
        numKeys,
        args: args.join(","),
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw new StoreError(
        "redis",
        "eval",
        "Failed to execute Lua script",
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Check if Redis store is healthy
   *
   * Pings Redis and checks connection status
   */
  async isHealthy(): Promise<boolean> {
    try {
      if (this.isClosed) {
        return false;
      }

      const response = await this.client.ping();
      return response === "PONG";
    } catch (error) {
      logger.warn("Redis health check failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return false;
    }
  }

  /**
   * Get Redis info for monitoring
   */
  async getInfo(): Promise<Record<string, any>> {
    try {
      if (this.isClosed) {
        return { status: "closed" };
      }

      const info = await this.client.info();
      const infoObj: Record<string, any> = {};

      // Parse Redis INFO response
      info.split("\r\n").forEach((line) => {
        if (line && !line.startsWith("#")) {
          const [key, value] = line.split(":");
          if (key && value) {
            infoObj[key.trim()] = value.trim();
          }
        }
      });

      return infoObj;
    } catch (error) {
      logger.error("Failed to get Redis info:", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return { error: "Failed to get info" };
    }
  }

  /**
   * Close Redis connection gracefully
   */
  async close(): Promise<void> {
    try {
      if (!this.isClosed) {
        await this.client.quit();
        this.isClosed = true;
        logger.info("Redis store connection closed gracefully");
      }
    } catch (error) {
      logger.error("Error closing Redis store:", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      // Force close on error
      this.client.disconnect();
      this.isClosed = true;
    }
  }

  /**
   * Get store statistics for monitoring
   */
  async getStats(): Promise<{
    keyCount: number;
    memoryUsage: number;
    connected: boolean;
  }> {
    try {
      const info = await this.getInfo();
      const pattern = this.generateKey(["*"]);
      let keyCount = 0;
      let cursor = "0";

      // Count keys with pattern using SCAN
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          this.config.scanCount,
        );
        cursor = nextCursor;
        keyCount += keys.length;
      } while (cursor !== "0");

      return {
        keyCount,
        memoryUsage: parseInt(info.used_memory_human || "0", 10),
        connected: await this.isHealthy(),
      };
    } catch (error) {
      logger.error("Failed to get Redis stats:", {
        error: error instanceof Error ? error.message : "Unknown error",
      });

      return {
        keyCount: -1,
        memoryUsage: -1,
        connected: false,
      };
    }
  }
}

/**
 * Memory store implementation for fallback or testing
 *
 * This is a simple in-memory store that can be used
 * when Redis is unavailable. It's not suitable for
 * distributed systems but works for single instances.
 */
export class MemoryStore implements Store {
  private store: Map<string, { value: number; expires: number }> = new Map();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    // Clean up expired entries every minute
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpired();
    }, 60000);
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expires <= now) {
        this.store.delete(key);
      }
    }
  }

  async increment(key: string, windowMs: number): Promise<number> {
    const now = Date.now();
    const expires = now + windowMs;

    const entry = this.store.get(key);
    if (entry && entry.expires > now) {
      entry.value += 1;
      return entry.value;
    } else {
      this.store.set(key, { value: 1, expires });
      return 1;
    }
  }

  async get(key: string): Promise<number | null> {
    const entry = this.store.get(key);
    const now = Date.now();

    if (entry && entry.expires > now) {
      return entry.value;
    }
    return null;
  }

  async set(key: string, value: number, ttlSeconds: number): Promise<void> {
    const expires = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expires });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async resetClient(identifier: string): Promise<void> {
    for (const [key] of this.store.entries()) {
      if (key.includes(identifier)) {
        this.store.delete(key);
      }
    }
  }

  async eval<T = any>(
    script: string,
    numKeys: number,
    ...args: string[]
  ): Promise<T> {
    throw new Error("Lua scripts not supported in memory store");
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}
