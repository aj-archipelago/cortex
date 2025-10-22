// This file is used to encrypt and decrypt data using the crypto library
import logger from './logger.js';
import crypto from 'crypto';

// Encryption function
function encrypt(text, key) {
    if (!key) { return text; }
    try {
        key = tryBufferKey(key);
        let iv = crypto.randomBytes(16);
        let cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
        logger.error(`Encryption failed: ${error.message}`);
        return null;
    }
}

// Decryption function
function decrypt(message, key) {
    if (!key) { return message; }
    try {
        key = tryBufferKey(key);
        let parts = message.split(':');
        let iv = Buffer.from(parts.shift(), 'hex');
        let encrypted = parts.join(':');
        let decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        logger.error(`Decryption failed: ${error.message}`);
        return null;
    }
}

// Double encryption: encrypt with user key first, then system key
function doubleEncrypt(data, userContextKey, systemKey) {
    if (!systemKey) {
        logger.error('System key is required for encryption');
        return null;
    }
    
    if (!userContextKey) {
        // If no user key provided, use single-layer encryption with system key
        return encrypt(data, systemKey);
    }
    
    try {
        // First encrypt with user's contextKey
        const userEncrypted = encrypt(data, userContextKey);
        if (!userEncrypted) {
            logger.error('User encryption failed, falling back to system encryption only');
            return encrypt(data, systemKey);
        }
        
        // Then encrypt with system key
        return encrypt(userEncrypted, systemKey);
    } catch (error) {
        logger.error(`Double encryption failed: ${error.message}`);
        // Fallback to single-layer system encryption
        return encrypt(data, systemKey);
    }
}

// Double decryption: decrypt with system key first, then user key
function doubleDecrypt(encryptedData, userContextKey, systemKey) {
    if (!systemKey) {
        logger.error('System key is required for decryption');
        return null;
    }
    
    if (!userContextKey) {
        // If no user key provided, use single-layer decryption with system key
        return decrypt(encryptedData, systemKey);
    }
    
    try {
        // First decrypt with system key
        const systemDecrypted = decrypt(encryptedData, systemKey);
        if (!systemDecrypted) {
            logger.error('System decryption failed');
            return null;
        }
        
        // Try to decrypt with user's contextKey
        const userDecrypted = decrypt(systemDecrypted, userContextKey);
        if (userDecrypted) {
            // Successfully double-decrypted
            return userDecrypted;
        }
        
        // User decryption failed, but system decryption succeeded
        // This means the data was single-encrypted with system key only
        return systemDecrypted;
    } catch (error) {
        logger.error(`Double decryption failed: ${error.message}`);
        return null;
    }
}

function tryBufferKey(key) {
    if (key.length === 64) {
        return Buffer.from(key, 'hex');
    }   
    return key;
}

export { encrypt, decrypt, doubleEncrypt, doubleDecrypt };