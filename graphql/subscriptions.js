// TODO: Replace PubSub class with PubSub engine to support
//       multi-server instance
// See https://www.apollographql.com/docs/apollo-server/v3/data/subscriptions/#resolving-a-subscription

const pubsub = require("./pubsub");
const { withFilter } = require("graphql-subscriptions");

const subscriptions = {
    requestProgress: {
        subscribe: withFilter(
            () => pubsub.asyncIterator(['REQUEST_PROGRESS']),
            (payload, variables) => {
                return (
                    payload.requestProgress.requestId === variables.requestId
                );
            },
        ),
    },
};

module.exports = subscriptions;
