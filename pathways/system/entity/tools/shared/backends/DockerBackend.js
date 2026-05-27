// DockerBackend.js
// Docker Engine API backend for workspace containers.
// Extracted from workspace_client.js — talks to Docker daemon via Unix socket or TCP.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { config } from '../../../../../../config.js';
import logger from '../../../../../../lib/logger.js';
import ContainerBackend from './ContainerBackend.js';

// Detect if Cortex is running inside Docker (production) or on the host (local dev)
const isInDocker = fs.existsSync('/.dockerenv');

/**
 * Resolve Docker Engine connection.
 * Supports three topologies:
 *   1. Local dev    — auto-detect Unix socket on the host
 *   2. Same VM      — Cortex in Docker, socket mounted into container
 *   3. Remote host  — DOCKER_HOST=tcp://host:port (e.g. VM on same VNet)
 */
function resolveDockerConnection() {
    const dockerHost = config.get('dockerHost');

    if (dockerHost && dockerHost.startsWith('tcp://')) {
        const url = new URL(dockerHost.replace('tcp://', 'http://'));
        return { type: 'tcp', hostname: url.hostname, port: Number(url.port) || 2375 };
    }

    if (dockerHost && dockerHost.startsWith('unix://')) {
        const socketPath = dockerHost.replace('unix://', '');
        return { type: 'socket', socketPath };
    }

    // Auto-detect local socket
    const socketPath = [
        '/var/run/docker.sock',
        `${process.env.HOME}/.docker/run/docker.sock`,
    ].find(p => fs.existsSync(p)) || '/var/run/docker.sock';
    return { type: 'socket', socketPath };
}

/**
 * Parse memory limit string (e.g. '512m', '1g') to bytes.
 */
function parseMemoryLimit(str) {
    const match = str.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/);
    if (!match) return 512 * 1024 * 1024; // default 512MB

    const num = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
        case 'k': return Math.round(num * 1024);
        case 'm': return Math.round(num * 1024 * 1024);
        case 'g': return Math.round(num * 1024 * 1024 * 1024);
        default: return Math.round(num);
    }
}

/**
 * Find a free port on the host for local dev port mapping.
 */
function findFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

export default class DockerBackend extends ContainerBackend {
    constructor() {
        super();
        this._conn = resolveDockerConnection();
        this._workspaceHost = config.get('workspaceHost') || '';
        this._isRemoteDocker = this._conn.type === 'tcp' || !!this._workspaceHost;
    }

    get backendName() {
        return 'docker';
    }

    get healthTimeoutMs() {
        return 30000;
    }

    /**
     * Make a Docker Engine API request via Unix socket or TCP.
     */
    _api(method, path, body = null) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;

            const reqOptions = {
                path,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
                timeout: 30000,
            };

            if (this._conn.type === 'tcp') {
                reqOptions.hostname = this._conn.hostname;
                reqOptions.port = this._conn.port;
            } else {
                reqOptions.socketPath = this._conn.socketPath;
            }

            const req = http.request(reqOptions, (res) => {
                let data = '';
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        reject(new Error(`Docker API ${method} ${path}: ${res.statusCode} ${data}`));
                        return;
                    }
                    if (res.statusCode === 204 || !data) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(data));
                    } catch {
                        resolve({});
                    }
                });
            });

            req.on('error', (e) => reject(new Error(`Docker API ${method} ${path}: ${e.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error(`Docker API ${method} ${path}: timeout`)); });

            if (payload) req.write(payload);
            req.end();
        });
    }

    async createAndStart({ containerName, image, env, cpus, memoryMB, diskSize, shareName }) {
        const network = config.get('workspaceNetwork');
        const volumeName = `${shareName || containerName}-data`;

        const mode = this._isRemoteDocker ? 'remote' : (isInDocker ? 'docker' : 'local');
        logger.info(`[DockerBackend] Provisioning ${containerName} [${mode} mode]`);

        // Remove existing container if it exists (for re-provisioning)
        try {
            await this._api('DELETE', `/containers/${containerName}?force=true`);
        } catch {
            // Container doesn't exist, that's fine
        }

        // Convert memory/cpu to Docker units
        const memoryBytes = memoryMB * 1024 * 1024;
        const nanoCpus = Math.round(cpus * 1e9);

        // Determine networking mode
        const usePortMapping = mode !== 'docker';
        let hostPort = null;
        if (mode === 'local') {
            hostPort = await findFreePort();
        }

        const portBindings = usePortMapping
            ? { '3100/tcp': [{ HostPort: hostPort ? String(hostPort) : '0' }] }
            : undefined;

        // Note: StorageOpt only works on Linux with overlay2/xfs+pquota; skip on macOS/Docker Desktop
        const useStorageOpt = (isInDocker || this._isRemoteDocker) && diskSize;
        const createBody = {
            Image: image,
            Hostname: containerName,
            Env: env,
            ExposedPorts: { '3100/tcp': {} },
            HostConfig: {
                NanoCpus: nanoCpus,
                Memory: memoryBytes,
                ...(useStorageOpt ? { StorageOpt: { size: diskSize } } : {}),
                RestartPolicy: { Name: 'unless-stopped' },
                Binds: [`${volumeName}:/workspace`],
                ...(portBindings ? { PortBindings: portBindings } : {}),
            },
            ...(mode === 'docker' ? {
                NetworkingConfig: {
                    EndpointsConfig: {
                        [network]: {},
                    },
                },
            } : {}),
        };

        const createRes = await this._api('POST', `/containers/create?name=${containerName}`, createBody);
        const containerId = createRes.Id;

        // Start container
        await this._api('POST', `/containers/${containerId}/start`);

        // Resolve URL to reach this workspace container
        let url;
        if (mode === 'docker') {
            url = `http://${containerName}:3100`;
        } else if (mode === 'remote') {
            const info = await this._api('GET', `/containers/${containerId}/json`);
            const bindings = info.NetworkSettings?.Ports?.['3100/tcp'];
            const assignedPort = bindings?.[0]?.HostPort;
            if (!assignedPort) {
                throw new Error('Docker did not assign a host port for workspace container');
            }
            url = `http://${this._workspaceHost}:${assignedPort}`;
        } else {
            url = `http://localhost:${hostPort}`;
        }

        return { containerId, url };
    }

    async start(containerId, containerName) {
        await this._api('POST', `/containers/${containerId}/start`);
    }

    async stop(containerId, containerName) {
        await this._api('POST', `/containers/${containerId}/stop?t=10`);
    }

    async remove(containerId, containerName) {
        try {
            await this._api('POST', `/containers/${containerName}/stop?t=10`);
        } catch {
            // May already be stopped
        }
        try {
            await this._api('DELETE', `/containers/${containerName}?force=true`);
        } catch {
            // May already be removed
        }
    }

    async destroyVolume(shareName) {
        const volumeName = `${shareName}-data`;
        try {
            await this._api('DELETE', `/volumes/${volumeName}`);
        } catch {
            // Volume may not exist
        }
    }
}

// Export helpers for backward compat / unit testing
export { parseMemoryLimit };
