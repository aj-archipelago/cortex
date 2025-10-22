// crypto.test.js
// Tests for encryption and decryption functions in cortex/lib/crypto.js

import test from 'ava';
import { encrypt, decrypt, doubleEncrypt, doubleDecrypt } from '../../../lib/crypto.js';

// Test data
const testData = 'Hello, this is test data!';
const systemKey = '1234567890123456789012345678901234567890123456789012345678901234'; // 64 hex chars
const userKey = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'; // 64 hex chars
const wrongUserKey = '0000000000000000000000000000000000000000000000000000000000000000'; // 64 hex chars
const wrongSystemKey = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'; // 64 hex chars

// Basic encryption/decryption tests
test('encrypt should encrypt data with valid key', t => {
    const encrypted = encrypt(testData, systemKey);
    t.truthy(encrypted);
    t.not(encrypted, testData);
    t.true(encrypted.includes(':'));
});

test('decrypt should decrypt data with correct key', t => {
    const encrypted = encrypt(testData, systemKey);
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, testData);
});

test('encrypt should return original data when no key provided', t => {
    const result = encrypt(testData, null);
    t.is(result, testData);
});

test('decrypt should return original data when no key provided', t => {
    const result = decrypt(testData, null);
    t.is(result, testData);
});

// Double encryption tests
test('doubleEncrypt should encrypt with system key only when no user key', t => {
    const encrypted = doubleEncrypt(testData, null, systemKey);
    t.truthy(encrypted);
    t.not(encrypted, testData);
    
    // Should be decryptable with system key only
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, testData);
});

test('doubleEncrypt should encrypt with both keys when user key provided', t => {
    const encrypted = doubleEncrypt(testData, userKey, systemKey);
    t.truthy(encrypted);
    t.not(encrypted, testData);
    
    // Should NOT be decryptable with system key only (it will be user-encrypted data)
    const systemOnlyDecrypted = decrypt(encrypted, systemKey);
    t.not(systemOnlyDecrypted, testData);
    t.truthy(systemOnlyDecrypted); // Should return user-encrypted data, not null
});

test('doubleEncrypt should fail when no system key provided', t => {
    const encrypted = doubleEncrypt(testData, userKey, null);
    t.is(encrypted, null);
});

test('doubleEncrypt should fallback to system key when user encryption fails', t => {
    // Use invalid user key to force fallback
    const invalidUserKey = 'invalid';
    const encrypted = doubleEncrypt(testData, invalidUserKey, systemKey);
    t.truthy(encrypted);
    
    // Should be decryptable with system key only (fallback behavior)
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, testData);
});

// Double decryption tests
test('doubleDecrypt should decrypt with system key only when no user key', t => {
    const encrypted = encrypt(testData, systemKey);
    const decrypted = doubleDecrypt(encrypted, null, systemKey);
    t.is(decrypted, testData);
});

test('doubleDecrypt should decrypt double-encrypted data with both keys', t => {
    const encrypted = doubleEncrypt(testData, userKey, systemKey);
    const decrypted = doubleDecrypt(encrypted, userKey, systemKey);
    t.is(decrypted, testData);
});

test('doubleDecrypt should handle single-encrypted data when user key provided', t => {
    // This is the key scenario we fixed!
    const singleEncrypted = encrypt(testData, systemKey);
    const decrypted = doubleDecrypt(singleEncrypted, userKey, systemKey);
    t.is(decrypted, testData);
});

test('doubleDecrypt should fail when no system key provided', t => {
    const encrypted = encrypt(testData, systemKey);
    const decrypted = doubleDecrypt(encrypted, userKey, null);
    t.is(decrypted, null);
});

test('doubleDecrypt should fail when system decryption fails', t => {
    const encrypted = encrypt(testData, systemKey);
    const wrongSystemKey = 'wrongkey123456789012345678901234567890123456789012345678901234567890';
    const decrypted = doubleDecrypt(encrypted, userKey, wrongSystemKey);
    t.is(decrypted, null);
});

test('doubleDecrypt should return system-decrypted data when user decryption fails for double-encrypted data', t => {
    const encrypted = doubleEncrypt(testData, userKey, systemKey);
    const decrypted = doubleDecrypt(encrypted, wrongUserKey, systemKey);
    // Should return the user-encrypted data (system decryption succeeded, user decryption failed)
    t.not(decrypted, testData); // Should not be the original data
    t.truthy(decrypted); // Should return some data (user-encrypted)
});

// Edge cases and error handling
test('encrypt should handle empty string', t => {
    const encrypted = encrypt('', systemKey);
    t.truthy(encrypted);
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, '');
});

test('encrypt should handle special characters', t => {
    const specialData = 'Special chars: !@#$%^&*()_+-=[]{}|;:,.<>?';
    const encrypted = encrypt(specialData, systemKey);
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, specialData);
});

test('encrypt should handle unicode characters', t => {
    const unicodeData = 'Unicode: 🚀 🌟 ñáéíóú 中文 العربية';
    const encrypted = encrypt(unicodeData, systemKey);
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, unicodeData);
});

test('doubleEncrypt should handle JSON data', t => {
    const jsonData = JSON.stringify({ message: 'test', number: 42, array: [1, 2, 3] });
    const encrypted = doubleEncrypt(jsonData, userKey, systemKey);
    const decrypted = doubleDecrypt(encrypted, userKey, systemKey);
    t.is(decrypted, jsonData);
});

// Integration test for the specific scenario we fixed
test('CRITICAL: doubleDecrypt should handle mixed encryption states', t => {
    // Simulate a migration scenario where some data is single-encrypted
    // and some is double-encrypted, but we always pass both keys
    
    // Single-encrypted data (old format)
    const singleEncrypted = encrypt(testData, systemKey);
    
    // Double-encrypted data (new format)  
    const doubleEncrypted = doubleEncrypt(testData, userKey, systemKey);
    
    // Both should be readable with both keys provided
    const singleDecrypted = doubleDecrypt(singleEncrypted, userKey, systemKey);
    const doubleDecrypted = doubleDecrypt(doubleEncrypted, userKey, systemKey);
    
    t.is(singleDecrypted, testData, 'Single-encrypted data should be readable with both keys');
    t.is(doubleDecrypted, testData, 'Double-encrypted data should be readable with both keys');
});
