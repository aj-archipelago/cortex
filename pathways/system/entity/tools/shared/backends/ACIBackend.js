// ACIBackend.js
// Azure Container Instances backend for workspace containers.
// Each workspace = one ACI container group with public IP, local workspace
// scratch, local checkpoint scratch, and a blob mount (via blobfuse2 inside
// the container image).
//
// Lifecycle strategy: ACI containers are destroyed after inactivity. Cortex
// stores workspace checkpoints in Blob Storage and restores them into a warm
// container when the workspace is needed again.

import { config } from '../../../../../../config.js';
import logger from '../../../../../../lib/logger.js';
import ContainerBackend from './ContainerBackend.js';

function workspaceContainerPrefix() {
    return config.get('workspaceContainerPrefix') || 'workspace-local';
}

function isLocalAciEnvironment() {
    const env = String(config.get('env') || '').toLowerCase();
    return env === 'development' || env === 'test' || env === 'local' || env === 'debug';
}

function assertPrivateSubnetForAci(subnetId) {
    if (subnetId || isLocalAciEnvironment()) return;
    throw new Error('ACI_SUBNET_ID is required for ACI workspaces outside development/test/local environments');
}

export default class ACIBackend extends ContainerBackend {
    constructor() {
        super();
        this._clientPromise = null;
        this._shareClientPromise = null;
    }

    get backendName() {
        return 'aci';
    }

    get healthTimeoutMs() {
        return 180000;
    }

    get wakeHealthTimeoutMs() {
        return this.healthTimeoutMs;
    }

    /** Lazy-init the ACI management client (dynamic import to avoid loading Azure SDK for Docker users). */
    async _getClient() {
        if (!this._clientPromise) {
            this._clientPromise = (async () => {
                const { ContainerInstanceManagementClient } = await import('@azure/arm-containerinstance');
                const subscriptionId = config.get('azureSubscriptionId');
                if (!subscriptionId) throw new Error('AZURE_SUBSCRIPTION_ID is required for ACI backend');

                // Prefer explicit service principal from AZURE_SERVICE_PRINCIPAL_CREDENTIALS,
                // fall back to DefaultAzureCredential (managed identity, CLI, etc.)
                let credential;
                const spCredentials = config.get('azureServicePrincipalCredentials');
                if (spCredentials) {
                    const parsed = typeof spCredentials === 'string' ? JSON.parse(spCredentials) : spCredentials;
                    const tenantId = parsed.tenant_id || parsed.tenantId;
                    const clientId = parsed.client_id || parsed.clientId;
                    const clientSecret = parsed.client_secret || parsed.clientSecret;
                    if (tenantId && clientId && clientSecret) {
                        const { ClientSecretCredential } = await import('@azure/identity');
                        credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
                    }
                }
                if (!credential) {
                    const { DefaultAzureCredential } = await import('@azure/identity');
                    credential = new DefaultAzureCredential();
                }

                return new ContainerInstanceManagementClient(credential, subscriptionId);
            })();
        }
        return this._clientPromise;
    }

    /**
     * Resolve the storage account used for workspace Azure Files shares.
     * Prefers the dedicated workspace-files account so the workspace volume
     * can live in the same region as the ACI backend, while per-user blob
     * storage stays on AZURE_STORAGE_ACCOUNT_NAME (which may be in a
     * different region). Falls back to the blob account when not set.
     */
    _getWorkspaceFilesAccount() {
        const accountName = config.get('workspaceAzureFilesStorageAccountName')
            || config.get('azureStorageAccountName');
        const accountKey = config.get('workspaceAzureFilesStorageAccountKey')
            || config.get('azureStorageAccountKey');
        return { accountName, accountKey };
    }

    /** Lazy-init the Azure Files share service client. */
    async _getShareClient() {
        if (!this._shareClientPromise) {
            this._shareClientPromise = (async () => {
                const { ShareServiceClient, StorageSharedKeyCredential } = await import('@azure/storage-file-share');
                const { accountName, accountKey } = this._getWorkspaceFilesAccount();
                if (!accountName || !accountKey) throw new Error('WORKSPACE_AZURE_FILES_STORAGE_ACCOUNT_NAME/KEY (or AZURE_STORAGE_ACCOUNT_NAME/KEY as fallback) are required for ACI backend');
                const cred = new StorageSharedKeyCredential(accountName, accountKey);
                return new ShareServiceClient(`https://${accountName}.file.core.windows.net`, cred);
            })();
        }
        return this._shareClientPromise;
    }

    /** Ensure an Azure Files share exists for this workspace. */
    async _ensureFileShare(shareName) {
        const serviceClient = await this._getShareClient();
        const shareClient = serviceClient.getShareClient(shareName);
        try {
            await shareClient.create();
            logger.info(`[ACIBackend] Created Azure Files share: ${shareName}`);
        } catch (e) {
            if (e.statusCode === 409) {
                // 409 can mean the share exists OR a soft-deleted share has the same name.
                try {
                    await shareClient.getProperties();
                } catch {
                    throw new Error(
                        `Azure Files share '${shareName}' is soft-deleted and cannot be reused. ` +
                        `Restore or purge it, or disable soft-delete on the storage account.`
                    );
                }
            } else {
                throw e;
            }
        }
    }

    async createAndStart({ containerName, image, env, cpus, memoryMB, diskSize, shareName: explicitShareName, mountAzureFiles = false, tags = {} }) {
        const subnetId = config.get('aciSubnetId');
        assertPrivateSubnetForAci(subnetId);

        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const location = config.get('azureLocation');
        const acrServer = config.get('azureAcrServer');
        const acrUsername = config.get('azureAcrUsername');
        const acrPassword = config.get('azureAcrPassword');

        if (!resourceGroup) throw new Error('AZURE_RESOURCE_GROUP is required for ACI backend');

        const shareName = explicitShareName || null;
        let storageAccountName = null;
        let storageAccountKey = null;
        if (mountAzureFiles) {
            if (!shareName) throw new Error('shareName is required when mounting Azure Files');
            ({ accountName: storageAccountName, accountKey: storageAccountKey } = this._getWorkspaceFilesAccount());
            await this._ensureFileShare(shareName);
        }

        const fullImage = image.includes('/') ? image : (acrServer ? `${acrServer}/${image}` : image);

        const environmentVariables = env.map(e => {
            const eqIdx = e.indexOf('=');
            const name = e.slice(0, eqIdx);
            const value = e.slice(eqIdx + 1);
            const sensitiveKeys = ['WORKSPACE_SECRET', 'AZURE_BLOB_SAS_TOKEN'];
            if (sensitiveKeys.includes(name)) {
                return { name, secureValue: value };
            }
            return { name, value };
        });

        logger.info(`[ACIBackend] Creating container group ${containerName} in ${location}`);

        const useVNet = !!subnetId;

        const containerGroupDef = {
            location,
            osType: 'Linux',
            tags: {
                managedBy: 'cortex',
                cortexId: config.get('cortexId'),
                workspaceContainerPrefix: workspaceContainerPrefix(),
                ...(shareName ? { shareName } : {}),
                imageVersion: config.get('workspaceImageVersion') || '',
                ...tags,
            },
            // Runtime workspace auth/env are injected by /reconfigure after the
            // ACI resource is created. If the process dies, an ACI-level restart
            // would boot with the original bootstrap env and silently revert the
            // claimed entity workspace. Let Cortex reprovision instead.
            restartPolicy: 'Never',
            ipAddress: {
                type: useVNet ? 'Private' : 'Public',
                ports: [{ port: 3100, protocol: 'TCP' }],
                ...(useVNet ? {} : { dnsNameLabel: containerName }),
            },
            ...(useVNet ? { subnetIds: [{ id: subnetId }] } : {}),
            imageRegistryCredentials: acrServer ? [{
                server: acrServer,
                username: acrUsername,
                password: acrPassword,
            }] : undefined,
            containers: [{
                name: containerName,
                image: fullImage,
                resources: {
                    requests: {
                        cpu: cpus,
                        memoryInGB: memoryMB / 1024,
                    },
                },
                ports: [{ port: 3100, protocol: 'TCP' }],
                environmentVariables,
                securityContext: {
                    privileged: true, // Required for blobfuse2 FUSE mount
                },
                volumeMounts: [
                    { name: 'workspace-vol', mountPath: '/workspace' },
                    { name: 'persist-vol', mountPath: '/persist' },
                ],
            }],
            volumes: [
                {
                    name: 'workspace-vol',
                    emptyDir: {},
                },
                {
                    name: 'persist-vol',
                    ...(mountAzureFiles ? { azureFile: {
                        shareName,
                        storageAccountName,
                        storageAccountKey,
                    } } : { emptyDir: {} }),
                },
            ],
        };

        // Retry if ACI is still transitioning (e.g. a previous delete is in progress)
        let result;
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                const poller = await client.containerGroups.beginCreateOrUpdate(
                    resourceGroup,
                    containerName,
                    containerGroupDef,
                );
                result = await poller.pollUntilDone();
                break;
            } catch (e) {
                if (e.message?.includes('still transitioning') && attempt < 5) {
                    logger.info(`[ACIBackend] Container group ${containerName} transitioning, retrying in 10s...`);
                    await new Promise(r => setTimeout(r, 10000));
                } else {
                    throw e;
                }
            }
        }

        const url = this._getContainerGroupUrl(result);

        if (!url) {
            throw new Error(`ACI container group created but no ${useVNet ? 'private' : 'public'} IP assigned`);
        }

        const containerId = containerName;
        logger.info(`[ACIBackend] Container group ${containerName} created at ${url}`);
        return { containerId, url };
    }

    _getContainerGroupUrl(containerGroup) {
        const ip = containerGroup.ipAddress?.ip;
        const fqdn = containerGroup.ipAddress?.fqdn;
        return ip
            ? `http://${ip}:3100`
            : (fqdn ? `http://${fqdn}:3100` : null);
    }

    async stop(containerId, containerName) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const groupName = containerName || containerId;

        logger.info(`[ACIBackend] Stopping container group ${groupName}`);
        await client.containerGroups.stop(resourceGroup, groupName);
    }

    async start(containerId, containerName) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const groupName = containerName || containerId;

        logger.info(`[ACIBackend] Starting container group ${groupName}`);
        const poller = await client.containerGroups.beginStart(resourceGroup, groupName);
        await poller.pollUntilDone();

        const containerGroup = await client.containerGroups.get(resourceGroup, groupName);
        const url = this._getContainerGroupUrl(containerGroup);
        if (!url) {
            throw new Error(`ACI container group ${groupName} started but no IP assigned`);
        }

        logger.info(`[ACIBackend] Container group ${groupName} started at ${url}`);
        return { url };
    }

    async getContainerUrl(containerId, containerName) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const groupName = containerName || containerId;

        try {
            const containerGroup = await client.containerGroups.get(resourceGroup, groupName);
            return this._getContainerGroupUrl(containerGroup);
        } catch (e) {
            if (e.statusCode === 404) return null;
            throw e;
        }
    }

    async getContainerInfo(containerId, containerName) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const groupName = containerName || containerId;

        try {
            const containerGroup = await client.containerGroups.get(resourceGroup, groupName);
            return {
                exists: true,
                name: containerGroup.name || groupName,
                url: this._getContainerGroupUrl(containerGroup),
                provisioningState: containerGroup.provisioningState || null,
                instanceViewState: containerGroup.instanceView?.state || null,
                tags: containerGroup.tags || {},
                image: containerGroup.containers?.[0]?.image || null,
            };
        } catch (e) {
            if (e.statusCode === 404) {
                return { exists: false, name: groupName, url: null };
            }
            throw e;
        }
    }

    /**
     * Set an `entityId` Azure tag on a container group. Used to mark pool
     * containers as claimed so the orphan reconciler can distinguish
     * claimed-but-pool-named containers from true orphans without a Mongo lookup.
     */
    async setEntityTag(containerName, entityId) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const current = await client.containerGroups.get(resourceGroup, containerName);
        await client.containerGroups.update(resourceGroup, containerName, {
            tags: {
                ...(current.tags || {}),
                entityId,
                workspaceRole: 'entity',
            },
        });
    }

    async listWorkspaceContainers({ prefix = workspaceContainerPrefix() } = {}) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const matchPrefix = `${prefix}-`;
        const containers = [];

        for await (const group of client.containerGroups.listByResourceGroup(resourceGroup)) {
            if (!group.name?.startsWith(matchPrefix)) continue;
            containers.push({
                name: group.name,
                location: group.location || null,
                tags: group.tags || {},
                image: group.containers?.[0]?.image || null,
                provisioningState: group.provisioningState || null,
                instanceViewState: group.instanceView?.state || null,
                createdAt: group.tags?.createdAt || null,
                startedAt: group.containers?.[0]?.instanceView?.currentState?.startTime || null,
                ip: group.ipAddress?.ip || null,
                fqdn: group.ipAddress?.fqdn || null,
            });
        }

        return containers;
    }

    async remove(containerId, containerName) {
        const client = await this._getClient();
        const resourceGroup = config.get('azureResourceGroup');
        const groupName = containerName || containerId;

        logger.info(`[ACIBackend] Deleting container group ${groupName}`);
        try {
            const poller = await client.containerGroups.beginDelete(resourceGroup, groupName);
            await poller.pollUntilDone();
        } catch (e) {
            if (e.statusCode === 404) {
                // Already gone
            } else {
                throw e;
            }
        }
    }

    async destroyVolume(shareName) {
        try {
            const serviceClient = await this._getShareClient();
            const shareClient = serviceClient.getShareClient(shareName);
            await shareClient.delete();
            logger.info(`[ACIBackend] Deleted Azure Files share: ${shareName}`);
        } catch (e) {
            if (e.statusCode === 404) {
                // Share doesn't exist
            } else {
                logger.warn(`[ACIBackend] Failed to delete share ${shareName}: ${e.message}`);
            }
        }
    }
}
