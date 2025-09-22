import { connectToSSEEndpoint } from './sseClient.js';

export async function collectSSEChunks(baseUrl, endpoint, payload) {
  const chunks = [];
  await connectToSSEEndpoint(baseUrl, endpoint, payload, (chunk) => {
    chunks.push(chunk);
  });
  return chunks;
}

export function assertOAIChatChunkBasics(t, chunk) {
  t.truthy(chunk.id);
  t.is(chunk.object, 'chat.completion.chunk');
  t.truthy(chunk.choices && chunk.choices[0]);
  const choice = chunk.choices[0];
  t.true('delta' in choice);
}

export function assertAnyContentDelta(chunks) {
  return chunks.some(c => c?.choices?.[0]?.delta?.content);
}


