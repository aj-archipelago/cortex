import { encoding_for_model } from '@dqbd/tiktoken';
import { FastLRUCache } from './fastLruCache.js';

class EncodeCache {
    constructor(model = "gpt-4o") {
        this.encodeCache = new FastLRUCache(1000);
        this.decodeCache = new FastLRUCache(100); // we don't use decode nearly as much
        this.encoder = encoding_for_model(model);
    }
    
    encode(value) {
        if (this.encodeCache.get(value) !== -1) {
            return this.encodeCache.get(value);
        }
        const encoded = this.encoder.encode(value);
        this.encodeCache.put(value, encoded);
        return encoded;
    }

    decode(value) {
        // Create a cache key based on array values
        const key = Array.from(value).toString();
        
        if (this.decodeCache.get(key) !== -1) {
            return this.decodeCache.get(key);
        }
        
        // The tiktoken decoder returns Uint8Array, we need to convert it to a string
        const decoded = this.encoder.decode(value);
        
        // Convert the decoded tokens to a string
        const decodedString = typeof decoded === 'string' ? decoded : new TextDecoder().decode(decoded);
        
        this.decodeCache.put(key, decodedString);
        
        if (this.encodeCache.get(decodedString) === -1) {
            this.encodeCache.put(decodedString, value);
        }
        
        return decodedString;
    }
}

// Create one instance of the cache
const cache = new EncodeCache();

// Make sure the instance is bound to the methods, so 
// references to 'this' are correct
export const encode = cache.encode.bind(cache);
export const decode = cache.decode.bind(cache);