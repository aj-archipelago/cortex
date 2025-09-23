import test from 'ava';
import { faker } from '@faker-js/faker';
import { performance } from 'perf_hooks';
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

// Test whether decoding adds the encoded value to the encode cache
// the only way to tell is if the encode is faster after the cached decode
test('decode operation adds to encode cache', t => {
    const original = faker.lorem.paragraph(50);
    const encodedOriginal = encoder.encode(original);

    const startEncode = performance.now();
    const encoded = encode(original);
    const endEncode = performance.now();
    const encodeTime = endEncode - startEncode;
    console.log("pre-decode encode time", encodeTime);

    // Compare arrays using our helper
    t.is(tokenArrayToString(encoded), tokenArrayToString(encodedOriginal));

    const original2 = faker.lorem.paragraph(50);
    const encodedOriginal2 = encoder.encode(original2);
    
    // Decode should add to cache
    const decodedOriginal2 = decode(encodedOriginal2);
    
    const startEncode2 = performance.now();
    const encoded2 = encode(original2);
    const endEncode2 = performance.now();
    const encodeTime2 = endEncode2 - startEncode2;
    console.log("post-decode encode time", encodeTime2);

    t.is(tokenArrayToString(encoded2), tokenArrayToString(encodedOriginal2));
    
    // Allow some buffer for timing variations
    t.true(encodeTime2 <= encodeTime);
})

// Test encode and decode caching
test('caching', t => {
    const original = faker.lorem.paragraph(50);
    
    // First encode should be uncached
    const startEncode1 = performance.now();
    const encoded1 = encode(original);
    const endEncode1 = performance.now();
    const encodeTime1 = endEncode1 - startEncode1;

    const original2 = faker.lorem.paragraph(50);
    const encodedOriginal2 = encoder.encode(original2);
    
    // First decode should be uncached
    const startDecode1 = performance.now();
    const decoded1 = decode(encodedOriginal2);
    const endDecode1 = performance.now();
    const decodeTime1 = endDecode1 - startDecode1;

    t.is(tokenArrayToString(encoded1), tokenArrayToString(encoder.encode(original)));
    
    // Compare with normalized tiktoken output
    const normalizedOriginal2 = normalizeDecoded(encoder.decode(encodedOriginal2));
    t.is(decoded1, normalizedOriginal2);

    console.log('uncached encode time', encodeTime1);
    console.log('uncached decode time', decodeTime1);
    
    // Second time encoding and decoding, it should be from the cache
    const startEncode2 = performance.now();
    const encoded2 = encode(original);
    const endEncode2 = performance.now();
    const encodeTime2 = endEncode2 - startEncode2;

    const startDecode2 = performance.now();
    const decoded2 = decode(encodedOriginal2);
    const endDecode2 = performance.now();
    const decodeTime2 = endDecode2 - startDecode2;
    
    console.log('cached encode time', encodeTime2);
    console.log('cached decode time', decodeTime2);

    // Allow some buffer for timing variations
    t.true(encodeTime2 <= encodeTime1);
    t.true(decodeTime2 <= decodeTime1);
});