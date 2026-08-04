import net from 'net';

const isPortFree = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
        srv.close((err) => resolve(!err));
    });
    srv.listen(port);
});

const findFreePort = async (preferredPort, maxAttempts) => {
    const end = preferredPort + maxAttempts;
    for (let port = preferredPort; port < end; port++) {
        if (await isPortFree(port)) {
            return port;
        }
    }
    const err = new Error(`listen EADDRINUSE: no free port in range ${preferredPort}-${end - 1}`);
    err.code = 'EADDRINUSE';
    throw err;
};

const bindPort = (httpServer, port) => new Promise((resolve, reject) => {
    const onError = (err) => {
        httpServer.removeListener('listening', onListening);
        reject(err);
    };
    const onListening = () => {
        httpServer.removeListener('error', onError);
        resolve(port);
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    try {
        httpServer.listen(port);
    } catch (err) {
        httpServer.removeListener('error', onError);
        httpServer.removeListener('listening', onListening);
        reject(err);
    }
});

/**
 * Bind httpServer to preferredPort. Optionally fall back to subsequent ports
 * when the preferred port is already in use (e.g. local development).
 *
 * When fallback is enabled, probes for a free port first so the real server
 * (and any attached WebSocketServer) does not see EADDRINUSE retries —
 * graphql-ws only handles the first `ws` error via `once('error')`.
 *
 * @returns {Promise<number>} the port that was bound
 */
export const listenHttpServer = async (
    httpServer,
    preferredPort,
    { allowFallback = false, maxAttempts = 100 } = {},
) => {
    if (!allowFallback) {
        return bindPort(httpServer, preferredPort);
    }

    let start = preferredPort;
    const end = preferredPort + maxAttempts;
    let lastError;

    while (start < end) {
        const port = await findFreePort(start, end - start);
        try {
            return await bindPort(httpServer, port);
        } catch (err) {
            lastError = err;
            if (err.code !== 'EADDRINUSE') {
                throw err;
            }
            // Lost the race after probing; try the next port.
            start = port + 1;
        }
    }

    throw lastError || Object.assign(
        new Error(`listen EADDRINUSE: no free port in range ${preferredPort}-${end - 1}`),
        { code: 'EADDRINUSE' },
    );
};
