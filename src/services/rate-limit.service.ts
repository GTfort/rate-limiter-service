/**
 * Rate Limit Service
 *
 * This is the core service that orchestrates rate limiting.
 * It manages different algorithms, handles client identification,
 * and provides a clean API for the rest of the application.
 */

import {
  RateLimitOptions,
  RateLimitResult,
  AlgorithmType,
  ClientIdentifier,
  RateLimitRule,
  RateLimitMetrics,
} from "../types";
import { Store, RedisStore } from "../core/store/redis-store";
import {
  RateLimitExceededError,
  InvalidRequestError,
  AlgorithmNotImplementedError,
  StoreError,
} from "../utils/errors";
import { logger } from "../utils/logger";

// Import algorithm implementations
import { TokenBucketAlgorithm } from "../core/algorithms/token-bucket";
import { FixedWindowAlgorithm } from "../core/algorithms/fixed-window";
import { SlidingWindowAlgorithm } from "../core/algorithms/sliding-window";
import { LeakyBucketAlgorithm } from "../core/algorithms/leaky-bucket";

// Import base algorithm class for type safety
import { RateLimiterAlgorithm } from "../core/algorithms/base";

/**
 * Configuration for the rate limit service
 */
export interface RateLimitServiceConfig {
  defaultAlgorithm: AlgorithmType;
  defaultLimit: number;
  defaultWindowMs: number;
  rules: RateLimitRule[];
  fallbackToMemory: boolean; // Use memory store if Redis fails
  enableMetrics: boolean; // Collect and expose metrics
  cleanupInterval: number; // How often to clean up old data (ms)
}

/**
 * Main Rate Limit Service
 *
 * This service provides:
 * 1. Algorithm selection and management
 * 2. Client identification
 * 3. Rule matching and application
 * 4. Metrics collection
 * 5. Fallback mechanisms
 */
export class RateLimitService {
  private store: Store;
  private config: RateLimitServiceConfig;
  private algorithms: Map<
    AlgorithmType,
    new (store: Store, options: RateLimitOptions) => RateLimiterAlgorithm
  >;
  private metrics: RateLimitMetrics;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(store: Store, config: Partial<RateLimitServiceConfig> = {}) {
    this.store = store;

    // Initialize with default configuration
    this.config = {
      defaultAlgorithm: config.defaultAlgorithm || "token-bucket",
      defaultLimit: config.defaultLimit || 100,
      defaultWindowMs: config.defaultWindowMs || 60000, // 1 minute
      rules: config.rules || [],
      fallbackToMemory: config.fallbackToMemory !== false, // Default true
      enableMetrics: config.enableMetrics !== false, // Default true
      cleanupInterval: config.cleanupInterval || 3600000, // 1 hour
    };

    // Sort rules by priority (highest first)
    this.config.rules.sort((a, b) => b.priority - a.priority);

    // Initialize algorithm registry
    this.algorithms = new Map();
    this.registerAlgorithms();

    // Initialize metrics
    this.metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      averageResponseTime: 0,
      algorithmUsage: {
        "token-bucket": 0,
        "fixed-window": 0,
        "sliding-window": 0,
        "leaky-bucket": 0,
      },
      topBlockedClients: [],
    };

    // Start cleanup timer if configured
    if (this.config.cleanupInterval > 0) {
      this.startCleanupTimer();
    }

    logger.info("Rate limit service initialized", {
      defaultAlgorithm: this.config.defaultAlgorithm,
      defaultLimit: this.config.defaultLimit,
      defaultWindowMs: this.config.defaultWindowMs,
      ruleCount: this.config.rules.length,
    });
  }

  /**
   * Register all available algorithms
   *
   * This pattern makes it easy to add new algorithms
   * without modifying the service itself
   */
  private registerAlgorithms(): void {
    this.algorithms.set("token-bucket", TokenBucketAlgorithm);
    this.algorithms.set("fixed-window", FixedWindowAlgorithm);
    this.algorithms.set("sliding-window", SlidingWindowAlgorithm);
    this.algorithms.set("leaky-bucket", LeakyBucketAlgorithm);
  }

  /**
   * Main method to check rate limit for a client
   *
   * This is the primary API for the service.
   * It handles:
   * 1. Client identification
   * 2. Rule matching
   * 3. Algorithm execution
   * 4. Metrics collection
   * 5. Error handling and fallback
   */
  public async checkLimit(
    identifier: string,
    algorithm?: AlgorithmType,
    options?: Partial<RateLimitOptions>,
    context?: {
      path?: string;
      method?: string;
      clientType?: ClientIdentifier["type"];
    },
  ): Promise<RateLimitResult> {
    const startTime = Date.now();
    let result: RateLimitResult;

    try {
      // Validate inputs
      this.validateInputs(identifier, algorithm, options);

      // Determine which algorithm and options to use
      const { algorithm: finalAlgorithm, options: finalOptions } =
        this.determineAlgorithmAndOptions(algorithm, options, context);

      // Create algorithm instance
      const algorithmInstance = this.createAlgorithm(
        finalAlgorithm,
        finalOptions,
      );

      // Execute rate limit check
      result = await algorithmInstance.checkLimit(
        identifier,
        options?.defaultWeight || 1,
      );

      // Update metrics
      this.updateMetrics(result, finalAlgorithm, startTime, identifier);

      // Throw error if limit exceeded
      if (!result.success) {
        throw new RateLimitExceededError(
          finalOptions.message || "Too many requests, please try again later.",
          result.retryAfter,
          result.resetTime,
          result.limit,
          result.remaining,
          finalOptions.windowMs,
        );
      }

      logger.debug("Rate limit check passed", {
        identifier,
        algorithm: finalAlgorithm,
        remaining: result.remaining,
        limit: result.limit,
      });

      return result;
    } catch (error) {
      // Handle rate limit exceeded errors specially
      if (error instanceof RateLimitExceededError) {
        throw error;
      }

      // Handle store errors with potential fallback
      if (error instanceof StoreError && this.config.fallbackToMemory) {
        logger.warn("Store error, falling back to memory store", {
          error: error.message,
          identifier,
        });

        // Fallback to memory store with more restrictive limits
        return await this.fallbackCheck(identifier, algorithm, options);
      }

      // Log and rethrow other errors
      logger.error("Rate limit check failed:", {
        identifier,
        algorithm,
        error: error instanceof Error ? error.message : "Unknown error",
      });

      throw error;
    }
  }

  /**
   * Validate input parameters
   */
  private validateInputs(
    identifier: string,
    algorithm?: AlgorithmType,
    options?: Partial<RateLimitOptions>,
  ): void {
    if (!identifier || identifier.trim().length === 0) {
      throw new InvalidRequestError(
        "identifier",
        identifier,
        "Identifier cannot be empty",
      );
    }

    if (identifier.length > 256) {
      throw new InvalidRequestError(
        "identifier",
        identifier,
        "Identifier too long (max 256 chars)",
      );
    }

    if (algorithm && !this.algorithms.has(algorithm)) {
      throw new AlgorithmNotImplementedError(
        algorithm,
        Array.from(this.algorithms.keys()),
      );
    }

    if (options?.limit !== undefined && options.limit <= 0) {
      throw new InvalidRequestError(
        "limit",
        options.limit,
        "Limit must be positive",
      );
    }

    if (options?.windowMs !== undefined && options.windowMs <= 0) {
      throw new InvalidRequestError(
        "windowMs",
        options.windowMs,
        "Window must be positive",
      );
    }

    if (options?.defaultWeight !== undefined && options.defaultWeight <= 0) {
      throw new InvalidRequestError(
        "defaultWeight",
        options.defaultWeight,
        "Weight must be positive",
      );
    }
  }

  /**
   * Determine which algorithm and options to use based on context
   */
  private determineAlgorithmAndOptions(
    requestedAlgorithm?: AlgorithmType,
    requestedOptions?: Partial<RateLimitOptions>,
    context?: {
      path?: string;
      method?: string;
      clientType?: ClientIdentifier["type"];
    },
  ): {
    algorithm: AlgorithmType;
    options: RateLimitOptions;
  } {
    // Check if any rule matches the context
    if (context?.path && context?.method) {
      const matchingRule = this.config.rules.find((rule) =>
        this.matchesRule(
          rule,
          context.path!,
          context.method!,
          context.clientType,
        ),
      );

      if (matchingRule) {
        logger.debug("Using rule-based rate limiting", {
          path: context.path,
          method: context.method,
          rule: matchingRule.path,
        });

        return {
          algorithm: matchingRule.algorithm,
          options: {
            limit: matchingRule.limit,
            windowMs: matchingRule.windowMs,
            algorithm: matchingRule.algorithm,
            ...requestedOptions, // Override with request-specific options
          },
        };
      }
    }

    // Use requested or default algorithm
    const algorithm = requestedAlgorithm || this.config.defaultAlgorithm;

    // Merge requested options with defaults
    const options: RateLimitOptions = {
      limit: requestedOptions?.limit || this.config.defaultLimit,
      windowMs: requestedOptions?.windowMs || this.config.defaultWindowMs,
      algorithm,
      ...requestedOptions,
    };

    return { algorithm, options };
  }

  /**
   * Check if a request matches a rule
   */
  private matchesRule(
    rule: RateLimitRule,
    path: string,
    method: string,
    clientType?: ClientIdentifier["type"],
  ): boolean {
    // Check path pattern (simple wildcard matching)
    const pathRegex = new RegExp("^" + rule.path.replace(/\*/g, ".*") + "$");
    if (!pathRegex.test(path)) {
      return false;
    }

    // Check HTTP method
    if (
      !rule.methods.includes(method.toUpperCase()) &&
      !rule.methods.includes("*")
    ) {
      return false;
    }

    // Check client type
    if (clientType && !rule.clientTypes.includes(clientType)) {
      return false;
    }

    return true;
  }

  /**
   * Create algorithm instance
   */
  private createAlgorithm(
    algorithmType: AlgorithmType,
    options: RateLimitOptions,
  ): RateLimiterAlgorithm {
    const AlgorithmClass = this.algorithms.get(algorithmType);

    if (!AlgorithmClass) {
      throw new AlgorithmNotImplementedError(
        algorithmType,
        Array.from(this.algorithms.keys()),
      );
    }

    return new AlgorithmClass(this.store, options);
  }

  /**
   * Update metrics after a rate limit check
   */
  private updateMetrics(
    result: RateLimitResult,
    algorithm: AlgorithmType,
    startTime: number,
    identifier: string,
  ): void {
    if (!this.config.enableMetrics) return;

    const responseTime = Date.now() - startTime;

    // Update basic metrics
    this.metrics.totalRequests++;
    if (result.success) {
      this.metrics.allowedRequests++;
    } else {
      this.metrics.blockedRequests++;

      // Update top blocked clients
      const clientIndex = this.metrics.topBlockedClients.findIndex(
        (c) => c.identifier === identifier,
      );

      if (clientIndex >= 0) {
        this.metrics.topBlockedClients[clientIndex].count++;
      } else {
        this.metrics.topBlockedClients.push({
          identifier,
          count: 1,
        });
      }

      // Keep only top 10
      this.metrics.topBlockedClients.sort((a, b) => b.count - a.count);
      if (this.metrics.topBlockedClients.length > 10) {
        this.metrics.topBlockedClients.pop();
      }
    }

    // Update algorithm usage
    this.metrics.algorithmUsage[algorithm]++;

    // Update average response time (moving average)
    this.metrics.averageResponseTime =
      (this.metrics.averageResponseTime * (this.metrics.totalRequests - 1) +
        responseTime) /
      this.metrics.totalRequests;
  }

  /**
   * Fallback check using memory store when Redis fails
   */
  private async fallbackCheck(
    identifier: string,
    algorithm?: AlgorithmType,
    options?: Partial<RateLimitOptions>,
  ): Promise<RateLimitResult> {
    // Create in-memory store for fallback
    const memoryStore = new (
      await import("../core/store/redis-store")
    ).MemoryStore();

    try {
      // Use more restrictive limits for fallback
      const fallbackOptions: RateLimitOptions = {
        limit: Math.floor((options?.limit || this.config.defaultLimit) / 2),
        windowMs: options?.windowMs || this.config.defaultWindowMs,
        algorithm: algorithm || this.config.defaultAlgorithm,
        message: "Rate limit service degraded. Please try again later.",
      };

      const algorithmInstance = this.createAlgorithm(
        fallbackOptions.algorithm,
        fallbackOptions,
      );

      // Replace store temporarily
      const originalStore = this.store;
      (algorithmInstance as any).store = memoryStore;

      const result = await algorithmInstance.checkLimit(identifier);

      // Restore original store
      (algorithmInstance as any).store = originalStore;
      await memoryStore.close();

      return result;
    } catch (error) {
      await memoryStore.close();
      throw error;
    }
  }

  /**
   * Reset rate limit for a specific client
   * Useful for admin operations or testing
   */
  public async resetClient(identifier: string): Promise<void> {
    try {
      await this.store.resetClient(identifier);
      logger.info("Reset rate limits for client", { identifier });
    } catch (error) {
      logger.error("Failed to reset client rate limits:", {
        identifier,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      throw error;
    }
  }

  /**
   * Update service configuration dynamically
   */
  public updateConfig(config: Partial<RateLimitServiceConfig>): void {
    this.config = {
      ...this.config,
      ...config,
    };

    // Re-sort rules if they were updated
    if (config.rules) {
      this.config.rules.sort((a, b) => b.priority - a.priority);
    }

    // Restart cleanup timer if interval changed
    if (config.cleanupInterval !== undefined) {
      if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
      }
      if (this.config.cleanupInterval > 0) {
        this.startCleanupTimer();
      }
    }

    logger.info("Rate limit service configuration updated", {
      ruleCount: this.config.rules.length,
      cleanupInterval: this.config.cleanupInterval,
    });
  }

  /**
   * Start cleanup timer for periodic maintenance
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(async () => {
      try {
        await this.performCleanup();
      } catch (error) {
        logger.error("Cleanup failed:", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }, this.config.cleanupInterval);
  }

  /**
   * Perform periodic cleanup of old data
   */
  private async performCleanup(): Promise<void> {
    logger.debug("Starting rate limit cleanup");

    // This would typically involve:
    // 1. Cleaning up old metrics data
    // 2. Archiving old rate limit data
    // 3. Compacting storage

    logger.debug("Rate limit cleanup completed");
  }

  /**
   * Get current metrics
   */
  public getMetrics(): RateLimitMetrics {
    return { ...this.metrics }; // Return copy to prevent mutation
  }

  /**
   * Reset metrics (useful for testing)
   */
  public resetMetrics(): void {
    this.metrics = {
      totalRequests: 0,
      allowedRequests: 0,
      blockedRequests: 0,
      averageResponseTime: 0,
      algorithmUsage: {
        "token-bucket": 0,
        "fixed-window": 0,
        "sliding-window": 0,
        "leaky-bucket": 0,
      },
      topBlockedClients: [],
    };
  }

  /**
   * Get service health status
   */
  public async getHealth(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    storeHealth: boolean;
    metrics: RateLimitMetrics;
  }> {
    const storeHealth = await this.store.isHealthy();

    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    if (!storeHealth) {
      status = this.config.fallbackToMemory ? "degraded" : "unhealthy";
    }

    if (
      this.metrics.blockedRequests / Math.max(this.metrics.totalRequests, 1) >
      0.5
    ) {
      status = "degraded"; // High blocking rate
    }

    return {
      status,
      storeHealth,
      metrics: this.getMetrics(),
    };
  }

  /**
   * Close service and clean up resources
   */
  public async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    await this.store.close();

    logger.info("Rate limit service closed");
  }
}
