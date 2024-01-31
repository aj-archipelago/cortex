import { PubSub } from 'graphql-subscriptions';
const pubsub = new PubSub();
pubsub.ee.setMaxListeners(300);

export default pubsub;
