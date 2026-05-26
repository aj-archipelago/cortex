// backends/index.js
// Factory for workspace container backends.
// Singleton — lazily creates the backend on first call.

import { config } from '../../../../../../config.js';

let _backend = null;

/**
 * Get the configured container backend (singleton).
 * Uses dynamic import so Azure SDK only loads when ACI backend is selected.
 * @returns {Promise<import('./ContainerBackend.js').default>}
 */
export async function getBackend() {
    if (_backend) return _backend;

    const backendType = config.get('workspaceBackend');

    if (backendType === 'aci') {
        const { default: ACIBackend } = await import('./ACIBackend.js');
        _backend = new ACIBackend();
    } else {
        const { default: DockerBackend } = await import('./DockerBackend.js');
        _backend = new DockerBackend();
    }

    return _backend;
}
