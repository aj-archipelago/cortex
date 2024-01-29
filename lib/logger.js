// logger.js
import winston from 'winston';

const format = winston.format.combine(
    //winston.format.timestamp(),
    winston.format.colorize({ all: true }),
    winston.format.simple()
);

const transports = [
    new winston.transports.Console({ format })
];

const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: format,
    transports: transports
});

winston.addColors({
    debug: 'green',
    verbose: 'blue',
    http: 'gray',
    info: 'cyan',
    warn: 'yellow',
    error: 'red'
});

export default logger;