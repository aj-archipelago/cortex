import test from 'ava';

import {
    getvWithDoubleDecryption,
    keyValueStorageClient,
} from '../../../lib/keyValueStorageClient.js';

const contextKey = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';

test('getvWithDoubleDecryption returns deserialized non-string values as-is', async t => {
    const key = `key-value-object-${Date.now()}`;
    const value = { message: 'already parsed', count: 2 };

    await keyValueStorageClient.set(key, value);
    t.deepEqual(await getvWithDoubleDecryption(key, contextKey), value);
});
