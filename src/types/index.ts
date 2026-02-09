/**
 * TypeScript definitions for the Rate Limiter Service
 *
 * This file centralizes all type definitions to ensure
 * consistency across the application and provide better
 * IDE autocompletion and type safety.
 */

/**
 * Rate limiting configuration options
 * These define how the rate limiting behaves
 */
export interface RateLimitOptions {
  // Maximum number of requests allowed in the window
  limit: number;

  // Time window in milliseconds
  windowMs: number;

  // Optional algorithm-specific configurations
  algorithm?: AlgorithmType;

  // For Token Bucket: maximum burst capacity
  burstCapacity?: number;

  // For Leaky Bucket: request queue size
  queueSize?: number;

  // Custom error message when limit is exceeded
  message?: string;

  // Whether to skip rate limiting for successful requests
  skipSuccessfulRequests?: boolean;

  // Request weight (for weighted rate limiting)
  defaultWeight?: number;
}

/**
 * Supported rate limiting algorithms
 * Each has different characteristics suitable for different use cases
 */
export type AlgorithmType =
  | "token-bucket" // Smooth bursts, refills over time
  | "fixed-window" // Simple counter per time window
  | "sliding-window" // More accurate but more complex
  | "leaky-bucket"; // Smooth output rate, queue-based

/**
 * Result of a rate limit check
 * Contains all information needed for the client to understand their rate limit status
 */
export interface RateLimitResult {
  success: boolean; // Whether request is allowed
  limit: number; // Maximum requests in window
  remaining: number; // Remaining requests in current window
  resetTime: number; // Unix timestamp (seconds) when limit resets
  retryAfter: number; // Seconds to wait before retrying
  windowStart: number; // Start time of current window (ms)
  windowEnd: number; // End time of current window (ms)
}

/**
 * Client identifier configuration
 * Defines how to identify different clients for rate limiting
 */
export interface ClientIdentifier {
  type: "ip" | "apikey" | "user" | "session";
  value: string;
  prefix?: string; // Optional prefix for Redis key namespacing
}

/**
 * Rate limiting rule configuration
 * Allows different rules for different endpoints or client types
 */
export interface RateLimitRule {
  // Path pattern to match (supports wildcards)
  path: string;

  // HTTP methods to apply to
  methods: string[];

  // Rate limit configuration
  limit: number;
  windowMs: number;

  // Which algorithm to use
  algorithm: AlgorithmType;

  // Priority (higher = checked first)
  priority: number;

  // Client types this rule applies to
  clientTypes: Array<"ip" | "apikey" | "user" | "session">;
}

/**
 * Redis store configuration
 */
export interface RedisStoreConfig {
  prefix: string; // Key prefix for namespacing
  ttl: number; // Default TTL in seconds
  scanCount: number; // Number of keys to scan per iteration
}

/**
 * Metrics collected by the rate limiter
 * Useful for monitoring and alerting
 */
export interface RateLimitMetrics {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  averageResponseTime: number;
  algorithmUsage: Record<AlgorithmType, number>;
  topBlockedClients: Array<{ identifier: string; count: number }>;
}

/**
 * Health check status
 */
export interface HealthStatus {
  status: "healthy" | "degraded" | "unhealthy";
  redis: boolean;
  memory: number;
  uptime: number;
  timestamp: number;
}
