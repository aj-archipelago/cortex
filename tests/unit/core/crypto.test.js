// crypto.test.js
// Tests for encryption and decryption functions in cortex/lib/crypto.js

import test from 'ava';
import { encrypt, decrypt } from '../../../lib/crypto.js';

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

test('encrypt should handle JSON data', t => {
    const jsonData = JSON.stringify({ message: 'test', number: 42, array: [1, 2, 3] });
    const encrypted = encrypt(jsonData, systemKey);
    const decrypted = decrypt(encrypted, systemKey);
    t.is(decrypted, jsonData);
});
