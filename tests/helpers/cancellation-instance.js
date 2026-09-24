import { requestState } from '../../server/requestState.js';
import { armRequestDeadline } from '../../server/requestCancellation.js';
import { cancelRequestResolver } from '../../server/resolver.js';
import { subscriptionClient, publishRequestProgressSubscription } from '../../lib/redisSubscription.js';

await subscriptionClient.subscribe('requestCancellation', 'requestProgressSubscriptions');
process.send({ ready: true });
process.on('message', async ({ action, requestId, deadline, seq }) => {
    try {
        if (action === 'register') {
            requestState[requestId] = {
                abortRequest() { process.send({ aborted: requestId }); },
                resolver() { process.send({ started: requestId, canceled: !!requestState[requestId].canceled }); },
            };
            if (deadline) armRequestDeadline(requestId, deadline);
        } else if (action === 'cancel') {
            await cancelRequestResolver(null, { requestId }, { requestState });
        } else if (action === 'subscribe') {
            await publishRequestProgressSubscription([requestId]);
        }
        process.send({ seq, hasLocalState: !!requestState[requestId] });
    } catch (error) { process.send({ seq, error: error.message }); }
});
