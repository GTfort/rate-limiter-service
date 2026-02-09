/**
 * Abstract Base Class for Rate Limiting Algorithms
 *
 * Implements the Template Method Pattern where subclasses
 * implement the specific algorithm logic while this class
 * handles common functionality like key generation and response formatting.
 */

import { Store } from "../store/redis-store";
import { RateLimitResult, RateLimitOptions, AlgorithmType } from "../../types";

export abstract class RateLimiterAlgorithm {
  protected store: Store;
  protected options: RateLimitOptions;

  constructor(store: Store, options: RateLimitOptions) {
    this.store = store;
    this.options = options;
  }

  /**
   * Template Method Pattern:
   * Subclasses MUST implement this method with their specific algorithm
   */
  protected abstract async tryRequest(
    identifier: string,
    weight?: number,
  ): Promise<{
    success: boolean;
    remaining: number;
    resetTime: number;
    limit: number;
  }>;

  /**
   * Public method that follows the template
   * 1. Validates input
   * 2. Executes algorithm-specific logic
   * 3. Formats response consistently
   */
  public async checkLimit(
    identifier: string,
    weight: number = 1,
  ): Promise<RateLimitResult> {
    // Input validation
    if (weight <= 0) {
      throw new Error("Request weight must be positive");
    }

    if (weight > this.options.limit) {
      // Single request exceeds limit
      return {
        success: false,
        limit: this.options.limit,
        remaining: 0,
        resetTime: Math.floor(Date.now() / 1000) + this.options.windowMs / 1000,
        retryAfter: Math.ceil(this.options.windowMs / 1000),
      };
    }

    // Delegate to algorithm-specific implementation
    const result = await this.tryRequest(identifier, weight);

    // Format consistent response
    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      resetTime: result.resetTime,
      retryAfter: result.success
        ? 0
        : Math.ceil(result.resetTime - Date.now() / 1000),
    };
  }

  /**
   * Generates Redis key based on identifier and window
   * Format: ratelimit:{identifier}:{windowStart}
   *
   * This ensures keys are automatically expired by Redis TTL
   */
  protected generateKey(identifier: string, windowStart: number): string {
    return `ratelimit:${identifier}:${windowStart}`;
  }

  /**
   * Calculates current window start time
   * Used by Fixed Window and Token Bucket algorithms
   */
  protected getCurrentWindowStart(): number {
    const now = Date.now();
    return Math.floor(now / this.options.windowMs) * this.options.windowMs;
  }

  /**
   * Resets the limit for a specific identifier
   * Useful for admin operations or testing
   */
  public async reset(identifier: string): Promise<void> {
    const windowStart = this.getCurrentWindowStart();
    const key = this.generateKey(identifier, windowStart);
    await this.store.resetKey(key);
  }
}
