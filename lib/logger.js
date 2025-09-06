// logger.js
import winston from 'winston';

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

const getTransport = () => {
    switch (process.env.NODE_ENV) {
      case 'production':
        return new winston.transports.Console({ level: 'info', format: prodFormat });
      case 'development':
      case 'test':
        return new winston.transports.Console({ level: 'verbose', format: debugFormat });
      case 'debug':
        return new winston.transports.Console({ level: 'debug', format: debugFormat });
      default:
        // Default to development settings if NODE_ENV is not set or unknown
        console.warn(`Unknown NODE_ENV: ${process.env.NODE_ENV}. Defaulting to development settings.`);
        return new winston.transports.Console({ level: 'verbose', format: debugFormat });
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

export default logger;