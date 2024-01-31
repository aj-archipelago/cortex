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

const transports = process.env.NODE_ENV === 'production' ?
    new winston.transports.Console({ level: 'info', format: prodFormat }) :
    new winston.transports.Console({ level: 'debug', format: debugFormat });

const logger = winston.createLogger({ transports });

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