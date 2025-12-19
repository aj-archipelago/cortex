// This file is used to encrypt and decrypt data using the crypto library
import logger from './logger.js';
import crypto from 'crypto';

// Helper function to generate a preview of a message for logging
function getMessagePreview(message, maxLength = 50) {
    if (typeof message === 'string') {
        return message.substring(0, maxLength);
    }
    try {
        return JSON.stringify(message).substring(0, maxLength);
    } catch (e) {
        return String(message).substring(0, maxLength);
    }
}

// Encryption function using AES-256-GCM (AEAD mode)
// Format: iv:tag:encrypted (all hex-encoded)
function encrypt(text, key) {
    if (!key) { return text; }
    try {
        key = tryBufferKey(key);
        // GCM requires 12-byte IV (96 bits) for best performance
        let iv = crypto.randomBytes(12);
        let cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        // Get authentication tag (16 bytes by default for GCM)
        let tag = cipher.getAuthTag();
        // Return format: iv:tag:encrypted (all hex)
        return iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
    } catch (error) {
        logger.error(`Encryption failed: ${error.message}`);
        return null;
    }
}

// Decryption function using AES-256-GCM (AEAD mode)
// Supports both old CBC format (for migration) and new GCM format
// Old format: iv:encrypted (CBC, no tag)
// New format: iv:tag:encrypted (GCM with authentication)
function decrypt(message, key) {
    if (!key) { return message; }
    try {
        // Quick type check - if not string, convert or skip
        if (typeof message !== 'string') {
            if (Buffer.isBuffer(message)) {
                message = message.toString('utf8');
            } else if (message === null || message === undefined) {
                logger.warn(`Decryption skipped: message is ${message === null ? 'null' : 'undefined'}`);
                return null;
            } else {
                const preview = getMessagePreview(message);
                logger.warn(`Decryption skipped: message is not a string (type: ${typeof message}, preview: ${preview})`);
                return null;
            }
        }
        
        key = tryBufferKey(key);
        let parts = message.split(':');
        
        // Detect format: GCM has 3 parts (iv:tag:encrypted), CBC has 2 parts (iv:encrypted)
        if (parts.length === 3) {
            // New GCM format: iv:tag:encrypted
            let iv = Buffer.from(parts[0], 'hex');
            let tag = Buffer.from(parts[1], 'hex');
            let encrypted = parts[2];
            
            let decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } else if (parts.length === 2) {
            // Legacy CBC format: iv:encrypted (for backward compatibility during migration)
            let iv = Buffer.from(parts[0], 'hex');
            let encrypted = parts[1];
            
            let decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(encrypted, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } else {
            throw new Error('Invalid encrypted message format');
        }
    } catch (error) {
        const preview = getMessagePreview(message);
        logger.error(`Decryption failed: ${error.message} (preview: ${preview})`);
        return null;
    }
}


function tryBufferKey(key) {
    if (key.length === 64) {
        return Buffer.from(key, 'hex');
    }   
    return key;
}

export { encrypt, decrypt };