// The relay origin is deployment configuration, never supplied in an MCP config.
export function createCompanionMcpClient(config) {
    const origin = process.env.CORTEX_COMPANION_RELAY_URL;
    if (!origin) throw new Error('Local companion relay is not configured');
    const url = new URL('/v1/rpc', origin);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
        throw new Error('Companion relay must use HTTPS');
    }
    const controllers = new Set();
    async function request(method, params, options) {
        const controller = new AbortController();
        controllers.add(controller);
        const timeout = setTimeout(() => controller.abort(), Math.min(options?.timeout || 125000, 125000));
        const cancel = () => controller.abort();
        options?.signal?.addEventListener('abort', cancel, { once: true });
        if (options?.signal?.aborted) controller.abort();
        try {
            const response = await fetch(url, {
                method: 'POST', redirect: 'error', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
                body: JSON.stringify({ deviceId: config.deviceId, serverId: config.serverId, method, params }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Local companion unavailable');
            return result;
        } catch (error) {
            if (controller.signal.aborted) throw new Error('Local tool interrupted. The action may have run; check the local app before retrying.');
            throw error;
        } finally {
            clearTimeout(timeout); controllers.delete(controller);
            options?.signal?.removeEventListener('abort', cancel);
        }
    }
    const close = async () => { for (const c of controllers) c.abort(); controllers.clear(); };
    return {
        client: {
            listTools: (params, options) => request('tools/list', params, options),
            callTool: (params, _schema, options) => request('tools/call', params, options),
            close,
        },
        localCompanion: true, transport: { close }, connectTimestamp: Date.now(),
    };
}
