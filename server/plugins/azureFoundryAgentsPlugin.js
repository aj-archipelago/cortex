// AzureFoundryAgentsPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import axios from 'axios';

class AzureFoundryAgentsPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Convert to Azure Foundry Agents messages array format
    convertToAzureFoundryMessages(context, examples, messages) {
        let azureMessages = [];
        
        // Add context as a system message if provided
        if (context) {
            azureMessages.push({
                role: 'system',
                content: context,
            });
        }
        
        // Add examples to the messages array
        if (examples && examples.length > 0) {
            examples.forEach(example => {
                azureMessages.push({
                    role: example.input.author || 'user',
                    content: example.input.content,
                });
                azureMessages.push({
                    role: example.output.author || 'assistant',
                    content: example.output.content,
                });
            });
        }
        
        // Add remaining messages to the messages array
        messages.forEach(message => {
            azureMessages.push({
                role: message.author,
                content: message.content,
            });
        });
        
        return azureMessages;
    }

    // Set up parameters specific to the Azure Foundry Agents API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText, modelPromptMessages, tokenLength, modelPrompt } = this.getCompiledPrompt(text, parameters, prompt);
        const { stream } = parameters;
    
        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxPromptTokens();
    
        let requestMessages = modelPromptMessages || [{ "role": "user", "content": modelPromptText }];
        
        // Check if the messages are in Palm format and convert them to Azure format if necessary
        const isPalmFormat = requestMessages.some(message => 'author' in message);
        if (isPalmFormat) {
            const context = modelPrompt.context || '';
            const examples = modelPrompt.examples || [];
            requestMessages = this.convertToAzureFoundryMessages(context, examples, modelPromptMessages);
        }
    
        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength && this.promptParameters?.manageTokenLength) {
            // Remove older messages until the token length is within the model's limit
            requestMessages = this.truncateMessagesToTargetLength(requestMessages, modelTargetTokenLength);
        }
    
        const requestParameters = {
            assistant_id: this.assistantId,
            thread: {
                messages: requestMessages
            },
            stream: stream || false,
            instructions: `You are a Bing search agent responding to user queries.

Instructions:
- Always use your search tools and perform Bing searches before answering
- Retrieve only the most recent, credible, and relevant results using strict date filters.
- Exclude or explicitly tag outdated, speculative, forum, sponsored, or low-quality sources (e.g., Reddit, Quora, clickbait sites).
- Prioritize accuracy, factual precision, and clarity. Deduplicate similar results; show only unique, high-value sources.

Response Format:
- Precise citations are critical - make sure that each topic has a separate paragraph in your response and that each paragraph has direct citations
- Return the original search results with titles/snippets and direct citations only.
- Do not include notes, explanations, questions, commentary or any additional output.

Your only task is to deliver up-to-date, authoritative, and concise results—nothing else.`,
            tools: [
                {
                    type: "bing_grounding",
                    bing_grounding: {
                        search_configurations: [
                            {
                                connection_id: "/subscriptions/a5d766fd-4656-43fa-b8dd-ec7dfa3bf416/resourceGroups/Archipelago-ML-Experimentation/providers/Microsoft.CognitiveServices/accounts/archipelago-foundry-resource/projects/archipelago-foundry/connections/archipelagobingsearchgrounding",
                                count: 25,
                                freshness: "week",
                                market: "en-us",
                                set_lang: "en"
                            }
                        ]
                    }                
                }
            ],
            parallel_tool_calls: true,
            // Add any additional parameters that might be needed
            // ...(parameters.tools && { tools: parameters.tools }),
            ...(parameters.tool_resources && { tool_resources: parameters.tool_resources }),
            ...(parameters.metadata && { metadata: parameters.metadata }),
            ...(parameters.instructions && { instructions: parameters.instructions }),
            ...(parameters.model && { model: parameters.model }),
            ...(parameters.temperature && { temperature: parameters.temperature }),
            ...(parameters.max_tokens && { max_tokens: parameters.max_tokens }),
            ...(parameters.top_p && { top_p: parameters.top_p }),
            ...(parameters.tool_choice && { tool_choice: parameters.tool_choice }),
            ...(parameters.response_format && { response_format: parameters.response_format }),
            // ...(parameters.parallel_tool_calls && { parallel_tool_calls: parameters.parallel_tool_calls }),
            ...(parameters.truncation_strategy && { truncation_strategy: parameters.truncation_strategy })
        };
    
        return requestParameters;
    }

    // Assemble and execute the request to the Azure Foundry Agents API
    async execute(text, parameters, prompt, cortexRequest) {
        this.baseUrl = cortexRequest.url;
        this.assistantId = cortexRequest.params.assistant_id;

        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        // Set up the request for Azure Foundry Agents
        cortexRequest.url = `${this.baseUrl}/threads/runs`;
        cortexRequest.data = requestParameters;

        // Get authentication token and add to headers
        const azureAuthTokenHelper = this.config.get('azureAuthTokenHelper');
        let authToken = null;
        if (azureAuthTokenHelper) {
            try {
                authToken = await azureAuthTokenHelper.getAccessToken();
            } catch (error) {
                logger.warn(`[Azure Foundry Agent] Failed to get auth token: ${error.message}`);
                // Continue without auth token
            }
        }
        
        cortexRequest.headers = {
            'Content-Type': 'application/json',
            ...cortexRequest.headers,
            ...(authToken && { 'Authorization': `Bearer ${authToken}` })
        };

        // Execute the initial request to create the run
        const runResponse = await this.executeRequest(cortexRequest);
        
        // If we got a run response, poll for completion and get messages
        if (runResponse && runResponse.id && runResponse.thread_id) {
            return await this.pollForCompletion(runResponse.thread_id, runResponse.id, cortexRequest);
        }
        
        return runResponse;
    }

    // Poll for run completion and retrieve messages
    async pollForCompletion(threadId, runId, cortexRequest) {
        const maxPollingAttempts = 60; // 60 seconds max
        const pollingInterval = 1000; // 1 second
        let attempts = 0;
        
        while (attempts < maxPollingAttempts) {
            attempts++;
            
            // Wait before polling
            await new Promise(resolve => setTimeout(resolve, pollingInterval));
            
            try {
                // Add authentication token if available
                const azureAuthTokenHelper = this.config.get('azureAuthTokenHelper');
                let authToken = null;
                if (azureAuthTokenHelper) {
                    try {
                        authToken = await azureAuthTokenHelper.getAccessToken();
                    } catch (error) {
                        logger.warn(`[Azure Foundry Agent] Failed to get auth token for polling: ${error.message}`);
                        // Continue without auth token
                    }
                }
                
                const pollUrl = `${this.baseUrl}/threads/${threadId}/runs/${runId}`;
                const pollResponse = await axios.get(pollUrl, {
                    headers: {
                        'Content-Type': 'application/json',
                        ...cortexRequest.headers,
                        ...(authToken && { 'Authorization': `Bearer ${authToken}` })
                    },
                    params: cortexRequest.params
                });
                const runStatus = pollResponse?.data;
                
                if (!runStatus) {
                    logger.warn(`[Azure Foundry Agent] No run status received for run: ${runId}`);
                    continue;
                }
                
                // Check if run is completed
                if (runStatus.status === 'completed') {
                    logger.info(`[Azure Foundry Agent] Run completed successfully: ${runId}`);
                    return await this.retrieveMessages(threadId);
                }
                
                // Check if run failed
                if (runStatus.status === 'failed') {
                    logger.error(`[Azure Foundry Agent] Run failed: ${runId}`, runStatus.lastError);
                    return null;
                }
                
                // Check if run was cancelled
                if (runStatus.status === 'cancelled') {
                    logger.warn(`[Azure Foundry Agent] Run was cancelled: ${runId}`);
                    return null;
                }
                
                // Continue polling for queued or in_progress status
                if (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
                    continue;
                }
                
                // Unknown status
                logger.warn(`[Azure Foundry Agent] Unknown run status: ${runStatus.status}`);
                break;
                
            } catch (error) {
                logger.error(`[Azure Foundry Agent] Error polling run status: ${error.message}`);
                break;
            }
        }
        
        logger.error(`[Azure Foundry Agent] Polling timeout after ${maxPollingAttempts} attempts for run: ${runId}`);
        return null;
    }

    // Retrieve messages from the completed thread
    async retrieveMessages(threadId) {
        try { 
            // Add authentication token if available
            const azureAuthTokenHelper = this.config.get('azureAuthTokenHelper');
            let authToken = null;
            if (azureAuthTokenHelper) {
                try {
                    authToken = await azureAuthTokenHelper.getAccessToken();
                } catch (error) {
                    logger.warn(`[Azure Foundry Agent] Failed to get auth token for messages: ${error.message}`);
                    // Continue without auth token
                }
            }
            
            const messagesUrl = `${this.baseUrl}/threads/${threadId}/messages`;
            const axiosResponse = await axios.get(messagesUrl, {
                headers: {
                    'Content-Type': 'application/json',
                    ...this.model.headers,
                    ...(authToken && { 'Authorization': `Bearer ${authToken}` })
                },
                params: { 'api-version': '2025-05-01', order: 'asc' }
            });
            const messagesResponse = axiosResponse?.data;
            
            if (!messagesResponse || !messagesResponse.data) {
                logger.warn(`[Azure Foundry Agent] No messages received from thread: ${threadId}`);
                return null;
            }
            
            // Find the last assistant message
            const messages = messagesResponse.data;
            for (let i = messages.length - 1; i >= 0; i--) {
                const message = messages[i];
                if (message.role === 'assistant' && message.content && Array.isArray(message.content)) {
                    const textContent = message.content.find(c => c.type === 'text' && c.text && c.text.value);
                    if (textContent) {
                        return JSON.stringify(textContent.text);
                    }
                }
            }
            
            logger.warn(`[Azure Foundry Agent] No assistant messages found in thread: ${threadId}`);
            return null;
            
        } catch (error) {
            logger.error(`[Azure Foundry Agent] Error retrieving messages: ${error.message}`);
            return null;
        }
    }

    // Parse the response from the Azure Foundry Agents API
    parseResponse(data) {
        if (!data) return "";
        
        // If data is already a string (the final message content), return it
        if (typeof data === 'string') {
            return data;
        }
        
        // Handle the run response format (for backward compatibility)
        if (data.id && data.status) {
            // This is a run response, we need to handle the status
            if (data.status === 'completed') {
                // The run completed successfully, but we need to get the messages
                // This would typically be handled by polling for messages
                return data;
            } else if (data.status === 'failed') {
                logger.error(`Azure Foundry Agent run failed: ${data.lastError?.message || data.last_error?.message || 'Unknown error'}`);
                return null;
            } else {
                // Still in progress
                return data;
            }
        }

        // Handle direct message response
        if (data.messages && Array.isArray(data.messages)) {
            const lastMessage = data.messages[data.messages.length - 1];
            if (lastMessage && lastMessage.content && Array.isArray(lastMessage.content)) {
                const textContent = lastMessage.content.find(c => c.type === 'text');
                if (textContent && textContent.text) {
                    // Support both object { value: string } and string shapes
                    if (typeof textContent.text === 'string') {
                        return textContent.text;
                    }
                    if (typeof textContent.text.value === 'string') {
                        return textContent.text.value;
                    }
                }
            }
        }

        // Fallback to returning the entire response
        return data;
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        const { stream, thread } = data;
        
        if (thread && thread.messages && thread.messages.length > 1) {
            logger.info(`[Azure Foundry Agent request sent containing ${thread.messages.length} messages]`);
            let totalLength = 0;
            let totalUnits;
            
            thread.messages.forEach((message, index) => {
                const content = message.content === undefined ? JSON.stringify(message) : 
                    (Array.isArray(message.content) ? message.content.map(item => {
                        return JSON.stringify(item);
                    }).join(', ') : message.content);
                const { length, units } = this.getLength(content);
                const displayContent = this.shortenContent(content);

                logger.verbose(`message ${index + 1}: role: ${message.role}, ${units}: ${length}, content: "${displayContent}"`);
                totalLength += length;
                totalUnits = units;
            });
            logger.info(`[Azure Foundry Agent request contained ${totalLength} ${totalUnits}]`);
        } else if (thread && thread.messages && thread.messages.length === 1) {
            const message = thread.messages[0];
            const content = Array.isArray(message.content) ? message.content.map(item => {
                return JSON.stringify(item);
            }).join(', ') : message.content;
            const { length, units } = this.getLength(content);
            logger.info(`[Azure Foundry Agent request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }
    
        if (stream) {
            logger.info(`[Azure Foundry Agent response received as an SSE stream]`);
        } else {
            const responseText = this.parseResponse(responseData);
            if (responseText && typeof responseText === 'string') {
                const { length, units } = this.getLength(responseText);
                logger.info(`[Azure Foundry Agent response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(responseText)}`);
            } else {
                logger.info(`[Azure Foundry Agent response received: ${JSON.stringify(responseData)}]`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default AzureFoundryAgentsPlugin; 