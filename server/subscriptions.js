import pubsub from './pubsub.js';
import { withFilter } from 'graphql-subscriptions';
import { publishRequestProgressSubscription } from '../lib/redisSubscription.js';

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            (_, args, __, _info) => {
                publishRequestProgressSubscription(args.requestIds);
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
