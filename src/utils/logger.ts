import winston from 'winston';
import { botConfig } from '../config';

// Create winston logger instance
const logger = winston.createLogger({
  level: botConfig.logging.level.toLowerCase(),
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaString = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
      return `${timestamp} [${level.toUpperCase()}]: ${message} ${metaString}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      ...(botConfig.logging.maxSizeBytes !== undefined ? { maxsize: botConfig.logging.maxSizeBytes } : {}),
      ...(botConfig.logging.maxFiles !== undefined ? { maxFiles: botConfig.logging.maxFiles } : {})
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      ...(botConfig.logging.maxSizeBytes !== undefined ? { maxsize: botConfig.logging.maxSizeBytes } : {}),
      ...(botConfig.logging.maxFiles !== undefined ? { maxFiles: botConfig.logging.maxFiles } : {})
    })
  ]
});

export const logEvent = (event: string, meta?: Record<string, unknown>): void => {
  const musicalEvent = `🎵 ${event}`;
  
  if (meta) {
    logger.info(musicalEvent, meta);
  } else {
    logger.info(musicalEvent);
  }
};

export const logError = (message: string, error?: Error, meta?: Record<string, unknown>): void => {
  const musicalError = `🎵💥 ${message}`;
  
  const errorMeta = {
    ...meta,
    ...(error && {
      error: error.message,
      stack: error.stack
    })
  };

  logger.error(musicalError, errorMeta);
};

export const logWarning = (message: string, meta?: Record<string, unknown>): void => {
  const musicalWarning = `🎵⚠️ ${message}`;
  
  if (meta) {
    logger.warn(musicalWarning, meta);
  } else {
    logger.warn(musicalWarning);
  }
};

export const logDebug = (message: string, meta?: Record<string, unknown>): void => {
  const musicalDebug = `🎵🔍 ${message}`;
  
  if (meta) {
    logger.debug(musicalDebug, meta);
  } else {
    logger.debug(musicalDebug);
  }
};

export { logger };
