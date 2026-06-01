// logger.js
import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';
import { inspect } from 'util';

// AsyncLocalStorage to track per-request logging suppression
const loggingContext = new AsyncLocalStorage();

// Winston format that drops non-error logs when suppression is enabled in the current async context
const suppressNonErrorFormat = winston.format((info) => {
    const store = loggingContext.getStore();
    if (store && store.suppressNonErrorLogs === true && info.level !== 'error') {
        return false; // drop this log entry
    }
    return info; // keep
});

export const normalizeLogMessage = value => {
    if (value instanceof Error) {
        return value.stack || value.message;
    }
    if (typeof value === 'string') {
        return value;
    }
    try {
        const json = JSON.stringify(value);
        if (json !== undefined) return json;
    } catch {
        // Fall through to inspect below.
    }
    return inspect(value, { breakLength: Infinity, compact: true });
};

export const formatLogLine = info => {
    const timestamp = info.timestamp || new Date().toISOString();
    const message = String(normalizeLogMessage(info.stack || info.message) ?? '')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');

    return `${timestamp} ${info.level}: ${message}`;
};

const standardFormat = winston.format.combine(
    suppressNonErrorFormat(),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.timestamp(),
    winston.format.printf(formatLogLine)
);

const validLogLevels = new Set(['error', 'warn', 'info', 'http', 'verbose', 'debug', 'silly']);

const getConfiguredLogLevel = () => {
    const configured = process.env.CORTEX_LOG_LEVEL?.toLowerCase();
    if (validLogLevels.has(configured)) {
        return configured;
    }
    if (process.env.NODE_ENV === 'production') return 'info';
    if (process.env.NODE_ENV === 'debug') return 'debug';
    if (process.env.NODE_ENV === 'development') return 'info';
    return 'verbose';
};

const isLoggingSilent = () => process.env.CORTEX_LOG_LEVEL?.toLowerCase() === 'silent';

const getTransport = () => {
    const transportOptions = {
        level: getConfiguredLogLevel(),
        format: standardFormat,
        silent: isLoggingSilent(),
    };

    switch (process.env.NODE_ENV) {
      case 'production':
      case 'development':
      case 'debug':
      case 'test':
        return new winston.transports.Console(transportOptions);
      default:
        // Default to development settings if NODE_ENV is not set or unknown
        if (!isLoggingSilent()) {
            console.warn(`Unknown NODE_ENV: ${process.env.NODE_ENV}. Defaulting to development settings.`);
        }
        return new winston.transports.Console(transportOptions);
    }
};

// Create the logger
const logger = winston.createLogger({
    level: getConfiguredLogLevel(),
    silent: isLoggingSilent(),
    transports: [getTransport()]
});

// Function to obscure sensitive URL parameters
export const obscureUrlParams = url => {
    try {
        const urlObject = new URL(url);
        urlObject.searchParams.forEach((value, name) => {
            if (/token|key|password|secret|auth|apikey|access|passwd|credential/i.test(name)) {
                urlObject.searchParams.set(name, '******');
            }
        });
        return urlObject.toString();
    } catch (e) {
        if (e instanceof TypeError) {
            logger.error('Error obscuring URL parameters - invalid URL.');
            return url;
        } else {
            throw e;
        }
    }
};

// Run a function with non-error logs suppressed for the current async execution context
export const withRequestLoggingDisabled = fn => loggingContext.run({ suppressNonErrorLogs: true }, fn);

export default logger;
