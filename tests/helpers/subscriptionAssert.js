export function assertOAIStyleDeltaMessage(t, message) {
  const progress = message?.data?.requestProgress;
  t.truthy(progress);
  if (progress.data) {
    // Should be string of serialized JSON or plain text
    const text = JSON.parse(progress.data);
    t.true(typeof text === 'string' || typeof text === 'object');
  }
}


