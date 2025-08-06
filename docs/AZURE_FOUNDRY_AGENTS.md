# Azure AI Foundry Agents Plugin

This plugin enables integration with Azure AI Foundry Agents, allowing you to interact with AI agents through the Azure AI Foundry platform.

## Overview

The Azure Foundry Agents plugin provides a REST-based interface to Azure AI Foundry Agents, similar to the OpenAI Assistants API. It supports:

- Sending messages to Azure AI Foundry Agents
- Handling agent responses
- Support for streaming responses
- Tool calls and function calling
- File attachments and data sources

## Configuration

### Model Configuration

Add the following model configuration to your `config/default.json`:

```json
{
    "models": {
        "azure-foundry-agents": {
            "type": "AZURE-FOUNDRY-AGENTS",
            "projectUrl": "https://your-foundry-resource.services.ai.azure.com/api/projects/your-project",
            "agentId": "asst_your_agent_id",
            "headers": {
                "Content-Type": "application/json"
            },
            "requestsPerSecond": 10,
            "maxTokenLength": 32768,
            "maxReturnTokens": 4096,
            "supportsStreaming": true
        }
    }
}
```

### Configuration Parameters

- `projectUrl`: The Azure AI Foundry project URL
- `agentId`: The ID of the specific agent to use
- `headers`: HTTP headers for the request (Content-Type is required)
- `requestsPerSecond`: Rate limiting for API calls
- `maxTokenLength`: Maximum number of tokens for input
- `maxReturnTokens`: Maximum number of tokens for response
- `supportsStreaming`: Whether the agent supports streaming responses

## Usage

### Basic Usage

Create a pathway that uses the Azure Foundry Agents model:

```javascript
// my_azure_agent_pathway.js
import { Prompt } from '../server/prompt.js';

export default {
    name: 'my-azure-agent',
    description: 'Pathway for Azure AI Foundry Agent',
    prompt: [
        new Prompt({
            messages: [
                {
                    role: 'user',
                    content: '{{text}}'
                }
            ]
        })
    ],
    inputParameters: {
        text: {
            type: 'string',
            description: 'The message to send to the agent',
            default: 'Hello, can you help me?'
        }
    },
    model: 'azure-foundry-agents',
    temperature: 0.7,
    useInputChunking: false
}
```

### Advanced Usage with Tools

You can also pass tools and tool resources to the agent:

```javascript
// advanced_azure_agent_pathway.js
import { Prompt } from '../server/prompt.js';

export default {
    name: 'advanced-azure-agent',
    description: 'Advanced pathway with tools',
    prompt: [
        new Prompt({
            messages: [
                {
                    role: 'user',
                    content: '{{text}}'
                }
            ]
        })
    ],
    inputParameters: {
        text: {
            type: 'string',
            description: 'The message to send to the agent',
            default: 'Analyze this data for me'
        },
        tools: {
            type: 'array',
            description: 'Tools to make available to the agent',
            default: [
                {
                    type: 'code_interpreter'
                },
                {
                    type: 'file_search'
                }
            ]
        },
        tool_resources: {
            type: 'object',
            description: 'Resources for tools',
            default: {
                code_interpreter: {
                    file_ids: ['file_123', 'file_456']
                }
            }
        }
    },
    model: 'azure-foundry-agents',
    temperature: 0.7,
    useInputChunking: false
}
```

## API Request Format

The plugin sends requests to Azure AI Foundry Agents in the following format:

```json
{
    "assistant_id": "asst_your_agent_id",
    "thread": {
        "messages": [
            {
                "role": "user",
                "content": "Your message here"
            }
        ]
    },
    "stream": false,
    "tools": [
        {
            "type": "code_interpreter"
        }
    ],
    "tool_resources": {
        "code_interpreter": {
            "file_ids": ["file_123"]
        }
    }
}
```

## Response Handling

The plugin implements a complete workflow for Azure AI Foundry Agents:

1. **Run Creation**: Creates a run with the specified agent and messages
2. **Polling**: Polls the run status every second until completion (max 60 seconds)
3. **Message Retrieval**: Once completed, retrieves all messages from the thread
4. **Content Extraction**: Extracts the text content from the assistant's response
5. **Error Handling**: Handles failed runs, timeouts, and other errors

The plugin automatically handles the polling and waiting process, so you don't need to implement it manually. It will return the final assistant message content once the run is complete.

## Authentication

The plugin uses Azure's DefaultAzureCredential for authentication. Make sure you have:

1. Azure CLI installed and logged in, or
2. Environment variables set for Azure authentication, or
3. Managed Identity configured (if running in Azure)

## Testing

Run the tests to verify the plugin works correctly:

```bash
npm test -- azureFoundryAgents.test.js
```

## Example Integration

Here's a complete example of how to use the Azure Foundry Agents plugin:

```javascript
// Example usage in your application
import { ModelExecutor } from '../server/modelExecutor.js';

const pathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: {
        messages: [
            {
                role: 'user',
                content: 'Hello, can you help me analyze some data?'
            }
        ]
    }
};

const model = {
    name: 'azure-foundry-agents',
    type: 'AZURE-FOUNDRY-AGENTS',
    projectUrl: 'https://your-foundry-resource.services.ai.azure.com/api/projects/your-project',
    agentId: 'asst_your_agent_id'
};

const executor = new ModelExecutor(pathway, model);
const result = await executor.execute('Hello, can you help me?', {}, null, null);
console.log(result);
```

## Troubleshooting

### Common Issues

1. **Authentication Errors**: Ensure you have proper Azure credentials configured
2. **Agent Not Found**: Verify the agent ID is correct and the agent exists in your project
3. **Rate Limiting**: Adjust the `requestsPerSecond` parameter if you encounter rate limiting
4. **Token Limits**: Check that your messages don't exceed the `maxTokenLength` limit

### Debugging

Enable verbose logging to see detailed request and response information:

```javascript
// Set log level to verbose
logger.setLevel('verbose');
```

## Support

For issues related to Azure AI Foundry Agents, refer to the [Azure AI Foundry documentation](https://docs.microsoft.com/en-us/azure/ai-services/ai-foundry/). 