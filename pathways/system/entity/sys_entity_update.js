// Pathway to update entity settings.

import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import { encrypt, decrypt } from '../../../lib/crypto.js';
import { syncSecretsToWorkspace } from './tools/shared/workspace_client.js';
import logger from '../../../lib/logger.js';

const VALID_REASONING_EFFORTS = ['none', 'low', 'medium', 'high'];
const ENCRYPTION_KEY = process.env.REDIS_ENCRYPTION_KEY || null;

const decryptSecretsForWorkspace = (secrets, entityId) => {
    const decrypted = {};

    for (const [key, value] of Object.entries(secrets || {})) {
        const plain = decrypt(value, ENCRYPTION_KEY);
        if (plain === null || plain === undefined) {
            logger.warn(`Skipping secret '${key}' for entity ${entityId}: decryption failed`);
            continue;
        }
        decrypted[key] = plain;
    }

    return decrypted;
};

export default {
    prompt: [],
    inputParameters: {
        entityId: '',
        contextId: '',
        name: '',
        secrets: '',
        reasoningEffort: '',
    },
    model: 'oai-gpt41-mini',
    executePathway: async ({ args }) => {
        const { entityId, contextId, name, secrets: secretsJson, reasoningEffort } = args;

        if (!entityId) {
            return JSON.stringify({ error: 'entityId is required' });
        }
        if (!contextId) {
            return JSON.stringify({ error: 'contextId is required' });
        }

        try {
            const entityStore = getEntityStore();
            const entity = await entityStore.getEntity(entityId, { fresh: true });

            if (!entity) {
                return JSON.stringify({ error: 'Entity not found' });
            }

            if (!entity.assocUserIds || !entity.assocUserIds.includes(contextId)) {
                return JSON.stringify({ error: 'Not authorized to update this entity' });
            }

            const originalEntity = JSON.parse(JSON.stringify(entity));
            const result = { success: true };
            let nextWorkspaceSecrets = null;
            const shouldSyncRunningWorkspace =
                Boolean(secretsJson) &&
                entity.workspace?.url &&
                entity.workspace?.status === 'running';

            const trimmedName = String(name || '').trim();
            if (trimmedName) {
                entity.name = trimmedName;
                result.name = trimmedName;
            }

            if (secretsJson) {
                let incoming;
                try {
                    incoming = JSON.parse(secretsJson);
                } catch {
                    return JSON.stringify({ error: 'Invalid secrets JSON' });
                }

                const existing = entity.secrets || {};
                const merged = { ...existing };

                for (const [key, value] of Object.entries(incoming)) {
                    if (value === null) {
                        delete merged[key];
                    } else {
                        const encrypted = encrypt(String(value), ENCRYPTION_KEY);
                        if (encrypted === null) {
                            return JSON.stringify({ error: `Failed to encrypt secret ${key}` });
                        }
                        merged[key] = encrypted;
                    }
                }

                entity.secrets = Object.keys(merged).length > 0 ? merged : null;
                result.secretKeys = Object.keys(merged);
                nextWorkspaceSecrets = decryptSecretsForWorkspace(entity.secrets || {}, entityId);
            }

            if (reasoningEffort) {
                if (!VALID_REASONING_EFFORTS.includes(reasoningEffort)) {
                    return JSON.stringify({
                        error: `Invalid reasoningEffort: ${reasoningEffort}. Must be one of: ${VALID_REASONING_EFFORTS.join(', ')}`,
                    });
                }
                entity.reasoningEffort = reasoningEffort;
                result.reasoningEffort = reasoningEffort;
            }

            if (shouldSyncRunningWorkspace) {
                const syncResult = await syncSecretsToWorkspace(entityId, nextWorkspaceSecrets || {});
                if (!syncResult?.success) {
                    return JSON.stringify({
                        error: syncResult?.error || 'Failed to sync secrets to workspace',
                    });
                }

                const refreshedEntity = await entityStore.getEntity(entityId, { fresh: true });
                if (refreshedEntity?.workspace) {
                    entity.workspace = refreshedEntity.workspace;
                }
            }

            const upsertedId = await entityStore.upsertEntity(entity);
            if (!upsertedId) {
                if (shouldSyncRunningWorkspace) {
                    try {
                        await syncSecretsToWorkspace(
                            entityId,
                            decryptSecretsForWorkspace(originalEntity.secrets || {}, entityId),
                        );
                    } catch (rollbackError) {
                        logger.error(
                            `Failed to roll back workspace secrets for ${entityId}: ${rollbackError.message}`,
                        );
                    }
                }
                return JSON.stringify({ error: 'Failed to persist entity update' });
            }

            return JSON.stringify(result);
        } catch (error) {
            logger.error(`Error in sys_entity_update: ${error.message}`);
            return JSON.stringify({ error: error.message });
        }
    },
    json: true,
    manageTokenLength: false,
};
