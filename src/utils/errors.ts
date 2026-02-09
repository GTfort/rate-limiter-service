/**
 * Custom Error Classes for Rate Limiting Service
 *
 * Extending Error with additional properties allows for
 * more detailed error handling and consistent error responses.
 */

/**
 * Base custom error class for all application errors
 * Provides consistent structure for error handling middleware
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly timestamp: number;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = true; // Default operational status
    this.timestamp = Date.now();

    // Maintains proper stack trace for where our error was thrown
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Rate limit exceeded error
 *
 * This error is thrown when a client exceeds their rate limit.
 * It includes metadata that can be used to inform the client
 * when they can retry their request.
 */
export class RateLimitExceededError extends AppError {
  public readonly retryAfter: number;
  public readonly resetTime: number;
  public readonly limit: number;
  public readonly remaining: number;
  public readonly windowMs: number;

  constructor(
    message: string = "Too many requests, please try again later.",
    retryAfter: number,
    resetTime: number,
    limit: number,
    remaining: number = 0,
    windowMs: number,
  ) {
    super(message, 429); // HTTP 429 Too Many Requests

    this.retryAfter = retryAfter;
    this.resetTime = resetTime;
    this.limit = limit;
    this.remaining = remaining;
    this.windowMs = windowMs;

    // Additional properties for error responses
    Object.setPrototypeOf(this, RateLimitExceededError.prototype);
  }

  /**
   * Convert error to a JSON-serializable format
   * Useful for API responses
   */
  public toJSON() {
    return {
      error: this.name,
      message: this.message,
      statusCode: this.statusCode,
      retryAfter: this.retryAfter,
      resetTime: new Date(this.resetTime * 1000).toISOString(),
      limit: this.limit,
      remaining: this.remaining,
      windowMs: this.windowMs,
      timestamp: new Date(this.timestamp).toISOString(),
    };
  }

  /**
   * Create appropriate HTTP headers from error data
   * Following RFC 6585 and common API standards
   */
  public getHeaders() {
    return {
      "Retry-After": this.retryAfter.toString(),
      "X-RateLimit-Limit": this.limit.toString(),
      "X-RateLimit-Remaining": this.remaining.toString(),
      "X-RateLimit-Reset": this.resetTime.toString(),
      "X-RateLimit-Window": this.windowMs.toString(),
    };
  }
}

/**
 * Redis connection error
 *
 * Thrown when there are issues connecting to Redis.
 * This is an operational error that should trigger
 * fallback mechanisms.
 */
export class RedisConnectionError extends AppError {
  public readonly host: string;
  public readonly port: number;

  constructor(
    message: string = "Unable to connect to Redis",
    host: string = "unknown",
    port: number = 6379,
  ) {
    super(message, 503); // HTTP 503 Service Unavailable

    this.host = host;
    this.port = port;
    (this as any).isOperational = true; // This is an expected operational error

    Object.setPrototypeOf(this, RedisConnectionError.prototype);
  }
}

/**
 * Configuration error
 *
 * Thrown when there are issues with rate limiter configuration.
 * This should be caught during startup or configuration reload.
 */
export class ConfigurationError extends AppError {
  public readonly configPath: string;
  public readonly configValue: any;

  constructor(message: string, configPath: string, configValue: any) {
    super(message, 500);

    this.configPath = configPath;
    this.configValue = configValue;
    (this as any).isOperational = true;

    Object.setPrototypeOf(this, ConfigurationError.prototype);
  }
}

/**
 * Invalid request error for rate limiting
 *
 * Thrown when a rate limit check is requested with invalid parameters.
 * This helps with debugging and prevents malformed requests.
 */
export class InvalidRequestError extends AppError {
  public readonly parameter: string;
  public readonly value: any;
  public readonly reason: string;

  constructor(parameter: string, value: any, reason: string) {
    super(`Invalid request parameter: ${parameter} = ${value}. ${reason}`, 400);

    this.parameter = parameter;
    this.value = value;
    this.reason = reason;

    Object.setPrototypeOf(this, InvalidRequestError.prototype);
  }
}

/**
 * Algorithm not implemented error
 *
 * Thrown when an unsupported or unimplemented algorithm is requested.
 * This allows for graceful degradation or fallback to default algorithm.
 */
export class AlgorithmNotImplementedError extends AppError {
  public readonly algorithm: string;
  public readonly availableAlgorithms: string[];

  constructor(algorithm: string, availableAlgorithms: string[] = []) {
    super(`Rate limiting algorithm '${algorithm}' is not implemented.`, 501); // HTTP 501 Not Implemented

    this.algorithm = algorithm;
    this.availableAlgorithms = availableAlgorithms;

    Object.setPrototypeOf(this, AlgorithmNotImplementedError.prototype);
  }
}

/**
 * Store error wrapper
 *
 * Wraps underlying store errors (like Redis errors) with
 * additional context about the rate limiting operation.
 */
export class StoreError extends AppError {
  public readonly storeType: string;
  public readonly operation: string;
  public readonly key?: string;
  public readonly originalError?: Error;

  constructor(
    storeType: string,
    operation: string,
    message: string,
    key?: string,
    originalError?: Error,
  ) {
    super(message, 503);

    this.storeType = storeType;
    this.operation = operation;
    this.key = key;
    this.originalError = originalError;

    Object.setPrototypeOf(this, StoreError.prototype);
  }
}

/**
 * Helper function to determine if an error is a rate limit error
 * Useful for error handling middleware to apply special handling
 */
export function isRateLimitError(error: any): error is RateLimitExceededError {
  return error instanceof RateLimitExceededError;
}

/**
 * Helper function to determine if an error is operational
 * Operational errors are expected and should not crash the application
 */
export function isOperationalError(error: any): boolean {
  if (error instanceof AppError) {
    return error.isOperational;
  }
  return false;
}
