// ContainerBackend.js
// Abstract base class for workspace container backends (Docker, ACI, etc.)

/**
 * Base class defining the container backend interface.
 * Subclasses must implement all methods.
 */
export default class ContainerBackend {
    /**
     * Create and start a new workspace container.
     * @param {Object} opts
     * @param {string} opts.containerName - Unique container name (e.g. 'workspace-{entityId}')
     * @param {string} opts.image - Container image name/tag
     * @param {string[]} opts.env - Environment variables (KEY=VALUE format)
     * @param {number} opts.cpus - CPU cores (e.g. 1.0)
     * @param {number} opts.memoryMB - Memory in megabytes
     * @param {string} opts.diskSize - Disk size string (e.g. '10g') — Docker-specific, may be ignored
     * @param {string} [opts.shareName] - Persistent volume/share name. Docker uses
     *   it for the workspace volume; ACI uses it only with mountAzureFiles for
     *   one-time legacy Azure Files migration.
     * @param {boolean} [opts.mountAzureFiles] - ACI-only legacy migration mount.
     * @returns {Promise<{containerId: string, url: string}>}
     */
    async createAndStart(opts) {
        throw new Error('createAndStart() not implemented');
    }

    /**
     * Start a stopped container.
     * @param {string} containerId - Container/resource identifier
     * @param {string} containerName - Human-readable container name
     * @returns {Promise<void|{url?: string}>}
     */
    async start(containerId, containerName) {
        throw new Error('start() not implemented');
    }

    /**
     * Stop a running container (preserves state for restart).
     * @param {string} containerId - Container/resource identifier
     * @param {string} containerName - Human-readable container name
     * @returns {Promise<void>}
     */
    async stop(containerId, containerName) {
        throw new Error('stop() not implemented');
    }

    /**
     * Remove a container entirely.
     * @param {string} containerId - Container/resource identifier
     * @param {string} containerName - Human-readable container name
     * @returns {Promise<void>}
     */
    async remove(containerId, containerName) {
        throw new Error('remove() not implemented');
    }

    /**
     * Destroy persistent storage associated with a container.
     * @param {string} shareName - Volume/share name to destroy (may differ from containerName)
     * @returns {Promise<void>}
     */
    async destroyVolume(shareName) {
        throw new Error('destroyVolume() not implemented');
    }

    /** @returns {string} Backend identifier ('docker' or 'aci') */
    get backendName() {
        throw new Error('backendName not implemented');
    }

    /** @returns {number} Milliseconds to wait for container health check after create */
    get healthTimeoutMs() {
        throw new Error('healthTimeoutMs not implemented');
    }

    /**
     * Milliseconds to wait for health check during wake.
     * Short for backends where stop/start are no-ops (container is already hot).
     * Same as healthTimeoutMs for backends that truly restart containers.
     * @returns {number}
     */
    get wakeHealthTimeoutMs() {
        return this.healthTimeoutMs;
    }
}
