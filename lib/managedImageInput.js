import axios from 'axios';
import { renewManagedImageUrl } from './fileUtils.js';
import logger from './logger.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_INPUT_BYTES = 24 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Runs after prompt compilation and truncation. Only the provider request gets
// base64; chat history, tool results, and markdown links keep their stored URLs.
export async function inlineManagedImageInputs(messages, history, fileAccessPlan, state, {
    renew = renewManagedImageUrl, get = axios.get,
    maxImageBytes = MAX_IMAGE_BYTES, maxInputBytes = MAX_INPUT_BYTES,
} = {}) {
    const sources = new Map();
    for (const message of history || []) {
        if (message.role === 'tool') continue;
        for (let item of Array.isArray(message.content) ? message.content : [message.content]) {
            if (typeof item === 'string') {
                try { item = JSON.parse(item); } catch { continue; }
            }
            if (!['image', 'image_url'].includes(item?.type) || !item.blobPath || !item._contextId) continue;
            sources.set(item.url || item.image_url?.url, item);
        }
    }
    state.images ||= new Map();
    state.bytes ||= 0;
    const scope = JSON.stringify(fileAccessPlan || []);
    const attempted = new Set();
    let inputBytes = 0;
    const result = [];
    // Sequential reads bound transient memory and count repeated image parts
    // against the request limit even when they share one downloaded buffer.
    for (const message of messages) {
        if (message.role === 'tool' || !Array.isArray(message.content)) {
            result.push(message);
            continue;
        }
        const content = [];
        for (const item of message.content) {
            const url = item?.type === 'image_url' ? item.image_url?.url : null;
            const source = sources.get(url);
            if (!source) { content.push(item); continue; }
            const key = JSON.stringify([scope, source._contextId, source.blobPath, url]);
            let image = state.images.get(key);
            if (!image && !attempted.has(key) && inputBytes < maxInputBytes) {
                attempted.add(key);
                try {
                    // Scoped lookup checks the current grant and exact origin
                    // and path; metadata supplied in history grants no access.
                    const authorized = await renew(source, fileAccessPlan);
                    const resolved = authorized?.url && new URL(authorized.url);
                    if (resolved?.protocol === 'https:' && resolved.hostname.endsWith('.blob.core.windows.net')
                        && !resolved.username && !resolved.password && !resolved.port) {
                        const response = await get(resolved.href, {
                            responseType: 'arraybuffer', timeout: 20_000,
                            maxRedirects: 0, maxContentLength: Math.min(maxImageBytes, maxInputBytes - inputBytes),
                        });
                        const mimeType = response.headers?.['content-type']?.split(';')[0].trim().toLowerCase();
                        const bytes = Buffer.from(response.data);
                        if (IMAGE_TYPES.has(mimeType) && bytes.length > 0 && bytes.length <= maxImageBytes
                            && inputBytes + bytes.length <= maxInputBytes) {
                            image = { url: `data:${mimeType};base64,${bytes.toString('base64')}`, bytes: bytes.length };
                            while (state.images.size && state.bytes + image.bytes > maxInputBytes) {
                                const oldest = state.images.keys().next().value;
                                state.bytes -= state.images.get(oldest).bytes;
                                state.images.delete(oldest);
                            }
                            state.images.set(key, image);
                            state.bytes += image.bytes;
                        }
                    }
                } catch {
                    // Preserve the URL and existing error path if inline access
                    // fails. Never log signed URLs, image bytes, or HTTP config.
                    logger.warn(JSON.stringify({ event: 'managed_image_inline_unavailable' }));
                }
            }
            if (image && inputBytes + image.bytes <= maxInputBytes) {
                inputBytes += image.bytes;
                content.push({ ...item, image_url: { ...item.image_url, url: image.url } });
            } else content.push(item);
        }
        result.push({ ...message, content });
    }
    return result;
}
