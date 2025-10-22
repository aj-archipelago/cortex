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


function tryBufferKey(key) {
    if (key.length === 64) {
        return Buffer.from(key, 'hex');
    }   
    return key;
}

export { encrypt, decrypt };