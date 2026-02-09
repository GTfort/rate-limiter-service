/**
 * Token Bucket Algorithm Implementation
 *
 * This algorithm is useful for:
 * - Bursty traffic patterns
 * - Smoothing out request spikes
 * - Allowing short bursts within limits
 *
 * Concept:
 * - Tokens are added to the bucket at a constant rate
 * - Each request consumes one or more tokens
 * - If bucket is empty, request is rejected
 */

import { RateLimiterAlgorithm } from "./base";
import { RateLimitOptions } from "../../types";

export class TokenBucketAlgorithm extends RateLimiterAlgorithm {
  private refillRate: number; // Tokens per second
  private burstCapacity: number; // Maximum tokens in bucket

  constructor(
    store: Store,
    options: RateLimitOptions & { burstCapacity?: number },
  ) {
    super(store, options);
    // Calculate refill rate: limit tokens per window
    this.refillRate = this.options.limit / (this.options.windowMs / 1000);
    // Burst capacity allows temporary exceeding of average rate
    this.burstCapacity = options.burstCapacity || this.options.limit * 2;
  }

  protected async tryRequest(
    identifier: string,
    weight: number = 1,
  ): Promise<{
    success: boolean;
    remaining: number;
    resetTime: number;
    limit: number;
  }> {
    const now = Date.now();
    const key = `tokenbucket:${identifier}`;

    /**
     * We use a Redis Lua script for atomic operations:
     * 1. Get current token count and last update time
     * 2. Calculate new tokens added since last update
     * 3. Ensure token count doesn't exceed burst capacity
     * 4. Check if enough tokens for current request
     * 5. Update token count and timestamp
     *
     * This atomicity prevents race conditions in distributed systems
     */
    const luaScript = `
      local key = KEYS[1]
      local weight = tonumber(ARGV[1])
      local burst = tonumber(ARGV[2])
      local rate = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])
      local window = tonumber(ARGV[5])

      -- Get current state from Redis
      local data = redis.call('HMGET', key, 'tokens', 'timestamp')
      local tokens = data[1]
      local lastUpdate = data[2]

      -- Initialize if first request
      if not tokens then
        tokens = burst
        lastUpdate = now
      else
        tokens = tonumber(tokens)
        lastUpdate = tonumber(lastUpdate)

        -- Calculate tokens added since last update
        local timePassed = (now - lastUpdate) / 1000  -- Convert to seconds
        local newTokens = timePassed * rate

        -- Refill bucket, but don't exceed burst capacity
        tokens = math.min(burst, tokens + newTokens)
      end

      -- Check if request can be processed
      local success = false
      if tokens >= weight then
        tokens = tokens - weight
        success = true
      end

      -- Update Redis with new state
      redis.call('HMSET', key,
        'tokens', tokens,
        'timestamp', now
      )

      -- Set expiration to automatically clean up inactive users
      redis.call('EXPIRE', key, window)

      -- Return results
      return {success and 1 or 0, math.floor(tokens)}
    `;

    const result = await this.store.eval(
      luaScript,
      1,
      key,
      weight.toString(),
      this.burstCapacity.toString(),
      this.refillRate.toString(),
      now.toString(),
      Math.ceil(this.options.windowMs / 1000).toString(),
    );

    const [success, remainingTokens] = result as [number, number];

    return {
      success: success === 1,
      remaining: Math.max(0, remainingTokens),
      resetTime: now + this.options.windowMs,
      limit: this.burstCapacity,
    };
  }
}
