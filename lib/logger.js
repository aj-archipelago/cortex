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

const getTransport = () => {
    switch (process.env.NODE_ENV) {
      case 'production':
        return new winston.transports.Console({ level: 'info', format: standardFormat });
      case 'development':
        return new winston.transports.Console({ level: 'info', format: standardFormat });
      case 'debug':
      case 'test':
        return new winston.transports.Console({ level: 'debug', format: standardFormat });
      default:
        // Default to development settings if NODE_ENV is not set or unknown
        console.warn(`Unknown NODE_ENV: ${process.env.NODE_ENV}. Defaulting to development settings.`);
        return new winston.transports.Console({ level: 'verbose', format: standardFormat });
    }
};

// Create the logger
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 
           process.env.NODE_ENV === 'debug' ? 'debug' :
           process.env.NODE_ENV === 'development' ? 'info' : 'verbose',
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
