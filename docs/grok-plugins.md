# Grok Plugin

This document describes the Grok plugin available in Cortex, which provides integration with xAI's Grok models through their OpenAI-compatible API.

## Overview

Grok is xAI's AI model that provides real-time access to information and web search capabilities. The Cortex Grok plugin supports multimodal interactions (text and images) with web search and real-time data access.

## Available Plugin

### GrokVisionPlugin (`GROK-VISION`)

The `GrokVisionPlugin` provides multimodal chat functionality with Grok models, including text, images, web search, and real-time data access.

**Features:**
- Text-based conversations
- Image processing and analysis
- Web search integration
- Real-time data access
- Citations and source attribution
- Tool calling support
- Streaming responses
- Multimodal conversations

## Configuration

### Model Configuration

Add the following to your `config/default.json`:

```json
{
  "models": {
            "xai-grok-3": {
            "type": "GROK-VISION",
            "url": "https://api.x.ai/v1/chat/completions",
            "headers": {
                "Authorization": "Bearer {{XAI_API_KEY}}",
                "Content-Type": "application/json"
            },
            "params": {
                "model": "grok-3-latest"
            },
      "requestsPerSecond": 10,
      "maxTokenLength": 131072,
      "maxReturnTokens": 4096,
      "supportsStreaming": true
    }
  }
}
```

### Environment Variables

Set the following environment variable:
- `XAI_API_KEY`: Your xAI API key

## Grok-Specific Parameters

### Web Search Parameters

- `web_search` (boolean): Enable web search for real-time information
- `search_queries_only` (boolean): Return only search queries without executing them
- `search_grounding` (boolean): Use search results to ground the response

### Real-time Data Parameters

- `real_time_data` (boolean): Enable access to real-time data sources

### Citation Parameters

- `citations` (boolean): Include citations and source attribution in responses

### Vision Parameters

- `vision` (boolean): Enable vision processing
- `vision_detail` (string): Set vision detail level ('low', 'high', 'auto')
- `vision_auto` (boolean): Automatically detect when vision processing is needed

## Usage Examples

### Basic Chat with Web Search

```javascript
const pathway = {
  name: 'grok-chat',
  model: 'xai-grok-3',
  parameters: {
    web_search: true,
    citations: true
  }
};
```

### Vision Analysis with Web Search

```javascript
const pathway = {
  name: 'grok-vision',
  model: 'xai-grok-3',
  parameters: {
    web_search: true,
    vision: true,
    vision_detail: 'high',
    citations: true
  }
};
```

### Real-time Data Access

```javascript
const pathway = {
  name: 'grok-realtime',
  model: 'xai-grok-3',
  parameters: {
    real_time_data: true,
    web_search: true
  }
};
```

### Multimodal Conversation

```javascript
const pathway = {
  name: 'grok-multimodal',
  model: 'xai-grok-3',
  parameters: {
    web_search: true,
    vision: true,
    vision_auto: true,
    citations: true
  }
};
```

## Response Format

Grok responses may include additional fields beyond standard OpenAI responses:

```json
{
  "content": "Response text",
  "role": "assistant",
  "citations": [
    {
      "title": "Source Title",
      "url": "https://example.com",
      "snippet": "Relevant excerpt"
    }
  ],
  "search_queries": [
    "search query 1",
    "search query 2"
  ],
  "web_search_results": [
    {
      "title": "Search Result",
      "snippet": "Result excerpt",
      "url": "https://example.com"
    }
  ],
  "real_time_data": {
    "timestamp": "2024-01-01T00:00:00Z",
    "data": "Real-time information"
  }
}
```

## Streaming Support

The plugin supports streaming responses. When streaming is enabled, Grok-specific fields (citations, search queries, etc.) are included in the stream deltas.

## Error Handling

The plugin handles various error conditions:
- API authentication errors
- Rate limiting
- Safety filter blocks
- Invalid image URLs
- Network timeouts

## Testing

Run the Grok plugin tests:

```bash
npm test -- grok.test.js
```

## Limitations

- Requires xAI API access
- Web search and real-time data features require appropriate permissions
- Vision processing may have additional rate limits
- Some features may be region-restricted

## Troubleshooting

### Common Issues

1. **Authentication Error**: Ensure `XAI_API_KEY` is set correctly
2. **Rate Limiting**: Check your xAI API quota and rate limits
3. **Vision Processing Fails**: Verify image URLs are accessible and in supported formats
4. **Web Search Not Working**: Ensure your API key has web search permissions

### Debug Logging

Enable verbose logging to see detailed request/response information:

```javascript
// The plugin includes "grok vision" in log messages for easy identification
logger.setLevel('verbose');
```

## API Compatibility

The Grok plugin is designed to be compatible with OpenAI's API format while adding Grok-specific features. This means:

- Standard OpenAI parameters work as expected
- Grok-specific parameters are added when provided
- Response format extends OpenAI's standard format
- Tool calling follows OpenAI's function calling format
- All Grok interactions are multimodal (supporting both text and images) 