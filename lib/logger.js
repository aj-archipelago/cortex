// logger.js
import winston from 'winston';
import { AsyncLocalStorage } from 'async_hooks';

winston.addColors({
    debug: 'green',
    verbose: 'blue',
    http: 'gray',
    info: 'cyan',
    warn: 'yellow',
    error: 'red'
});

const debugFormat = winston.format.combine(
    winston.format.colorize({ all: true }),
    winston.format.cli()
);

const prodFormat = winston.format.combine(
    winston.format.simple()
);

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

const getTransport = () => {
    switch (process.env.NODE_ENV) {
      case 'production':
        return new winston.transports.Console({ level: 'info', format: winston.format.combine(suppressNonErrorFormat(), prodFormat) });
      case 'development':
        return new winston.transports.Console({ level: 'verbose', format: winston.format.combine(suppressNonErrorFormat(), debugFormat) });
      case 'debug':
        case 'test':
        return new winston.transports.Console({ level: 'debug', format: winston.format.combine(suppressNonErrorFormat(), debugFormat) });
      default:
        // Default to development settings if NODE_ENV is not set or unknown
        console.warn(`Unknown NODE_ENV: ${process.env.NODE_ENV}. Defaulting to development settings.`);
        return new winston.transports.Console({ level: 'verbose', format: winston.format.combine(suppressNonErrorFormat(), debugFormat) });
    }
};

// Create the logger
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 
           process.env.NODE_ENV === 'debug' ? 'debug' : 'verbose',
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