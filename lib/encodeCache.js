import { encoding_for_model } from '@dqbd/tiktoken';
import { FastLRUCache } from './fastLruCache.js';

class EncodeCache {
    constructor(model = "gpt-4o") {
        this.encodeCache = new FastLRUCache(1000);
        this.decodeCache = new FastLRUCache(100); // we don't use decode nearly as much
        this.encoder = encoding_for_model(model);
    }
    
    encode(value) {
        // Handle null/undefined/empty values
        if (value == null || value === '') {
            const emptyResult = new Uint32Array(0);
            this.encodeCache.put(value, emptyResult);
            return emptyResult;
        }
        
        // Convert to string if not already
        const stringValue = String(value);
        
        if (this.encodeCache.get(stringValue) !== -1) {
            return this.encodeCache.get(stringValue);
        }
        
        try {
            const encoded = this.encoder.encode(stringValue);
            this.encodeCache.put(stringValue, encoded);
            return encoded;
        } catch (error) {
            // Handle WASM memory access out of bounds errors
            if (error.message && error.message.includes('memory access out of bounds')) {
                console.warn(`WASM Tiktoken memory error for input length ${stringValue?.length || 0}: ${error.message}`);
                
                // Fallback: return approximate token count (1 token ≈ 4 characters for GPT models)
                const approximateTokens = new Array(Math.ceil((stringValue?.length || 0) / 4)).fill(0).map((_, i) => i);
                this.encodeCache.put(stringValue, approximateTokens);
                return approximateTokens;
            }
            
            // Re-throw other errors
            throw error;
        }
    }

    decode(value) {
        // Create a cache key based on array values
        const key = Array.from(value).toString();
        
        if (this.decodeCache.get(key) !== -1) {
            return this.decodeCache.get(key);
        }
        
        try {
            // The tiktoken decoder returns Uint8Array, we need to convert it to a string
            const decoded = this.encoder.decode(value);
            
            // Convert the decoded tokens to a string
            const decodedString = typeof decoded === 'string' ? decoded : new TextDecoder().decode(decoded);
            
            this.decodeCache.put(key, decodedString);
            
            if (this.encodeCache.get(decodedString) === -1) {
                this.encodeCache.put(decodedString, value);
            }
            
            return decodedString;
        } catch (error) {
            // Handle WASM memory access out of bounds errors
            if (error.message && error.message.includes('memory access out of bounds')) {
                console.warn(`WASM Tiktoken memory error during decode for ${value?.length || 0} tokens: ${error.message}`);
                
                // Fallback: return placeholder text
                const fallbackText = `[DECODE_ERROR_${value?.length || 0}_TOKENS]`;
                this.decodeCache.put(key, fallbackText);
                return fallbackText;
            }
            
            // Re-throw other errors
            throw error;
        }
    }
}

// Create one instance of the cache
const cache = new EncodeCache();

// Make sure the instance is bound to the methods, so 
// references to 'this' are correct
export const encode = cache.encode.bind(cache);
export const decode = cache.decode.bind(cache);