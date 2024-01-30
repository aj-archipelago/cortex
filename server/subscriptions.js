import pubsub from './pubsub.js';

import { withFilter } from 'graphql-subscriptions';
import { requestState } from './requestState.js';

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            (_, args, __, _info) => {
                const { requestIds } = args;
                for (const requestId of requestIds) {
                    if (requestState[requestId] && !requestState[requestId].started) {
                        requestState[requestId].started = true;
                        console.log(`Subscription starting async requestProgress, requestId: ${requestId}`);
                        const { resolver, args } = requestState[requestId];
                        resolver(args);
                    }
                }
                return pubsub.asyncIterator(['REQUEST_PROGRESS'])
            },
            (payload, variables) => {
                return (
                    variables.requestIds.includes(payload.requestProgress.requestId)
                );
            },
        ),
    },
};

export default subscriptions;
