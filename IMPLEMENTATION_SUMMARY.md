# Azure AI Foundry Agents Implementation Summary

## Overview

We have successfully implemented a new plugin and model type for Azure AI Foundry Agents in the Cortex project. This implementation allows the system to communicate with Azure AI Foundry Agents using REST API calls, similar to the OpenAI Assistants API.

## What Was Implemented

### 1. Azure Foundry Agents Plugin (`cortex/server/plugins/azureFoundryAgentsPlugin.js`)

**Key Features:**
- Extends the base `ModelPlugin` class
- Handles message conversion from Palm format to Azure format
- Supports all Azure Foundry Agents API parameters including:
  - `assistant_id` (agent ID)
  - `thread.messages` (conversation messages)
  - `tools` (available tools for the agent)
  - `tool_resources` (resources for tools like file IDs, vector stores)
  - `stream` (streaming responses)
  - `metadata`, `instructions`, `model`, `temperature`, etc.

**Key Methods:**
- `convertToAzureFoundryMessages()` - Converts Palm format messages to Azure format
- `getRequestParameters()` - Builds the request payload for Azure API
- `execute()` - Creates run, polls for completion, and retrieves messages
- `pollForCompletion()` - Polls run status until completion or timeout
- `retrieveMessages()` - Retrieves messages from completed thread
- `parseResponse()` - Handles different response types (run status, messages, errors)
- `requestUrl()` - Constructs the correct Azure Foundry Agents endpoint
- `logRequestData()` - Custom logging for Azure Foundry Agents requests

### 2. Model Configuration (`cortex/config/default.json`)

**Configuration Parameters:**
- `type`: "AZURE-FOUNDRY-AGENTS"
- `projectUrl`: Azure AI Foundry project URL
- `agentId`: Specific agent ID to use
- `headers`: HTTP headers (Content-Type required)
- `requestsPerSecond`: Rate limiting
- `maxTokenLength`: Input token limit
- `maxReturnTokens`: Response token limit
- `supportsStreaming`: Streaming capability flag

### 3. System Pathway (`cortex/pathways/system/rest_streaming/sys_azure_foundry_agents.js`)

**Purpose:**
- Provides a standard pathway for Azure Foundry Agents
- Handles message formatting
- Supports input parameters for messages

### 4. Model Executor Integration (`cortex/server/modelExecutor.js`)

**Changes Made:**
- Added import for `AzureFoundryAgentsPlugin`
- Added case for `'AZURE-FOUNDRY-AGENTS'` type
- Integrated the plugin into the model execution system

### 5. Test Pathway (`cortex/pathways/azure_foundry_test.js`)

**Purpose:**
- Demonstrates basic usage of the Azure Foundry Agents plugin
- Shows how to configure input parameters
- Provides a working example for testing

### 6. Comprehensive Tests (`cortex/tests/azureFoundryAgents.test.js`)

**Test Coverage:**
- Plugin initialization and configuration
- Message format conversion
- Request parameter building
- Response parsing for different scenarios
- Error handling
- URL construction

### 7. Example Usage (`cortex/examples/azure-foundry-example.js`)

**Examples Provided:**
- Basic usage without tools
- Advanced usage with tools and resources
- Streaming response handling
- Error handling patterns

### 8. Documentation (`cortex/docs/AZURE_FOUNDRY_AGENTS.md`)

**Documentation Includes:**
- Overview and features
- Configuration instructions
- Usage examples
- API request/response formats
- Authentication requirements
- Troubleshooting guide

## API Request Format

The plugin sends requests to Azure AI Foundry Agents in this format:

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

The plugin implements a complete workflow:

1. **Run Creation**: Creates a run with the specified agent and messages
2. **Polling**: Polls the run status every second until completion (max 60 seconds)
3. **Message Retrieval**: Once completed, retrieves all messages from the thread
4. **Content Extraction**: Extracts the text content from the assistant's response
5. **Error Handling**: Handles failed runs, timeouts, and other errors

The plugin automatically handles the polling and waiting process, returning the final assistant message content once the run is complete.

## Authentication

The implementation uses Azure's DefaultAzureCredential for authentication, supporting:
- Azure CLI authentication
- Environment variables
- Managed Identity (when running in Azure)

## Testing Results

All tests pass successfully:
- ✅ Plugin initialization
- ✅ Message conversion
- ✅ Request parameter building
- ✅ Response parsing
- ✅ Error handling
- ✅ URL construction

## Usage Example

```javascript
// Create a pathway
const pathway = {
    name: 'my-azure-agent',
    model: 'azure-foundry-agents',
    temperature: 0.7
};

// Execute with the agent
const executor = new ModelExecutor(pathway, model);
const result = await executor.execute('Hello, can you help me?', {}, null, null);
```

## Next Steps

1. **Authentication Setup**: Ensure Azure credentials are properly configured
2. **Agent Configuration**: Update the `agentId` in config to use your specific agent
3. **Testing**: Run the example to verify connectivity
4. **Customization**: Modify the plugin as needed for specific use cases

## Files Created/Modified

**New Files:**
- `cortex/server/plugins/azureFoundryAgentsPlugin.js`
- `cortex/pathways/system/rest_streaming/sys_azure_foundry_agents.js`
- `cortex/pathways/azure_foundry_test.js`
- `cortex/tests/azureFoundryAgents.test.js`
- `cortex/examples/azure-foundry-example.js`
- `cortex/docs/AZURE_FOUNDRY_AGENTS.md`
- `cortex/IMPLEMENTATION_SUMMARY.md`

**Modified Files:**
- `cortex/server/modelExecutor.js` (added import and case)
- `cortex/config/default.json` (added model configuration)

The implementation is complete and ready for use with Azure AI Foundry Agents! 