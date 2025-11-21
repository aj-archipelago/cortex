import Keyv from 'keyv';
import { config } from '../config.js';
import { encrypt, decrypt } from './crypto.js';
import logger from './logger.js';

const storageConnectionString = config.get('storageConnectionString');
const cortexId = config.get('cortexId');
const redisEncryptionKey = config.get('redisEncryptionKey');

// Create a keyv client to store data
const keyValueStorageClient = new Keyv(storageConnectionString, {
    ssl: true,
    abortConnect: false,
    serialize: (data) => redisEncryptionKey ? encrypt(JSON.stringify(data), redisEncryptionKey) : JSON.stringify(data),
    deserialize: (data) => {
        try {
            // Try to parse the data normally
            return JSON.parse(data);
        } catch (error) {
            // If it fails, the data may be encrypted so attempt to decrypt it if we have a key
            try {
                return JSON.parse(decrypt(data, redisEncryptionKey));
            } catch (decryptError) {
                // If decryption also fails, log an error and return an empty object
                logger.error(`Failed to parse or decrypt stored key value data: ${decryptError}`);
                return {};
            }
        }
    },
    namespace: `${cortexId}-cortex-context`
});

// Handle Redis connection errors to prevent crashes
keyValueStorageClient.on('error', (error) => {
    logger.error(`Keyv Redis connection error: ${error}`);
});

// Set values to keyv
async function setv(key, value) {
    return keyValueStorageClient && (await keyValueStorageClient.set(key, value));
}

// Get values from keyv
async function getv(key) {
    return keyValueStorageClient && (await keyValueStorageClient.get(key));
}

// Set values to keyv with additional context key encryption
async function setvWithDoubleEncryption(key, value, contextKey) {
    let processedValue = value;
    
    // If contextKey exists and is not empty, encrypt the value with it
    // Skip encryption for empty strings (they're already "cleared" and don't need encryption overhead)
    if (contextKey && contextKey.trim() !== '' && value !== null && value !== undefined && value !== '') {
        try {
            // Convert value to string for encryption
            const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
            processedValue = encrypt(stringValue, contextKey);
        } catch (error) {
            logger.error(`Context key encryption failed: ${error.message}`);
            // Continue with unencrypted value if context encryption fails
        }
    }
    
    return keyValueStorageClient && (await keyValueStorageClient.set(key, processedValue));
}

// Get values from keyv with additional context key decryption
async function getvWithDoubleDecryption(key, contextKey) {
    const result = keyValueStorageClient && (await keyValueStorageClient.get(key));
    
    if (result === null || result === undefined) {
        return result;
    }
    
    // If contextKey exists and is not empty, try to decrypt the result with it
    if (contextKey && contextKey.trim() !== '') {
        try {
            // Try to decrypt with context key
            const decrypted = decrypt(result, contextKey);
            // Check for null (error) but allow empty strings (valid decrypted value)
            if (decrypted !== null) {
                // Try to parse as JSON, if it fails return the string as-is
                try {
                    return JSON.parse(decrypted);
                } catch (parseError) {
                    return decrypted;
                }
            }
        } catch (error) {
            // If context decryption fails, the data might not be context-encrypted
            // or the context key might be wrong, so return the result as-is
            logger.debug(`Context key decryption failed, returning original data: ${error.message}`);
        }
    }
    
    return result;
}

export {
    keyValueStorageClient,
    setv,
    getv,
    setvWithDoubleEncryption,
    getvWithDoubleDecryption
};
