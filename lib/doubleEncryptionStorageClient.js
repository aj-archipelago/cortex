import Keyv from 'keyv';
import { config } from '../config.js';
import { encrypt, decrypt, doubleEncrypt, doubleDecrypt } from './crypto.js';
import logger from './logger.js';

const storageConnectionString = config.get('storageConnectionString');
const cortexId = config.get('cortexId');
const redisEncryptionKey = config.get('redisEncryptionKey');

// Create a keyv client to store data with double encryption support
const doubleEncryptionStorageClient = new Keyv(storageConnectionString, {
    ssl: true,
    abortConnect: false,
    serialize: (data) => JSON.stringify(data),
    deserialize: (data) => {
        try {
            return JSON.parse(data);
        } catch (error) {
            logger.error(`Failed to parse stored data: ${error}`);
            return {};
        }
    },
    namespace: `${cortexId}-cortex-context`
});

// Handle Redis connection errors to prevent crashes
doubleEncryptionStorageClient.on('error', (error) => {
    logger.error(`Keyv Redis connection error: ${error}`);
});

// Set values with double encryption support
async function setvWithDoubleEncryption(key, value, userContextKey) {
    if (!doubleEncryptionStorageClient) return false;
    
    // Validate that system key is present
    if (!redisEncryptionKey) {
        logger.error('System encryption key is required but not configured');
        return false;
    }
    
    try {
        // Always use doubleEncrypt which handles both scenarios:
        // 1. systemKey only (when userContextKey is null/undefined)
        // 2. userContextKey + systemKey (when userContextKey is provided)
        const encryptedValue = doubleEncrypt(JSON.stringify(value), userContextKey, redisEncryptionKey);
            
        if (!encryptedValue) {
            logger.error('Encryption failed, cannot store data');
            return false;
        }
        
        return await doubleEncryptionStorageClient.set(key, encryptedValue);
    } catch (error) {
        logger.error(`Failed to store data with double encryption: ${error}`);
        return false;
    }
}

// Get values with double decryption support
async function getvWithDoubleDecryption(key, userContextKey) {
    if (!doubleEncryptionStorageClient) return null;
    
    // Validate that system key is present
    if (!redisEncryptionKey) {
        logger.error('System encryption key is required but not configured');
        return null;
    }
    
    try {
        const encryptedData = await doubleEncryptionStorageClient.get(key);
        if (!encryptedData) return null;
        
        // Always use doubleDecrypt which handles both scenarios:
        // 1. systemKey only (when userContextKey is null/undefined)
        // 2. userContextKey + systemKey (when userContextKey is provided)
        const decryptedData = doubleDecrypt(encryptedData, userContextKey, redisEncryptionKey);
        if (decryptedData) {
            return JSON.parse(decryptedData);
        }
        
        // If decryption fails, try to parse as plain JSON (for backward compatibility with unencrypted data)
        try {
            return JSON.parse(encryptedData);
        } catch {
            return encryptedData;
        }
    } catch (error) {
        logger.error(`Failed to retrieve and decrypt data: ${error}`);
        return null;
    }
}

export {
    doubleEncryptionStorageClient,
    setvWithDoubleEncryption,
    getvWithDoubleDecryption
};
