import test from "ava";

import AzureFoundryResponsesPlugin from "../../../server/plugins/azureFoundryResponsesPlugin.js";

const createPlugin = () => {
  const plugin = new AzureFoundryResponsesPlugin(
    { name: "bing_afagent", model: "azure-bing-agent-responses" },
    {
      name: "azure-bing-agent-responses",
      type: "AZURE-FOUNDRY-RESPONSES",
      requiresRequestModel: false,
      endpoints: [
        {
          name: "default",
          url: "https://example.test/responses",
          params: { "api-version": "2025-11-15-preview" },
        },
      ],
      maxTokenLength: 32768,
      maxReturnTokens: 4096,
    },
  );

  plugin.config = {
    get: (key) => {
      if (key === "azureAuthTokenHelper") {
        return {
          getAccessToken: async () => "test-token",
        };
      }
      if (key === "models") {
        return {};
      }
      if (key === "modelRedirects") {
        return {};
      }
      return null;
    },
  };

  return plugin;
};

test("execute adds Azure bearer token and strips query params from body", async (t) => {
  const plugin = createPlugin();
  let capturedRequest;

  plugin.getRequestParameters = async () => ({
    messages: [{ role: "user", content: "What is the capital of France?" }],
  });
  plugin.executeRequest = async (cortexRequest) => {
    capturedRequest = cortexRequest;
    return { output_text: "ok" };
  };

  await plugin.execute(
    "What is the capital of France?",
    {},
    null,
    {
      data: { "api-version": "2025-11-15-preview" },
      params: { "api-version": "2025-11-15-preview" },
      selectedEndpoint: {
        params: { "api-version": "2025-11-15-preview" },
      },
    },
  );

  t.is(capturedRequest.addHeaders.Authorization, "Bearer test-token");
  t.is(capturedRequest.data.model, undefined);
  t.is(capturedRequest.data["api-version"], undefined);
  t.deepEqual(capturedRequest.data.input, [
    { role: "user", content: "What is the capital of France?" },
  ]);
});

test("getRequestParameters strips generic Responses fields disallowed by hosted agents", async (t) => {
  const plugin = createPlugin();
  plugin.getCompiledPrompt = () => ({
    modelPromptText: "ping",
    modelPromptMessages: [{ role: "user", content: "ping" }],
    tokenLength: 1,
    modelPrompt: {},
  });

  const requestParameters = await plugin.getRequestParameters(
    "ping",
    {
      reasoningEffort: "medium",
      tools: JSON.stringify({
        functions: [{ name: "ExampleTool", parameters: { type: "object" } }],
      }),
      tool_choice: "auto",
      parallel_tool_calls: true,
    },
    {},
  );

  t.is(requestParameters.reasoning, undefined);
  t.is(requestParameters.tools, undefined);
  t.is(requestParameters.tool_choice, undefined);
  t.is(requestParameters.parallel_tool_calls, undefined);
  t.is(requestParameters.model, undefined);
  t.deepEqual(requestParameters.messages, [{ role: "user", content: "ping" }]);
});

test("removeAgentManagedBodyParams strips fields after execute adds inherited reasoning", (t) => {
  const plugin = createPlugin();
  const cortexRequest = {
    data: {
      model: "ignored",
      reasoning: { effort: "medium" },
      tools: [{ type: "function", name: "ExampleTool" }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      input: [{ role: "user", content: "ping" }],
      max_output_tokens: 4096,
      stream: false,
    },
  };

  plugin.removeAgentManagedBodyParams(cortexRequest);

  t.deepEqual(cortexRequest.data, {
    input: [{ role: "user", content: "ping" }],
    max_output_tokens: 4096,
    stream: false,
  });
});

test("execute fails clearly when Azure auth helper is unavailable", async (t) => {
  const plugin = createPlugin();
  plugin.config = { get: () => null };

  await t.throwsAsync(
    () => plugin.execute("ping", {}, null, { data: {}, params: {} }),
    { message: "azureAuthTokenHelper is not configured" },
  );
});

test("parseResponse preserves legacy bing_afagent JSON value shape", (t) => {
  const plugin = createPlugin();
  const result = plugin.parseResponse({
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "{\"results\":[{\"title\":\"Paris\"}]}",
          },
        ],
      },
    ],
  });

  t.deepEqual(JSON.parse(result), {
    value: "{\"results\":[{\"title\":\"Paris\"}]}",
  });
});
