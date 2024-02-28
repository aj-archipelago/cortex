import test from 'ava';
import { FastLRUCache } from '../lib/fastLruCache.js';

test('FastLRUCache - get and put', t => {
    const cache = new FastLRUCache(2);

    cache.put(1, 1);
    cache.put(2, 2);

    t.is(cache.get(1), 1); // returns 1
    cache.put(3, 3); // evicts key 2
    t.is(cache.get(2), -1); // returns -1 (not found)
    cache.put(4, 4); // evicts key 1
    t.is(cache.get(1), -1); // returns -1 (not found)
    t.is(cache.get(3), 3); // returns 3
    t.is(cache.get(4), 4); // returns 4
});

test('FastLRUCache - get non-existent key', t => {
    const cache = new FastLRUCache(2);
    t.is(cache.get(99), -1); // returns -1 (not found)
});

test('FastLRUCache - update value of existing key', t => {
    const cache = new FastLRUCache(2);
    cache.put(1, 1);
    cache.put(1, 100);
    t.is(cache.get(1), 100); // returns updated value 100
});