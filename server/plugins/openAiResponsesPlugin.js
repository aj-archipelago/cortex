// openAiResponsesPlugin.js
// Plugin for OpenAI's Responses API (agentic API format)
// Extends GrokResponsesPlugin since both use the Responses API format
// Key differences: tools format, instructions field, annotations handling

import GrokResponsesPlugin from "./grokResponsesPlugin.js";
import logger from "../../lib/logger.js";
import CortexResponse from "../../lib/cortexResponse.js";
import { requestState } from "../requestState.js";
import { addCitationsToResolver } from "../../lib/pathwayTools.js";

class OpenAIResponsesPlugin extends GrokResponsesPlugin {
  constructor(pathway, model) {
    super(pathway, model);
    this.hadToolCalls = false;
    this._responsesToolIndexMap = null;
  }

  getConfiguredModels() {
    return typeof this.config?.get === "function" ? this.config.get("models") : null;
  }

  getModelRedirects() {
    return typeof this.config?.get === "function" ? this.config.get("modelRedirects") : null;
  }

  // Resolve a model key to the deployment ID that should appear in the
  // request body. Looks up `configuredModels[key]` directly — does NOT route
  // through resolveModelName / pickGroupMember. The pathway resolver already
  // resolved any modelGroup alias to a concrete model at construction time
  // and stamped it on this.model; re-running the picker here is a footgun
  // because it is non-deterministic across calls (latency-driven), so a
  // second call within the same request can return a different group member
  // and desync the body model from the endpoint URL (404 DeploymentNotFound).
  resolveResponsesRequestModel(
    candidateModel,
    configuredModels = this.getConfiguredModels(),
    modelRedirects = this.getModelRedirects(),
  ) {
    if (typeof candidateModel !== "string") {
      return null;
    }

    const trimmedModel = candidateModel.trim();
    if (!trimmedModel) {
      return null;
    }

    const visited = new Set();
    let resolvedKey = trimmedModel;
    while (
      modelRedirects?.[resolvedKey] &&
      !visited.has(resolvedKey) &&
      configuredModels?.[modelRedirects[resolvedKey]]
    ) {
      visited.add(resolvedKey);
      resolvedKey = modelRedirects[resolvedKey];
    }

    const configuredModel = configuredModels?.[resolvedKey];
    return (
      configuredModel?.params?.model ||
      configuredModel?.endpoints?.[0]?.params?.model ||
      configuredModel?.emulateOpenAIChatModel ||
      configuredModel?.emulateOpenAICompletionModel ||
      resolvedKey
    );
  }

  getResponsesInputContent(input) {
    const items = Array.isArray(input) ? input : [input];
    return items
      .map((message) => {
        if (typeof message === "string") {
          return message;
        }
        if (!message || typeof message !== "object") {
          return "";
        }
        if (message.content === undefined) {
          return JSON.stringify(message);
        }
        if (Array.isArray(message.content)) {
          return message.content
            .map((item) =>
              typeof item === "string" ? item : JSON.stringify(item),
            )
            .join(", ");
        }
        return typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content);
      })
      .join("\n");
  }

  logResponsesRequestSize(input) {
    if (!input) {
      return;
    }

    const inputCount = Array.isArray(input) ? input.length : 1;
    const content = this.getResponsesInputContent(input);
    const { length, units } = this.getLength(content);

    logger.info(JSON.stringify({
      event: "model_request_size",
      apiFamily: "openai_responses",
      inputCount,
      characters: content.length,
      estimatedTokens: units === "tokens" ? length : undefined,
      estimateUnits: units,
      estimateValue: length,
    }));
  }

  // Override: Log OpenAI Responses API-specific messages
  logRequestData(data, responseData, prompt) {
    const { stream, input } = data;

    this.logResponsesRequestSize(input);

    if (!stream) {
      const parsedResponse = this.parseResponse(responseData);

      if (typeof parsedResponse === "string") {
        const { length, units } = this.getLength(parsedResponse);
        logger.info(
          `[openai responses response received containing ${length} ${units}]`,
        );
      } else {
        logger.info(`[openai responses response received containing object]`);
      }
    }

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }

  convertToolToResponsesFormat(tool) {
    if (!tool || typeof tool !== "object") return tool;
    if (tool.type !== "function" || !tool.function) return tool;

    const { function: fn, ...rest } = tool;
    return { ...rest, ...fn };
  }

  parseJsonLikeParameter(value, fallback = value) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
    try {
      return JSON.parse(trimmed);
    } catch {
      return fallback;
    }
  }

  normalizeFunctionsToResponsesTools(functions) {
    const parsedFunctions = this.parseJsonLikeParameter(functions, functions);
    if (!parsedFunctions) return [];
    const functionList = Array.isArray(parsedFunctions)
      ? parsedFunctions
      : [parsedFunctions];

    return functionList
      .filter((fn) => fn && typeof fn === "object")
      .map((fn) => ({
        type: "function",
        ...fn,
      }));
  }

  normalizeToolChoiceForResponses(toolChoice) {
    if (!toolChoice) return toolChoice;

    const parsedToolChoice = this.parseJsonLikeParameter(toolChoice, toolChoice);

    if (typeof parsedToolChoice === "string") {
      if (parsedToolChoice === "any") return "required";
      return parsedToolChoice;
    }

    if (!parsedToolChoice || typeof parsedToolChoice !== "object") {
      return parsedToolChoice;
    }

    if (
      parsedToolChoice.type === "auto" ||
      parsedToolChoice.type === "none" ||
      parsedToolChoice.type === "required"
    ) {
      return parsedToolChoice.type;
    }

    if (parsedToolChoice.type === "any") {
      return "required";
    }

    if (parsedToolChoice.function) {
      return {
        type: "function",
        name: parsedToolChoice.function.name || parsedToolChoice.function,
      };
    }

    if (parsedToolChoice.type === "tool") {
      return {
        type: "function",
        name:
          parsedToolChoice.name ||
          parsedToolChoice.function?.name ||
          parsedToolChoice.function,
      };
    }

    return parsedToolChoice;
  }

  normalizeFunctionCallForResponses(functionCall) {
    if (!functionCall) return functionCall;

    const parsedFunctionCall = this.parseJsonLikeParameter(functionCall, functionCall);
    if (typeof parsedFunctionCall === "string") {
      if (parsedFunctionCall === "none") return "none";
      if (parsedFunctionCall === "auto") return "auto";
      return { type: "function", name: parsedFunctionCall };
    }

    if (parsedFunctionCall && typeof parsedFunctionCall === "object") {
      const name = parsedFunctionCall.name || parsedFunctionCall.function?.name;
      if (name) {
        return { type: "function", name };
      }
    }

    return parsedFunctionCall;
  }

  // Override: OpenAI tools are function/code_interpreter, not web_search/x_search.
  // Responses API expects function tools flattened:
  //   { type: "function", name, description, parameters }
  validateAndTransformTools(tools) {
    if (Array.isArray(tools)) {
      return tools.map((tool) => this.convertToolToResponsesFormat(tool));
    }

    const toolsArray = [];

    if (tools.functions) {
      const functions = Array.isArray(tools.functions)
        ? tools.functions
        : [tools.functions];
      functions.forEach((fn) => {
        toolsArray.push({
          type: "function",
          ...fn,
        });
      });
    }

    if (tools.code_interpreter !== undefined) {
      const config =
        tools.code_interpreter === true ? {} : tools.code_interpreter || {};
      toolsArray.push({
        type: "code_interpreter",
        ...config,
      });
    }

    if (tools.file_search !== undefined) {
      const config = tools.file_search === true ? {} : tools.file_search || {};
      toolsArray.push({
        type: "file_search",
        ...config,
      });
    }

    if (tools.web_search_preview !== undefined) {
      const config =
        tools.web_search_preview === true ? {} : tools.web_search_preview || {};
      toolsArray.push({
        type: "web_search_preview",
        ...config,
      });
    }

    return toolsArray;
  }

  // Override: Handle OpenAI-specific params
  async getRequestParameters(text, parameters, prompt) {
    const requestParameters = await super.getRequestParameters(
      text,
      parameters,
      prompt,
    );

    this._legacyFunctionCallingRequest = Boolean(parameters.functions);

    // Handle instructions field (OpenAI Responses API system instructions)
    if (parameters.instructions) {
      requestParameters.instructions = parameters.instructions;
    }

    // Handle previous_response_id for conversation chaining
    if (parameters.previous_response_id) {
      requestParameters.previous_response_id = parameters.previous_response_id;
    }

    // Handle max_output_tokens (OpenAI uses this instead of max_tokens in Responses API)
    if (parameters.max_output_tokens) {
      requestParameters.max_output_tokens = parameters.max_output_tokens;
      delete requestParameters.max_tokens;
    } else if (requestParameters.max_tokens) {
      // Convert max_tokens to max_output_tokens for Responses API
      requestParameters.max_output_tokens = requestParameters.max_tokens;
      delete requestParameters.max_tokens;
    }

    // Handle reasoning configuration
    if (parameters.reasoning) {
      requestParameters.reasoning = parameters.reasoning;
    }

    // Handle truncation strategy
    if (parameters.truncation) {
      requestParameters.truncation = parameters.truncation;
    }

    // Remove inline_citations - not used by OpenAI Responses API
    delete requestParameters.inline_citations;

    // Override tools handling for OpenAI format
    if (parameters.tools) {
      try {
        const directTools =
          typeof parameters.tools === "string"
            ? JSON.parse(parameters.tools)
            : parameters.tools;

        requestParameters.tools = this.validateAndTransformTools(directTools);
      } catch (error) {
        logger.warn(`Invalid tools parameter, ignoring: ${error.message}`);
      }
    }

    const legacyFunctionTools = this.normalizeFunctionsToResponsesTools(
      parameters.functions,
    );
    if (legacyFunctionTools.length > 0) {
      const existingTools = Array.isArray(requestParameters.tools)
        ? requestParameters.tools
        : [];
      requestParameters.tools = [...existingTools, ...legacyFunctionTools];
    }

    if (!requestParameters.tool_choice && parameters.function_call) {
      requestParameters.tool_choice = this.normalizeFunctionCallForResponses(
        parameters.function_call,
      );
    }

    // Preserve raw Responses API input payload for passthrough fidelity when provided by REST adapter.
    if (
      typeof parameters.responses_input_json === "string" &&
      parameters.responses_input_json.trim() !== ""
    ) {
      try {
        requestParameters.input = JSON.parse(parameters.responses_input_json);
        delete requestParameters.messages;
      } catch (error) {
        logger.warn(
          `Invalid responses_input_json parameter, falling back to messages conversion: ${error.message}`,
        );
      }
    }

    return requestParameters;
  }

  normalizeResponsesApiInput(messages) {
    if (!Array.isArray(messages)) {
      return messages;
    }

    const input = [];

    for (const message of messages) {
      if (!message || typeof message !== "object") {
        input.push(message);
        continue;
      }

      const { role, content, tool_calls, tool_call_id } = message;

      if (role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: tool_call_id || "",
          output:
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => c.text || JSON.stringify(c)).join("")
                : JSON.stringify(content || ""),
        });
        continue;
      }

      const isAssistant = role === "assistant";
      let normalizedContent = content;
      if (Array.isArray(content)) {
        normalizedContent = content.map((item) => {
          if (!item || typeof item !== "object") {
            return item;
          }

          if (item.type === "text") {
            return {
              ...item,
              type: isAssistant ? "output_text" : "input_text",
            };
          }

          if (item.type === "image_url") {
            const url = typeof item.image_url === "string" ? item.image_url : item.image_url?.url;
            return {
              type: "input_image",
              image_url: url,
            };
          }

          return item;
        });
      }

      if (isAssistant && tool_calls && tool_calls.length > 0) {
        if (normalizedContent) {
          input.push({ role, content: normalizedContent });
        }

        for (const tc of tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id || "",
            name: tc.function?.name || "",
            arguments: tc.function?.arguments || "{}",
          });
        }
        continue;
      }

      const normalizedMessage = { ...message, content: normalizedContent };
      delete normalizedMessage.tool_calls;
      delete normalizedMessage.tool_call_id;
      input.push(normalizedMessage);
    }

    return input;
  }

  // Override: Parse OpenAI Responses API format
  parseResponsesApiFormat(data) {
    // Extract output text - can be in output_text or output array
    let outputText = data.output_text || (typeof data.text === "string" ? data.text : "") || "";

    // If output is an array (OpenAI Responses format), extract text from it
    if (data.output && Array.isArray(data.output)) {
      const textItems = data.output
        .filter((item) => item && (item.type === "message" || item.content))
        .map((item) => {
          if (
            item.type === "message" &&
            item.content &&
            Array.isArray(item.content)
          ) {
            return item.content
              .filter((c) => c.type === "output_text" || c.type === "text")
              .map((c) => c.text)
              .join("");
          }
          return "";
        });

      if (textItems.length > 0) {
        outputText = textItems.join("");
      }
    }

    const cortexResponse = new CortexResponse({
      output_text: outputText,
      finishReason: data.status || "completed",
      usage: data.usage || null,
      metadata: {
        model: this.modelName,
        id: data.id,
      },
    });

    // Handle function call outputs from OpenAI Responses API
    if (data.output && Array.isArray(data.output)) {
      const functionCalls = data.output
        .filter((item) => item && item.type === "function_call")
        .map((item) => ({
          id: item.call_id || item.id,
          type: "function",
          function: {
            name: item.name,
            arguments:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments || {}),
          },
        }));

      if (functionCalls.length > 0) {
        if (this._legacyFunctionCallingRequest) {
          cortexResponse.functionCall = functionCalls[0].function;
        } else {
          cortexResponse.toolCalls = functionCalls;
        }
      }
    }

    // Handle annotations from OpenAI Responses API
    // Annotations can include url_citation, file_citation, file_path
    let annotations = [];

    if (data.output && Array.isArray(data.output)) {
      data.output.forEach((item) => {
        if (
          item.type === "message" &&
          item.content &&
          Array.isArray(item.content)
        ) {
          item.content.forEach((contentBlock) => {
            if (
              contentBlock.annotations &&
              Array.isArray(contentBlock.annotations)
            ) {
              contentBlock.annotations.forEach((annotation) => {
                if (annotation.type === "url_citation") {
                  annotations.push({
                    type: "url_citation",
                    url: annotation.url,
                    title:
                      annotation.title ||
                      this.extractTitleFromUrl(annotation.url),
                    start_index: annotation.start_index,
                    end_index: annotation.end_index,
                  });
                } else if (annotation.type === "file_citation") {
                  annotations.push({
                    type: "file_citation",
                    file_id: annotation.file_id,
                    quote: annotation.quote,
                    start_index: annotation.start_index,
                    end_index: annotation.end_index,
                  });
                } else if (annotation.type === "file_path") {
                  annotations.push({
                    type: "file_path",
                    file_id: annotation.file_id,
                    start_index: annotation.start_index,
                    end_index: annotation.end_index,
                  });
                }
              });
            }
          });
        }
      });
    }

    // Convert URL citations to standard citations format for compatibility
    if (annotations.length > 0) {
      const urlCitations = annotations.filter((a) => a.type === "url_citation");
      if (urlCitations.length > 0) {
        cortexResponse.citations = urlCitations.map((a) => ({
          title: a.title,
          url: a.url,
          content: a.title,
        }));
      }
      // Store all annotations in metadata for full fidelity
      cortexResponse.metadata.annotations = annotations;
    }

    // Handle reasoning/thinking output
    if (data.output && Array.isArray(data.output)) {
      const reasoningItems = data.output
        .filter((item) => item && item.type === "reasoning")
        .map((item) => item.summary || item.content || "");

      if (reasoningItems.length > 0) {
        cortexResponse.metadata.reasoning = reasoningItems.join("\n");
      }
    }

    return cortexResponse;
  }

  // Helper to extract title from URL
  extractTitleFromUrl(url) {
    try {
      const urlObj = new URL(url);
      // Extract domain as fallback title
      return urlObj.hostname.replace(/^www\./, "");
    } catch (e) {
      return url;
    }
  }

  toChatCompletionsChunk(delta = {}, finishReason = null) {
    return JSON.stringify({
      choices: [
        {
          delta,
          finish_reason: finishReason,
        },
      ],
    });
  }

  getToolCallFinishReason() {
    return this._legacyFunctionCallingRequest ? "function_call" : "tool_calls";
  }

  // OpenAI Responses streaming emits response.* lifecycle events.
  // Convert them back to chat-completions chunks for non-REST consumers.
  // Direct /v1/responses passthrough bypasses this plugin and keeps raw SSE.
  processStreamEvent(event, requestProgress) {
    if (event.data.trim() === "[DONE]") {
      return super.processStreamEvent(event, requestProgress);
    }

    let parsedMessage;
    try {
      parsedMessage = JSON.parse(event.data);
    } catch (_error) {
      return super.processStreamEvent(event, requestProgress);
    }

    const type = parsedMessage?.type;
    const delta = parsedMessage?.delta;

    if (type === "response.output_text.delta" || type === "content_block_delta") {
      const textDelta =
        typeof delta === "string"
          ? delta
          : delta?.text || parsedMessage?.text || "";
      if (textDelta) {
        this.contentBuffer += textDelta;
        requestProgress.data = this.toChatCompletionsChunk({ content: textDelta });
      }
      return requestProgress;
    }

    if (
      type === "response.output_item.added" &&
      parsedMessage.item?.type === "function_call"
    ) {
      const item = parsedMessage.item;
      const index = this.toolCallsBuffer.length;
      this.hadToolCalls = true;
      this.toolCallsBuffer[index] = {
        id: item.call_id || item.id || "",
        type: "function",
        function: {
          name: item.name || "",
          arguments: item.arguments || "",
        },
      };
      this._responsesToolIndexMap = this._responsesToolIndexMap || new Map();
      this._responsesToolIndexMap.set(parsedMessage.output_index, index);
      if (this._legacyFunctionCallingRequest) {
        requestProgress.data = this.toChatCompletionsChunk({
          function_call: {
            name: item.name || "",
            arguments: item.arguments || "",
          },
        });
      } else {
        requestProgress.data = this.toChatCompletionsChunk({
          tool_calls: [
            {
              index,
              id: item.call_id || item.id || "",
              type: "function",
              function: {
                name: item.name || "",
                arguments: "",
              },
            },
          ],
        });
      }
      return requestProgress;
    }

    if (type === "response.function_call_arguments.delta") {
      const index = this._responsesToolIndexMap?.get(parsedMessage.output_index) ?? 0;
      if (this.toolCallsBuffer[index]) {
        this.toolCallsBuffer[index].function.arguments += parsedMessage.delta || "";
      }
      if (this._legacyFunctionCallingRequest) {
        requestProgress.data = this.toChatCompletionsChunk({
          function_call: {
            arguments: parsedMessage.delta || "",
          },
        });
      } else {
        requestProgress.data = this.toChatCompletionsChunk({
          tool_calls: [
            {
              index,
              function: {
                arguments: parsedMessage.delta || "",
              },
            },
          ],
        });
      }
      return requestProgress;
    }

    if (type === "response.function_call_arguments.done") {
      const index = this._responsesToolIndexMap?.get(parsedMessage.output_index) ?? 0;
      if (this.toolCallsBuffer[index] && parsedMessage.arguments) {
        this.toolCallsBuffer[index].function.arguments = parsedMessage.arguments;
      }
      requestProgress.data = null;
      return requestProgress;
    }

    if (
      type === "response.output_item.done" &&
      parsedMessage.item?.type === "function_call"
    ) {
      requestProgress.data = null;
      return requestProgress;
    }

    if (typeof type === "string" && type.startsWith("response.")) {
      if (
        type === "response.completed" ||
        type === "response.done" ||
        type === "response.failed" ||
        type === "response.cancelled" ||
        type === "response.incomplete"
      ) {
        const isSuccessfulTerminal =
          type === "response.completed" || type === "response.done";

        if (isSuccessfulTerminal && this.toolCallsBuffer.length > 0) {
          const pathwayResolver = requestState[this.requestId]?.pathwayResolver;
          if (this.pathwayToolCallback && pathwayResolver) {
            const validToolCalls = this.toolCallsBuffer.filter(
              (tc) => tc && tc.function && tc.function.name,
            );
            if (validToolCalls.length > 0) {
              const toolMessage = {
                role: "assistant",
                content: this.contentBuffer || "",
                tool_calls: validToolCalls,
              };
              pathwayResolver._streamingToolCallbackPromise = this.pathwayToolCallback(
                pathwayResolver?.args,
                toolMessage,
                pathwayResolver,
              );
              requestProgress.toolCallbackInvoked = true;
              requestProgress.data = this.toChatCompletionsChunk({}, this.getToolCallFinishReason());
            }
          }
        }

        const finalResponse = parsedMessage.response || parsedMessage;
        if (
          isSuccessfulTerminal &&
          Array.isArray(finalResponse.output) &&
          !requestProgress.toolCallbackInvoked
        ) {
          const functionCalls = finalResponse.output
            .filter((item) => item?.type === "function_call" && item.name)
            .map((item) => ({
              id: item.call_id || item.id || "",
              type: "function",
              function: {
                name: item.name,
                arguments:
                  typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments || {}),
              },
            }));

          if (functionCalls.length > 0) {
            const pathwayResolver = requestState[this.requestId]?.pathwayResolver;
            if (this.pathwayToolCallback && pathwayResolver) {
              const toolMessage = {
                role: "assistant",
                content: this.contentBuffer || "",
                tool_calls: functionCalls,
              };
              pathwayResolver._streamingToolCallbackPromise = this.pathwayToolCallback(
                pathwayResolver?.args,
                toolMessage,
                pathwayResolver,
              );
              requestProgress.toolCallbackInvoked = true;
              requestProgress.data = this.toChatCompletionsChunk({}, this.getToolCallFinishReason());
            }
          }
        }

        if (!requestProgress.toolCallbackInvoked) {
          if (
            type === "response.failed" ||
            type === "response.cancelled" ||
            type === "response.incomplete"
          ) {
            const errorMessage =
              parsedMessage.error?.message ||
              parsedMessage.response?.error?.message ||
              parsedMessage.incomplete_details?.reason ||
              parsedMessage.response?.incomplete_details?.reason ||
              "Stream error";
            requestProgress.data = this.toChatCompletionsChunk({
              content: `The model stream ended before returning a complete response: ${errorMessage}`,
            }, "stop");
            requestProgress.error = errorMessage;
          } else {
            const finishReason =
              isSuccessfulTerminal && this.toolCallsBuffer.length > 0
                ? this.getToolCallFinishReason()
                : "stop";
            requestProgress.data = this.toChatCompletionsChunk({}, finishReason);
          }
          requestProgress.progress = 1;
        }

        // Extract citations before clearing buffers
        const resolver = requestState[this.requestId]?.pathwayResolver;
        if (resolver && this.contentBuffer) {
          // Extract URL citations from annotations in the final response
          let directCitations = null;
          if (Array.isArray(finalResponse.output)) {
            const urlCitations = [];
            for (const item of finalResponse.output) {
              if (item?.type === "message" && Array.isArray(item.content)) {
                for (const block of item.content) {
                  if (Array.isArray(block.annotations)) {
                    for (const ann of block.annotations) {
                      if (ann.type === "url_citation") {
                        urlCitations.push({
                          title: ann.title || this.extractTitleFromUrl(ann.url),
                          url: ann.url,
                          content: ann.title || this.extractTitleFromUrl(ann.url),
                        });
                      }
                    }
                  }
                }
              }
            }
            if (urlCitations.length > 0) {
              directCitations = urlCitations;
            }
          }
          addCitationsToResolver(resolver, this.contentBuffer, directCitations);
        }

        this.toolCallsBuffer = [];
        this._responsesToolIndexMap = null;
        this.hadToolCalls = false;
        this.contentBuffer = "";
        this.citationsBuffer = [];
        this.inlineCitationsBuffer = [];
      }

      return requestProgress;
    }

    return super.processStreamEvent(event, requestProgress);
  }

  // Override execute to handle OpenAI Responses API specifics
  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = await this.getRequestParameters(
      text,
      parameters,
      prompt,
    );
    const { stream } = parameters;

    const normalizeReasoningEffort = (value) => {
      if (value === undefined || value === null) return null;
      const effort = (typeof value === "string" ? value : String(value))
        .trim()
        .toLowerCase();
      return effort || null;
    };

    const mapReasoningEffort = (effort) => {
      if (!effort) return null;
      const mappedEffort = this.model?.reasoningEffortMap?.[effort];
      return normalizeReasoningEffort(mappedEffort || effort);
    };

    if (typeof requestParameters.reasoning === "string") {
      const rawReasoning = requestParameters.reasoning.trim();
      if (rawReasoning) {
        try {
          requestParameters.reasoning = JSON.parse(rawReasoning);
        } catch (_error) {
          const normalizedEffort = normalizeReasoningEffort(rawReasoning);
          if (normalizedEffort) {
            requestParameters.reasoning = { effort: normalizedEffort };
          } else {
            delete requestParameters.reasoning;
          }
        }
      } else {
        delete requestParameters.reasoning;
      }
    }

    const hasReasoningObject =
      requestParameters.reasoning &&
      typeof requestParameters.reasoning === "object" &&
      !Array.isArray(requestParameters.reasoning);

    if (!hasReasoningObject) {
      const normalizedEffort = normalizeReasoningEffort(
        requestParameters.reasoningEffort ??
          requestParameters.reasoning_effort ??
          parameters.reasoningEffort ??
          parameters.reasoning_effort,
      );
      const mappedEffort = mapReasoningEffort(normalizedEffort);

      if (mappedEffort) {
        requestParameters.reasoning = { effort: mappedEffort };
      }
    } else if (typeof requestParameters.reasoning.effort === "string") {
      const mappedEffort = mapReasoningEffort(
        normalizeReasoningEffort(requestParameters.reasoning.effort),
      );
      if (mappedEffort) {
        requestParameters.reasoning = {
          ...requestParameters.reasoning,
          effort: mappedEffort,
        };
      } else {
        const { effort, ...reasoningWithoutEffort } =
          requestParameters.reasoning;
        requestParameters.reasoning = reasoningWithoutEffort;
      }
    }

    delete requestParameters.reasoningEffort;
    delete requestParameters.reasoning_effort;

    const configuredModels = this.getConfiguredModels();

    // Normalize a model key (e.g. `oai-gpt54`) on the request to the external
    // deployment ID (e.g. `gpt-5.4`). Only direct config lookup — no picker.
    const normalizedRequestModel = this.resolveResponsesRequestModel(
      requestParameters.model,
      configuredModels,
    );
    if (normalizedRequestModel) {
      requestParameters.model = normalizedRequestModel;
    }

    // Azure/OpenAI v1 responses endpoints require an explicit model in body.
    // Read it from the model config the resolver already chose. Do NOT pull
    // from `parameters.model` — it may still hold the original modelGroup
    // alias (e.g. `cortex-agent-chat`), and re-routing it here can pick a
    // different group member than the one this.model represents, which
    // desyncs body model from endpoint URL.
    if (!requestParameters.model) {
      const pathwayModelKey =
        typeof this.promptParameters?.model === "string"
          ? this.promptParameters.model
          : null;
      const pathwayModelConfig =
        pathwayModelKey && configuredModels
          ? configuredModels[pathwayModelKey]
          : null;

      const configuredModel =
        this.model.params?.model ||
        this.model.endpoints?.[0]?.params?.model ||
        pathwayModelConfig?.params?.model ||
        pathwayModelConfig?.endpoints?.[0]?.params?.model ||
        this.model.emulateOpenAIChatModel ||
        this.model.emulateOpenAICompletionModel ||
        pathwayModelConfig?.emulateOpenAIChatModel ||
        pathwayModelConfig?.emulateOpenAICompletionModel;
      if (configuredModel) {
        requestParameters.model = configuredModel;
      } else {
        logger.warn(
          `[openai responses] Could not resolve request model for pathway=${this.pathwayName}, ` +
            `pathwayModelKey=${pathwayModelKey}, endpointName=${this.model?.name || "unknown"}`,
        );
      }
    }

    // Convert messages format to input format for Responses API
    // The Responses API uses "input" array instead of "messages"
    if (requestParameters.messages) {
      requestParameters.input = this.normalizeResponsesApiInput(
        requestParameters.messages,
      );
      delete requestParameters.messages;
    }

    if (requestParameters.tools && Array.isArray(requestParameters.tools)) {
      requestParameters.tools = requestParameters.tools.map((tool) =>
        this.convertToolToResponsesFormat(tool),
      );
    }

    if (requestParameters.response_format) {
      requestParameters.text = { format: requestParameters.response_format };
      delete requestParameters.response_format;
    }

    if (requestParameters.tool_choice) {
      requestParameters.tool_choice = this.normalizeToolChoiceForResponses(
        requestParameters.tool_choice,
      );
    }

    // Ensure we don't send chat completion params to Responses API
    delete requestParameters.frequency_penalty;
    delete requestParameters.presence_penalty;
    delete requestParameters.logit_bias;
    delete requestParameters.logprobs;
    delete requestParameters.top_logprobs;
    delete requestParameters.n;
    delete requestParameters.stop;
    delete requestParameters.user;
    delete requestParameters.temperature;
    delete requestParameters.top_p;
    delete requestParameters.functions;
    delete requestParameters.function_call;

    cortexRequest.data = {
      ...(cortexRequest.data || {}),
      ...requestParameters,
    };
    cortexRequest.params = {}; // query params
    cortexRequest.stream = stream;

    return this.executeRequest(cortexRequest);
  }
}

export default OpenAIResponsesPlugin;
