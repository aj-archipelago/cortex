import { getSignedUrlTiming, isSignedUrlFresh } from './signedUrlExpiry.js';
import { renewManagedImageUrl } from './fileUtils.js';
import logger from './logger.js';

export function isImageUrlFetchError(error) {
    const message = error?.message || String(error || '');
    return /unable to download content from the provided url|(?:error|failed|timeout|timed out).*(?:download|fetch).*\b(?:image|url)\b|(?:image|url).*(?:download|fetch).*(?:timeout|timed out)/i.test(message);
}

async function withRenewalSlot(state, renew) {
    state.active ||= 0;
    state.waiters ||= [];
    if (state.active >= 8) await new Promise(resolve => state.waiters.push(resolve));
    else state.active++;
    try { return await renew(); }
    finally {
        const next = state.waiters.shift();
        if (next) next();
        else state.active--;
    }
}

// Owned by one resolver/request: no shared authorization cache or cross-user
// reuse. Concurrent copies of the same image share one renewal promise.
export async function refreshChatImageUrls(chatHistory, fileAccessPlan, state, {
    force = false, renew = renewManagedImageUrl, now = Date.now, isCanceled,
} = {}) {
    if (!Array.isArray(chatHistory)) return { chatHistory, renewed: 0 };
    state.urls ||= new Map();
    let renewed = 0;
    const replacements = new Map();
    const refreshed = new Set();
    const scope = JSON.stringify(fileAccessPlan || []);
    const visit = async content => {
        let item = content;
        if (typeof item === 'string') {
            if (!item.trimStart().startsWith('{')) return content;
            try { item = JSON.parse(item); } catch { return content; }
        }
        if (!item || !['image', 'image_url'].includes(item.type)) return content;
        const url = item.url || item.image_url?.url;
        if (!url || url.startsWith('data:')) return content;
        const timing = getSignedUrlTiming(url);
        if (timing?.versioned || !item.blobPath || !item._contextId) return content;
        let parsed;
        try { parsed = new URL(url); } catch { return content; }
        const key = JSON.stringify([scope, item._contextId, item.blobPath, parsed.origin, parsed.pathname]);
        const cached = state.urls.get(key);
        let replacement;
        if (cached?.promise) replacement = await cached.promise;
        else if (!force && cached?.image && isSignedUrlFresh(cached.image.url, { now: now() })) replacement = cached.image;
        else if (!force && isSignedUrlFresh(url, { now: now() })) return content;
        else if (!force && cached?.retryAfter > now()) return content;
        else {
            const entry = {};
            entry.promise = withRenewalSlot(state, () => isCanceled?.() ? null : renew(item, fileAccessPlan)).then(image => {
                if (image?.url && isSignedUrlFresh(image.url, { now: now() })) {
                    entry.image = image;
                    renewed++;
                    return image;
                }
                entry.retryAfter = now() + 30_000;
                return null;
            }).catch(() => {
                entry.retryAfter = now() + 30_000;
                return null;
            }).finally(() => { delete entry.promise; });
            state.urls.set(key, entry);
            if (state.urls.size > 256) state.urls.delete(state.urls.keys().next().value);
            replacement = await entry.promise;
        }
        if (!replacement) return content;
        refreshed.add(key);
        replacements.set(url, replacement.url);
        const updated = { ...item, url: replacement.url, gcs: replacement.gcs || item.gcs,
            image_url: { ...item.image_url, url: replacement.url } };
        return typeof content === 'string' ? JSON.stringify(updated) : updated;
    };
    const messages = await Promise.all(chatHistory.map(async message => message.role === 'tool' ? message : ({
        ...message,
        content: Array.isArray(message.content)
            ? await Promise.all(message.content.map(visit)) : await visit(message.content),
    })));
    // ViewImages also supplies a generated text list for markdown links. Keep
    // that list aligned with the refreshed vision input, leaving user prose alone.
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        message.content = message.content.map(item => {
            if (item?.type !== 'text' || !item.text?.startsWith('Image URLs for markdown:')) return item;
            let text = item.text;
            for (const [previous, current] of replacements) text = text.split(previous).join(current);
            return { ...item, text };
        });
    }
    return { chatHistory: messages, renewed, refreshed: refreshed.size };
}

export async function runWithFreshImageUrls(args, resolver, run, options = {}) {
    resolver._imageUrlState ||= {};
    const prepare = async force => {
        const prepared = await refreshChatImageUrls(args.chatHistory, args.fileAccessPlan, resolver._imageUrlState, { ...options, force });
        args.chatHistory = prepared.chatHistory;
        // Streaming callbacks use resolver.args, which can be a shallow copy.
        if (resolver.args) resolver.args.chatHistory = args.chatHistory;
        return prepared;
    };
    await prepare(false);
    if (options.isCanceled?.()) return null;
    const previousErrorCount = resolver.errors?.length || 0;
    let result;
    let failure;
    const modelArgs = () => resolver._imageUrlState.inlineInput
        ? { ...args, _inlineManagedImages: resolver._imageUrlState.inlineInput } : args;
    try { result = await run(modelArgs()); } catch (error) { failure = error; }
    const errors = failure || (resolver.errors || []).slice(previousErrorCount).join('\n');
    if (!result && isImageUrlFetchError(errors) && !resolver.toolCallbackInvoked
        && !options.isCanceled?.()) {
        const prepared = await prepare(true);
        if (options.isCanceled?.()) return null;
        if (prepared.refreshed > 0) {
            logger.info(JSON.stringify({ event: 'image_url_fetch_retry', requestId: resolver.rootRequestId || resolver.requestId, refreshedImages: prepared.refreshed }));
            resolver.errors?.splice(previousErrorCount);
            // A fresh SAS cannot fix a provider's short download deadline. The
            // Responses adapter can send authorized image bytes on this retry,
            // without putting base64 in stored history or rerunning tools.
            resolver._imageUrlState.inlineInput ||= {};
            return run(modelArgs()); // Exactly one retry, before a response stream starts.
        }
    }
    if (failure) throw failure;
    return result;
}
