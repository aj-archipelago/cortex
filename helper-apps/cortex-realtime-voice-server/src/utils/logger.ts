// Logger utility for centralized logging control

// Environment-based logging control
const isProduction = process.env.NODE_ENV === 'production';
let isLoggingEnabled = !isProduction;

export const logger = {
  enable: () => {
    isLoggingEnabled = true;
  },
  
  disable: () => {
    isLoggingEnabled = false;
  },

  log: (...args: any[]) => {
    if (isLoggingEnabled) {
      console.log(...args);
    }
  },

  // Additional logging levels if needed
  debug: (...args: any[]) => {
    if (isLoggingEnabled) {
      console.debug(...args);
    }
  },

  error: (...args: any[]) => {
    // Always log errors, even in production
    console.error(...args);
  },

  warn: (...args: any[]) => {
    if (isLoggingEnabled) {
      console.warn(...args);
    }
  },

  info: (...args: any[]) => {
    if (isLoggingEnabled) {
      console.info(...args);
    }
  }
}; 