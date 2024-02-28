import test from 'ava';
import { faker } from '@faker-js/faker';
import { performance } from 'perf_hooks';
import { encode, decode } from '../lib/encodeCache.js';
import { encode as gpt3Encode, decode as gpt3Decode } from 'gpt-3-encoder';

// Test the accuracy of the cached encoding and decoding
test('cached encode and decode are reversible', t => {
    const original = faker.lorem.paragraph(50);
    const encoded = encode(original);
    const decoded = decode(encoded);
    t.is(decoded, original);
})

// Test whether the cached encoding and decoding is identical to the gpt3-encoder
test('cached encode and decode are identical to noncached', t => {
    const original = faker.lorem.paragraph(50);
    const encoded = encode(original);
    const gpt3Encoded = gpt3Encode(original);
    t.deepEqual(encoded, gpt3Encoded);

    const decoded = decode(encoded);
    const gpt3Decoded = gpt3Decode(encoded);
    t.is(decoded, gpt3Decoded);
})

// Test whether encoding adds the decoded value to the decode cache
// the only way to tell is if the decode is faster after the cached encode
test('encode operation adds to decode cache', t => {
    const original = faker.lorem.paragraph(50);
    const encodedOriginal = gpt3Encode(original);
    const startDecode = performance.now();
    const decoded = decode(encodedOriginal);
    const endDecode = performance.now();
    const decodeTime = endDecode - startDecode;
    console.log("pre-encode decode time", decodeTime);

    t.is(decoded, original);

    const original2 = faker.lorem.paragraph(50);
    const encodedOriginal2 = encode(original2);
    const startDecode2 = performance.now();
    const decoded2 = decode(encodedOriginal2);
    const endDecode2 = performance.now();
    const decodeTime2 = endDecode2 - startDecode2;
    console.log("post-encode decode time", decodeTime2);
    
    t.is(decoded2, original2);
    t.true(decodeTime2 <= decodeTime);
})

// Test whether decoding adds the encoded value to the encode cache
// the only way to tell is if the encode is faster after the cached decode
test('decode operation adds to encode cache', t => {
    const original = faker.lorem.paragraph(50);
    const encodedOriginal = gpt3Encode(original);

    const startEncode = performance.now();
    const encoded = encode(original);
    const endEncode = performance.now();
    const encodeTime = endEncode - startEncode;
    console.log("pre-decode encode time", encodeTime);

    t.deepEqual(encoded, encodedOriginal);

    const original2 = faker.lorem.paragraph(50);
    const encodedOriginal2 = gpt3Encode(original2);
    const decodedOriginal2 = decode(encodedOriginal2);
    const startEncode2 = performance.now();
    const encoded2 = encode(original2);
    const endEncode2 = performance.now();
    const encodeTime2 = endEncode2 - startEncode2;
    console.log("post-decode encode time", encodeTime2);

    t.deepEqual(encoded2, encodedOriginal2);
    t.true(encodeTime2 <= encodeTime);
})


// Test encode and decode caching
test('caching', t => {
    const original = faker.lorem.paragraph(50);
    const startEncode1 = performance.now();
    const encoded1 = encode(original);
    const endEncode1 = performance.now();
    const encodeTime1 = endEncode1 - startEncode1;

    const original2 = faker.lorem.paragraph(50);
    const encodedOriginal2 = gpt3Encode(original2);
    const startDecode1 = performance.now();
    const decoded1 = decode(encodedOriginal2);
    const endDecode1 = performance.now();
    const decodeTime1 = endDecode1 - startDecode1;

    t.deepEqual(encoded1, gpt3Encode(original));
    t.is(decoded1, original2);

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

    t.true(encodeTime2 <= encodeTime1);
    t.true(decodeTime2 <= decodeTime1);
});