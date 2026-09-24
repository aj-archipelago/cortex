import test from 'ava';
import { config } from '../../../config.js';
import { axios } from '../../../lib/requestExecutor.js';
import { cfhAxios } from '../../../lib/cfhClient.js';
import { withStorageGrant } from '../../../helper-apps/cortex-file-handler/src/security/storageGrant.js';

test.serial('CFH credentials stay on its configured endpoint and out of propagated errors', async t => {
    const previousGet = axios.get;
    const previousConfig = config.get.bind(config);
    config.get = name => name === 'whisperMediaApiUrl' ? 'https://cfh.test/api' : previousConfig(name);
    const calls = [];
    axios.get = async (url, options) => { calls.push({ url, options }); return { data: 'ok' }; };
    try {
        await withStorageGrant({ token: 'private-grant' }, async () => {
            await cfhAxios.get('https://cfh.test/api?listNames=true');
            await cfhAxios.get('https://cfh.test/elsewhere');
            await cfhAxios.get('https://storage.test/blob');
        });
        t.is(calls[0].options.headers['x-cfh-grant'], 'private-grant');
        t.is(calls[0].options.maxRedirects, 0);
        t.is(calls[0].options.cache, false);
        t.falsy(calls[1].options.headers?.['x-cfh-grant']);
        t.falsy(calls[2].options.headers?.['x-cfh-grant']);
        axios.get = async () => { throw Object.assign(new Error('upstream failure'), {
            config: { headers: { 'x-cfh-grant': 'private-grant' } },
            request: { _header: 'X-CFH-Grant: private-grant' },
            response: { status: 403, data: 'denied' },
        }); };
        const error = await t.throwsAsync(() => cfhAxios.get('https://cfh.test/api'));
        t.is(error.response.status, 403);
        t.falsy(error.config); t.falsy(error.request);
        t.false(JSON.stringify(error).includes('private-grant'));
    } finally { axios.get = previousGet; config.get = previousConfig; }
});
