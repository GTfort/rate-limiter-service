/**
 * Express Middleware for Rate Limiting
 *
 * This middleware:
 * 1. Extracts client identifier (IP, API key, user ID)
 * 2. Applies rate limiting based on configuration
 * 3. Sets informative headers
 * 4. Handles rate limit exceeded responses
 */

import { Request, Response, NextFunction } from "express";
import { RateLimitService } from "../../services/rate-limit.service";
import { logger } from "../../utils/logger";
import { RateLimitExceededError } from "../../utils/errors";

export interface RateLimitMiddlewareOptions {
  // Which algorithm to use
  algorithm?:
    | "token-bucket"
    | "sliding-window"
    | "fixed-window"
    | "leaky-bucket";

  // Rate limiting rules
  limit: number; // Max requests
  windowMs: number; // Time window in milliseconds

  // Identifier configuration
  keyGenerator?: (req: Request) => string;
  skipSuccessfulRequests?: boolean;

  // Response customization
  message?: string;
  statusCode?: number;

  // Headers configuration
  enableHeaders?: boolean;
  headerPrefix?: string;
}

export const createRateLimiterMiddleware = (
  rateLimitService: RateLimitService,
  options: RateLimitMiddlewareOptions,
) => {
  /**
   * Default key generator uses:
   * 1. API key from headers (if present)
   * 2. User ID from JWT (if authenticated)
   * 3. IP address as fallback
   */
  const defaultKeyGenerator = (req: Request): string => {
    // Priority 1: API Key
    const apiKey = req.headers["x-api-key"] as string;
    if (apiKey) {
      return `apikey:${apiKey}`;
    }

    // Priority 2: Authenticated User (if using JWT)
    const userId = (req as any).user?.id;
    if (userId) {
      return `user:${userId}`;
    }

    // Priority 3: IP Address
    const ip =
      req.ip ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      ((req.headers["x-forwarded-for"] as string) || "").split(",")[0].trim();

    return `ip:${ip}`;
  };

  const keyGenerator = options.keyGenerator || defaultKeyGenerator;
  const enableHeaders = options.enableHeaders !== false;
  const statusCode = options.statusCode || 429;
  const message =
    options.message || "Too many requests, please try again later.";

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Skip rate limiting for certain requests (health checks, etc.)
      if (req.path === "/health" || req.path === "/metrics") {
        return next();
      }

      // Generate client identifier
      const identifier = keyGenerator(req);

      // Apply rate limiting
      const result = await rateLimitService.checkLimit(
        identifier,
        options.algorithm || "token-bucket",
        {
          limit: options.limit,
          windowMs: options.windowMs,
        },
      );

      // Add rate limit headers to response (RFC 6585)
      if (enableHeaders) {
        const prefix = options.headerPrefix || "RateLimit";

        res.setHeader(`${prefix}-Limit`, result.limit.toString());
        res.setHeader(`${prefix}-Remaining`, result.remaining.toString());
        res.setHeader(`${prefix}-Reset`, result.resetTime.toString());

        if (!result.success) {
          res.setHeader(`${prefix}-Retry-After`, result.retryAfter.toString());
          res.setHeader("Retry-After", result.retryAfter.toString());
        }
      }

      // Handle rate limit exceeded
      if (!result.success) {
        logger.warn(`Rate limit exceeded for ${identifier}`, {
          identifier,
          limit: result.limit,
          remaining: result.remaining,
          resetTime: new Date(result.resetTime * 1000).toISOString(),
          path: req.path,
          method: req.method,
        });

        // Throw custom error that can be caught by error middleware
        throw new RateLimitExceededError(
          message,
          result.retryAfter,
          result.resetTime,
        );
      }

      // Only count successful requests if configured
      if (
        options.skipSuccessfulRequests &&
        res.statusCode >= 200 &&
        res.statusCode < 300
      ) {
        // Don't count successful requests toward limit
        // Implementation depends on your business logic
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};
