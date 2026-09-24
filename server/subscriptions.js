import pubsub from './pubsub.js';
import { withFilter } from 'graphql-subscriptions';
import { publishRequestProgressSubscription } from '../lib/redisSubscription.js';
import logger from '../lib/logger.js';

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            (_, args, __, _info) => {
                logger.debug(`Client requested subscription for request ids: ${args.requestIds}`);
                const iterator = pubsub.asyncIterator(['REQUEST_PROGRESS']);
                const next = iterator.next.bind(iterator);
                let registered = false;
                iterator.next = (...values) => {
                    // PubSub registers lazily on next(); start/replay only once
                    // its listener exists, including synchronous completions.
                    const pending = next(...values);
                    if (!registered) {
                        registered = true;
                        void Promise.resolve().then(() => publishRequestProgressSubscription(args.requestIds))
                            .catch(error => logger.error(`Error registering subscription: ${error}`));
                    }
                    return pending;
                };
                return iterator;
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
