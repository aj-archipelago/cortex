/**
 * Bind httpServer to preferredPort. Optionally fall back to subsequent ports
 * when the preferred port is already in use (e.g. local development).
 * @returns {Promise<number>} the port that was bound
 */
export const listenHttpServer = (httpServer, preferredPort, { allowFallback = false, maxAttempts = 100 } = {}) => {
    const tryListen = (port) => new Promise((resolve, reject) => {
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

    const end = allowFallback ? preferredPort + maxAttempts : preferredPort + 1;

    const attempt = async (port) => {
        try {
            return await tryListen(port);
        } catch (err) {
            if (err.code !== 'EADDRINUSE' || !allowFallback || port + 1 >= end) {
                throw err;
            }
            return attempt(port + 1);
        }
    };

    return attempt(preferredPort);
};
