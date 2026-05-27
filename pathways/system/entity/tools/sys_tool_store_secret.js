import { getEntityStore } from '../../../../lib/MongoEntityStore.js';
import { config } from '../../../../config.js';
import { encrypt, decrypt } from '../../../../lib/crypto.js';
import { syncSecretsToWorkspace } from './shared/workspace_client.js';
import logger from '../../../../lib/logger.js';

const decryptSecretsForWorkspace = (secrets, systemKey) => {
    const plainSecrets = {};

    for (const [key, encryptedValue] of Object.entries(secrets || {})) {
        const plain = decrypt(encryptedValue, systemKey);
        if (plain === null || plain === undefined) {
            logger.warn(`Skipping secret '${key}' during workspace sync: decryption failed`);
            continue;
        }
        plainSecrets[key] = plain;
    }

    return plainSecrets;
};

export default {
    inputParameters: {
        name: '',
        value: '',
        entityId: '',
    },

    toolDefinition: [{
        type: 'function',
        category: 'system',
        icon: 'key',
        toolCost: 1,
        function: {
            name: 'StoreSecret',
            description: `Securely store an API key, token, or credential. The secret is encrypted and made available in the entity workspace as an environment variable and in /workspace/.env.

Use this when a user gives you an API key or token so future workspace commands can reference it by name. Set value to null to delete a secret.

Secret names must be UPPER_SNAKE_CASE, for example GITHUB_TOKEN or API_KEY.`,
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Secret name in UPPER_SNAKE_CASE',
                    },
                    value: {
                        type: 'string',
                        description: 'The secret value to store, or null to delete an existing secret',
                    },
                    userMessage: {
                        type: 'string',
                        description: 'Brief message to display while this action runs',
                    },
                },
                required: ['name', 'userMessage'],
            },
        },
    }],

    executePathway: async ({ args, resolver }) => {
        const { name, value, entityId } = args;

        try {
            if (!entityId) {
                return JSON.stringify({ success: false, error: 'entityId is required' });
            }

            if (!name || !/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
                return JSON.stringify({
                    success: false,
                    error: `Invalid secret name: "${name}". Use UPPER_SNAKE_CASE.`,
                });
            }

            const entityStore = getEntityStore();
            const entity = await entityStore.getEntity(entityId, { fresh: true });
            if (!entity) {
                return JSON.stringify({ success: false, error: 'Entity not found' });
            }

            const systemKey = config.get('redisEncryptionKey');
            const originalSecrets = JSON.parse(JSON.stringify(entity.secrets || {}));
            const merged = { ...(entity.secrets || {}) };
            const shouldSyncRunningWorkspace =
                entity.workspace?.url && entity.workspace?.status === 'running';

            if (value === null || value === undefined || value === '') {
                if (!merged[name]) {
                    return JSON.stringify({
                        success: true,
                        message: `Secret "${name}" was not set`,
                    });
                }
                delete merged[name];
            } else {
                merged[name] = encrypt(String(value), systemKey);
            }

            const nextEntity = {
                ...entity,
                secrets: Object.keys(merged).length > 0 ? merged : null,
            };

            if (shouldSyncRunningWorkspace) {
                const syncResult = await syncSecretsToWorkspace(
                    entityId,
                    decryptSecretsForWorkspace(nextEntity.secrets || {}, systemKey),
                );
                if (!syncResult?.success) {
                    return JSON.stringify({
                        success: false,
                        error: syncResult?.error || 'Failed to sync secrets to workspace',
                    });
                }

                const refreshedEntity = await entityStore.getEntity(entityId, { fresh: true });
                if (refreshedEntity?.workspace) {
                    nextEntity.workspace = refreshedEntity.workspace;
                }
            }

            const persistedId = await entityStore.upsertEntity(nextEntity);
            if (!persistedId) {
                if (shouldSyncRunningWorkspace) {
                    try {
                        await syncSecretsToWorkspace(
                            entityId,
                            decryptSecretsForWorkspace(originalSecrets, systemKey),
                        );
                    } catch (rollbackError) {
                        logger.error(
                            `Failed to roll back workspace secrets for ${entityId}: ${rollbackError.message}`,
                        );
                    }
                }

                return JSON.stringify({
                    success: false,
                    error: 'Failed to persist secret update',
                });
            }

            if (resolver) {
                resolver.tool = JSON.stringify({
                    toolUsed: 'StoreSecret',
                    action: value === null ? 'delete' : 'store',
                    name,
                });
            }

            const action = (value === null || value === undefined || value === '') ? 'deleted' : 'stored';
            logger.info(`Secret "${name}" ${action} for entity ${entityId}`);

            return JSON.stringify({
                success: true,
                message: `Secret "${name}" ${action} successfully. Available as $${name} in your workspace.`,
                secretKeys: Object.keys(merged),
            });
        } catch (error) {
            logger.error(`StoreSecret failed: ${error.message}`);
            return JSON.stringify({
                success: false,
                error: `Failed to store secret: ${error.message}`,
            });
        }
    },
};
