import { getEntityStore } from '../../../lib/MongoEntityStore.js';
// Service-to-service outbox consumed by Concierge's existing scheduler. This is not
// exposed through a browser API. Acknowledge only after durable inbox insertion.
export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    json: true,
    manageTokenLength: false,
    inputParameters: { acknowledgedIds: '' },
    executePathway: async ({ args }) => {
        const outbox = await getEntityStore().colleagueOutbox();
        if (args.acknowledgedIds) {
            const ids = JSON.parse(args.acknowledgedIds);
            if (
                !Array.isArray(ids) ||
                ids.length > 100 ||
                ids.some((id) => typeof id !== 'string')
            )
                throw new Error('Invalid acknowledgement');
            await outbox.deleteMany({ _id: { $in: ids } });
        }
        return JSON.stringify({
            messages: await outbox.find({}).limit(100).toArray(),
        });
    },
};
