import { axios } from './requestExecutor.js';
import { config } from '../config.js';
import { getStorageGrant } from '../helper-apps/cortex-file-handler/src/security/storageGrant.js';

function optionsFor(url, options = {}) {
    const configured = config.get('whisperMediaApiUrl');
    if (!configured || configured === 'null') return options;
    const target = new URL(url);
    const endpoint = new URL(configured);
    if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname) return options;
    const state = getStorageGrant();
    const headers = { ...options.headers };
    headers['x-cfh-client'] = process.env.CFH_CLIENT_NAME || 'cortex';
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'x-cfh-grant') delete headers[key];
    if (state) headers['x-cfh-grant'] = state.token;
    return { ...options, headers, maxRedirects: 0, cache: false };
}

// Never attach grants to cloud download URLs or follow a redirect with a grant.
async function request(method, url, data, options) {
    try {
        const configured = optionsFor(url, options);
        return await (method === 'post' ? axios.post(url, data, configured) : axios[method](url, configured));
    } catch (error) {
        // Native ClientRequest objects also retain raw headers. Return only
        // the fields callers need; never propagate config/request/cause.
        const safe = Object.assign(new Error(error.message), { name: error.name, code: error.code });
        if (error.response) safe.response = {
            status: error.response.status, statusText: error.response.statusText, data: error.response.data,
        };
        throw safe;
    }
}

export const cfhAxios = {
    get: (url, options) => request('get', url, null, options),
    delete: (url, options) => request('delete', url, null, options),
    post: (url, data, options) => request('post', url, data, options),
};
