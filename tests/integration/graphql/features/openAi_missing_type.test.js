// openaimissingtype.test.js
import test from 'ava';
import http from 'http';
import serverFactory from '../../../../index.js';

let testServer;
let stub;
const STUB_PORT = 18081;

test.before(async () => {
  // Start a stub HTTP server that mimics OpenAI's chat completions endpoint
  stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        // Conditionally respond based on presence of typed content
        try {
          const parsed = JSON.parse(body || '{}');
          const first = parsed?.messages?.[0]?.content?.[0];
          const hasType = first && typeof first === 'object' && typeof first.type === 'string';

          if (hasType) {
            // Return a minimal success payload similar to OpenAI
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-stub',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'stub-ok' },
                  finish_reason: 'stop'
                }
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            }));
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: "Missing required parameter: 'messages[0].content[0].type'." } }));
          }
        } catch (_e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Bad Request' } }));
        }
      });
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not Found' } }));
    }
  });
  await new Promise(resolve => stub.listen(STUB_PORT, resolve));

  // Override models to point oai-gpt41 at the stub server
  const modelsOverride = {
    models: {
      "oai-gpt41": {
        name: "oai-gpt41",
        type: "OPENAI-VISION",
        endpoints: [
          {
            name: "stub",
            url: `http://localhost:${STUB_PORT}/v1/chat/completions`,
            headers: { "Content-Type": "application/json", "Authorization": "Bearer test" },
            params: { model: "gpt-4.1" },
            requestsPerSecond: 100,
          }
        ],
        requestsPerSecond: 100,
        maxTokenLength: 100000,
        maxReturnTokens: 8192,
        supportsStreaming: true
      }
    },
    defaultModelName: 'oai-gpt41'
  };

  const { server, startServer } = await serverFactory(modelsOverride);
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
  if (stub) {
    await new Promise(resolve => stub.close(resolve));
  }
});

// This test calls the GraphQL endpoint for the sys_openai_chat_gpt41 pathway
// and passes message content array items that are JSON strings representing
// objects WITHOUT the required `type` field. The plugin will parse these into
// objects but not add a `type` (current bug), then send to our stub which
// returns the target error.
test('GraphQL sys_openai_chat_gpt41 normalizes untyped content and succeeds (stubbed)', async (t) => {
  const query = `
    query ($messages: [MultiMessage]) {
      sys_openai_chat_gpt41(messages: $messages) {
        result
        errors
        debug
      }
    }
  `;

  const variables = {
    messages: [
      {
        role: "user",
        content: [
          JSON.stringify({ text: "You are in a role play game. Respond with one word." })
        ]
      }
    ]
  };

  const response = await testServer.executeOperation({ query, variables });

  const data = response?.body?.singleResult?.data;
  const gqlErrors = response?.body?.singleResult?.errors; // GraphQL-level errors (should be undefined)

  // GraphQL call itself should succeed and pathway should NOT return missing type error
  t.is(gqlErrors, undefined);
  t.truthy(data?.sys_openai_chat_gpt41);

  const pathwayErrors = data?.sys_openai_chat_gpt41?.errors || [];
  const combinedErrors = pathwayErrors.join("\n");

  t.false(combinedErrors.includes('Missing required parameter'));
  t.is(data?.sys_openai_chat_gpt41?.result, 'stub-ok');
});
