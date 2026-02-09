/**
 * Winston Logger Configuration
 *
 * Centralized logging configuration with multiple transports
 * and structured logging for better debugging and monitoring.
 */

import winston from "winston";
import "winston-daily-rotate-file";
import path from "path";

/**
 * Log levels configuration
 * From most severe to least severe:
 * error, warn, info, http, verbose, debug, silly
 */
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
};

/**
 * Determine log level based on environment
 * Development: Show debug and above
 * Production: Show info and above
 */
const getLogLevel = (): string => {
  const env = process.env.NODE_ENV || "development";
  return env === "development" ? "debug" : "info";
};

/**
 * Define colors for different log levels (for console output)
 */
const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  http: "magenta",
  verbose: "cyan",
  debug: "blue",
  silly: "grey",
};

// Add colors to winston
winston.addColors(colors);

/**
 * Define log format
 * Includes timestamp, level, message, and metadata
 */
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss:ms" }),
  winston.format.errors({ stack: true }), // Include error stacks
  winston.format.splat(), // Enable string interpolation
  winston.format.json(), // JSON format for structured logging
);

/**
 * Console transport format (pretty printing for development)
 */
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info;

    // Format metadata if present
    let metaStr = "";
    if (Object.keys(meta).length > 0 && !meta.stack) {
      metaStr = ` ${JSON.stringify(meta, null, 2)}`;
    }

    // Include stack trace for errors
    if (meta.stack) {
      metaStr = `\n${meta.stack}`;
    }

    return `[${timestamp}] ${level}: ${message}${metaStr}`;
  }),
);

/**
 * Create logs directory if it doesn't exist
 */
const ensureLogsDirectory = (): void => {
  const fs = require("fs");
  const logsDir = path.join(process.cwd(), "logs");

  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
};

// Ensure logs directory exists
ensureLogsDirectory();

/**
 * Define transports (where logs are output)
 */
const transports = [
  // Console transport (always enabled)
  new winston.transports.Console({
    format: consoleFormat,
    level: getLogLevel(),
  }),

  // Daily rotate file transport for all logs
  new winston.transports.DailyRotateFile({
    filename: path.join("logs", "application-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    zippedArchive: true,
    maxSize: "20m",
    maxFiles: "14d", // Keep logs for 14 days
    format: logFormat,
    level: getLogLevel(),
  }),

  // Error-only log file
  new winston.transports.DailyRotateFile({
    filename: path.join("logs", "error-%DATE%.log"),
    datePattern: "YYYY-MM-DD",
    zippedArchive: true,
    maxSize: "20m",
    maxFiles: "30d", // Keep error logs for 30 days
    format: logFormat,
    level: "error",
  }),
];

/**
 * Create the logger instance
 */
export const logger = winston.createLogger({
  level: getLogLevel(),
  levels,
  format: logFormat,
  transports,

  // Do not exit on handled exceptions
  exitOnError: false,

  // Handle uncaught exceptions
  exceptionHandlers: [
    new winston.transports.File({
      filename: path.join("logs", "exceptions.log"),
      format: logFormat,
    }),
  ],

  // Handle unhandled rejections
  rejectionHandlers: [
    new winston.transports.File({
      filename: path.join("logs", "rejections.log"),
      format: logFormat,
    }),
  ],
});

/**
 * Create a child logger with additional context
 * Useful for adding request IDs, user IDs, etc.
 */
export const createChildLogger = (context: Record<string, any>) => {
  return logger.child(context);
};

/**
 * Morgan stream for HTTP request logging
 * Integrates with Express morgan middleware
 */
export const morganStream = {
  write: (message: string) => {
    // Remove newline character
    const cleanedMessage = message.replace(/\n$/, "");

    // Parse morgan log format
    const logMatch = cleanedMessage.match(
      /^(\S+) (\S+) (\S+) \[([^\]]+)\] "([^"]+)" (\d+) (\d+) "([^"]+)" "([^"]+)"$/,
    );

    if (logMatch) {
      const [
        ,
        ,
        ,
        ,
        timestamp,
        method,
        url,
        status,
        responseTime,
        referrer,
        userAgent,
      ] = logMatch;

      // Log as HTTP level with structured data
      logger.http("HTTP Request", {
        timestamp,
        method,
        url,
        status: parseInt(status, 10),
        responseTime: parseInt(responseTime, 10),
        referrer,
        userAgent,
      });
    } else {
      // Fallback to info level
      logger.info(cleanedMessage);
    }
  },
};

/**
 * Logging middleware for Express
 * Adds request ID and timing to logs
 */
export const loggingMiddleware = (req: any, res: any, next: any) => {
  const startTime = Date.now();
  const requestId =
    req.id || Date.now().toString(36) + Math.random().toString(36).substr(2);

  // Add request ID to request object
  req.id = requestId;

  // Create child logger with request context
  req.logger = createChildLogger({
    requestId,
    method: req.method,
    url: req.url,
    ip: req.ip,
  });

  // Log request start
  req.logger.info("Request started");

  // Log when response is finished
  res.on("finish", () => {
    const duration = Date.now() - startTime;

    req.logger.info("Request completed", {
      statusCode: res.statusCode,
      duration,
      contentLength: res.get("Content-Length") || 0,
    });
  });

  next();
};

/**
 * Performance logging helper
 * Logs the duration of operations
 */
export const withPerformanceLogging = async <T>(
  operation: string,
  fn: () => Promise<T>,
  context: Record<string, any> = {},
): Promise<T> => {
  const startTime = Date.now();

  try {
    const result = await fn();
    const duration = Date.now() - startTime;

    logger.debug(`Operation '${operation}' completed`, {
      operation,
      duration,
      ...context,
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error(`Operation '${operation}' failed`, {
      operation,
      duration,
      error: error instanceof Error ? error.message : "Unknown error",
      ...context,
    });

    throw error;
  }
};

/**
 * Initialize logger with application metadata
 */
export const initializeLogger = (appName: string, version: string) => {
  logger.defaultMeta = {
    app: appName,
    version,
    environment: process.env.NODE_ENV || "development",
    pid: process.pid,
  };

  logger.info("Logger initialized", {
    app: appName,
    version,
    level: getLogLevel(),
  });
};

// Export default logger instance
export default logger;
