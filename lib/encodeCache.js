import { encode as gpt3Encode, decode as gpt3Decode } from 'gpt-3-encoder';
import { FastLRUCache } from './fastLruCache.js';

class EncodeCache {
    constructor() {
        this.encodeCache = new FastLRUCache(1000);
        this.decodeCache = new FastLRUCache(1000);
    }
    
    encode(value) {
        if (this.encodeCache.get(value) !== -1) {
            return this.encodeCache.get(value);
        }
        const encoded = gpt3Encode(value);
        this.encodeCache.put(value, encoded);
        if (this.decodeCache.get(encoded) === -1) {
            this.decodeCache.put(encoded, value);
        }
        return encoded;
    }

    decode(value) {
        if (this.decodeCache.get(value) !== -1) {
            return this.decodeCache.get(value);
        }
        const decoded = gpt3Decode(value);
        this.decodeCache.put(value, decoded);
        if (this.encodeCache.get(decoded) === -1) {
            this.encodeCache.put(decoded, value);
        }
        return decoded;
    }
}

// Create one instance of the cache
const cache = new EncodeCache();

export const encode = cache.encode.bind(cache);
export const decode = cache.decode.bind(cache);