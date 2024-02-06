import pubsub from './pubsub.js';
import { withFilter } from 'graphql-subscriptions';
import { publishRequestProgressSubscription } from '../lib/redisSubscription.js';
import logger from '../lib/logger.js';

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            (_, args, __, _info) => {
                logger.debug(`Client requested subscription for request ids: ${args.requestIds}`);
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
