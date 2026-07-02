import test from 'ava';
import { faker } from '@faker-js/faker';
import { encode, decode } from '../../../lib/encodeCache.js';
import { encoding_for_model } from '@dqbd/tiktoken';

// Create reference encoder with same model as used in encodeCache
const encoder = encoding_for_model("gpt-4o");

// Helper to create a stable representation of token arrays for comparisons
const tokenArrayToString = arr => Array.from(arr).toString();

// Helper to normalize decoded content to string
const normalizeDecoded = decoded => {
    if (decoded instanceof Uint8Array) {
        return new TextDecoder().decode(decoded);
    }
    return decoded;
};

// Test the accuracy of the cached encoding and decoding
test('cached encode and decode are reversible', t => {
    const original = faker.lorem.paragraph(50);
    const encoded = encode(original);
    const decoded = decode(encoded);
    t.is(decoded, original);
})

// Test whether the cached encoding and decoding is identical to tiktoken
test('cached encode and decode are identical to noncached', t => {
    const original = faker.lorem.paragraph(50);
    const encoded = encode(original);
    const tiktokenEncoded = encoder.encode(original);
    
    // Compare arrays by converting to strings
    t.is(tokenArrayToString(encoded), tokenArrayToString(tiktokenEncoded));

    const decoded = decode(encoded);
    const tiktokenDecoded = encoder.decode(tiktokenEncoded);
    
    // Normalize tiktoken decoded output to string for comparison
    const normalizedTiktokenDecoded = normalizeDecoded(tiktokenDecoded);
    
    t.is(decoded, normalizedTiktokenDecoded);
})

test('decode operation adds to encode cache', t => {
    const original = 'Decode should seed the encode cache for this exact text.';
    const encodedOriginal = encoder.encode(original);
    
    // Decode should add to cache
    const decodedOriginal = decode(encodedOriginal);
    
    t.is(decodedOriginal, original);
    t.is(encode(original), encodedOriginal);
})

// Test encode and decode caching
test('caching', t => {
    const original = 'Encoding this text twice should reuse the cached token array.';
    
    // First encode should be uncached
    const encoded1 = encode(original);

    const original2 = 'Decoding this token array twice should reuse the cached string.';
    const encodedOriginal2 = encoder.encode(original2);
    
    // First decode should be uncached
    const decoded1 = decode(encodedOriginal2);

    t.is(tokenArrayToString(encoded1), tokenArrayToString(encoder.encode(original)));
    
    // Compare with normalized tiktoken output
    const normalizedOriginal2 = normalizeDecoded(encoder.decode(encodedOriginal2));
    t.is(decoded1, normalizedOriginal2);
    
    const encoded2 = encode(original);
    const decoded2 = decode(encodedOriginal2);

    t.is(encoded2, encoded1);
    t.is(decoded2, decoded1);
});
