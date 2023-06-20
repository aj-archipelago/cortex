// TODO: Replace PubSub class with PubSub engine to support
//       multi-server instance
// See https://www.apollographql.com/docs/apollo-server/v3/data/subscriptions/#resolving-a-subscription

import pubsub from './pubsub.js';

import { withFilter } from 'graphql-subscriptions';
import { requestState } from './requestState.js';

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            (_, args, __, _info) => {
                const { requestIds } = args;
                for (const requestId of requestIds) {
                    if (!requestState[requestId]) {
                        console.log(`requestProgress, requestId: ${requestId} not found`);
                    } else {
                        console.log(`starting async requestProgress, requestId: ${requestId}`);
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
