import { createClient } from 'graphql-ws';
import ws from 'ws';

export function createWsClient(port = process.env.CORTEX_PORT || 4000) {
  return createClient({
    url: `ws://localhost:${port}/graphql`,
    webSocketImpl: ws,
    retryAttempts: 3,
    connectionParams: {},
  });
}

export async function ensureWsConnection(wsClient, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const subscription = wsClient.subscribe(
      {
        query: `
          subscription TestConnection {
            requestProgress(requestIds: ["test"]) {
              requestId
            }
          }
        `,
      },
      {
        next: () => resolve(),
        error: () => resolve(),
        complete: () => resolve(),
      }
    );

    setTimeout(() => resolve(), timeoutMs);
  });
}

export async function collectSubscriptionEvents(wsClient, subscription, timeout = 30000, options = {}) {
  const events = [];
  const { requireCompletion = true, minEvents = 1 } = options;

  return new Promise((resolve, reject) => {
    let timeoutId;

    const checkAndResolve = () => {
      if (!requireCompletion && events.length >= minEvents) {
        clearTimeout(timeoutId);
        unsubscribe();
        resolve(events);
      }
    };

    timeoutId = setTimeout(() => {
      if (events.length > 0) {
        resolve(events);
      } else {
        reject(new Error('Subscription timed out with no events'));
      }
    }, timeout);

    const unsubscribe = wsClient.subscribe(
      {
        query: subscription.query,
        variables: subscription.variables,
      },
      {
        next: (event) => {
          events.push(event);
          if (requireCompletion && event?.data?.requestProgress?.progress === 1) {
            clearTimeout(timeoutId);
            unsubscribe();
            resolve(events);
          } else {
            checkAndResolve();
          }
        },
        error: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        complete: () => {
          clearTimeout(timeoutId);
          resolve(events);
        },
      }
    );
  });
}

export function validateProgressMessage(t, progress, requestId = null) {
  t.truthy(progress);
  t.truthy(progress.requestId);
  t.truthy(progress.progress !== undefined);

  if (requestId) {
    t.is(progress.requestId, requestId);
  }

  if (progress.data) {
    t.true(typeof progress.data === 'string');
    t.notThrows(() => JSON.parse(progress.data));
  }

  if (progress.info) {
    t.true(typeof progress.info === 'string');
    t.notThrows(() => JSON.parse(progress.info));
  }

  if (progress.error) {
    t.true(typeof progress.error === 'string');
    t.notThrows(() => JSON.parse(progress.error));
  }
}


