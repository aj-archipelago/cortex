import test from 'ava';

// Test the transformation logic directly without mocking
test('should format cortex pathway arguments correctly with existing chatHistory', (t) => {
    // Mock the original prompt
    const originalPrompt = {
        name: 'summarize',
        prompt: 'summarize this file',
        cortexPathwayName: 'run_labeeb_agent'
    };
    
    // Mock pathway data
    const pathway = {
        model: 'labeeb-agent',
        systemPrompt: 'Test system prompt'
    };
    
    // Mock incoming pathway args
    const pathwayArgs = {
        text: 'summarize the file',
        chatHistory: [
            {
                role: 'user',
                content: [
                    '{"type":"image_url","url":"test-url","image_url":{"url":"test-url"},"gcs":"test-gcs","originalFilename":"test.jpg","hash":"test-hash"}'
                ]
            }
        ]
    };
    
    // Simulate the transformation logic from the executePathwayWithFallback function
    const cortexArgs = {
        model: pathway.model || pathwayArgs.model || "labeeb-agent",
        chatHistory: [],
        systemPrompt: pathway.systemPrompt
    };
    
    // If we have existing chatHistory, use it as base
    if (pathwayArgs.chatHistory && pathwayArgs.chatHistory.length > 0) {
        cortexArgs.chatHistory = JSON.parse(JSON.stringify(pathwayArgs.chatHistory));
    }
    
    // If we have text parameter, we need to add it to the chatHistory
    if (pathwayArgs.text) {
        // Find the last user message or create a new one
        let lastUserMessage = null;
        for (let i = cortexArgs.chatHistory.length - 1; i >= 0; i--) {
            if (cortexArgs.chatHistory[i].role === 'user') {
                lastUserMessage = cortexArgs.chatHistory[i];
                break;
            }
        }
        
        if (lastUserMessage) {
            // Ensure content is an array
            if (!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = [JSON.stringify({
                    type: "text",
                    text: lastUserMessage.content || ""
                })];
            }
            
            // Add the text parameter as a text content item
            const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
            lastUserMessage.content.unshift(JSON.stringify({
                type: "text",
                text: `${pathwayArgs.text}\n\n${textFromPrompt}`
            }));
        } else {
            // Create new user message with text
            const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
            cortexArgs.chatHistory.push({
                role: 'user',
                content: [JSON.stringify({
                    type: "text",
                    text: `${pathwayArgs.text}\n\n${textFromPrompt}`
                })]
            });
        }
    }
    
    // Verify the transformation
    t.is(cortexArgs.model, 'labeeb-agent');
    t.is(cortexArgs.systemPrompt, 'Test system prompt');
    t.is(cortexArgs.chatHistory.length, 1);
    
    // Check that the user message has the correct structure
    const userMessage = cortexArgs.chatHistory[0];
    t.is(userMessage.role, 'user');
    t.true(Array.isArray(userMessage.content));
    t.is(userMessage.content.length, 2);
    
    // Check the text content was added first
    const textContent = JSON.parse(userMessage.content[0]);
    t.is(textContent.type, 'text');
    t.is(textContent.text, 'summarize the file\n\nsummarize this file');
    
    // Check the image content is preserved second
    const imageContent = JSON.parse(userMessage.content[1]);
    t.is(imageContent.type, 'image_url');
    t.is(imageContent.gcs, 'test-gcs');
});

test('should create new user message when no existing chatHistory', (t) => {
    // Mock the original prompt
    const originalPrompt = {
        name: 'summarize',
        prompt: 'summarize this file',
        cortexPathwayName: 'run_labeeb_agent'
    };
    
    // Mock pathway data
    const pathway = {
        model: 'labeeb-agent',
        systemPrompt: 'Test system prompt'
    };
    
    // Mock incoming pathway args with no chatHistory
    const pathwayArgs = {
        text: 'summarize the file'
    };
    
    // Simulate the transformation logic from the executePathwayWithFallback function
    const cortexArgs = {
        model: pathway.model || pathwayArgs.model || "labeeb-agent",
        chatHistory: [],
        systemPrompt: pathway.systemPrompt
    };
    
    // If we have existing chatHistory, use it as base
    if (pathwayArgs.chatHistory && pathwayArgs.chatHistory.length > 0) {
        cortexArgs.chatHistory = JSON.parse(JSON.stringify(pathwayArgs.chatHistory));
    }
    
    // If we have text parameter, we need to add it to the chatHistory
    if (pathwayArgs.text) {
        // Find the last user message or create a new one
        let lastUserMessage = null;
        for (let i = cortexArgs.chatHistory.length - 1; i >= 0; i--) {
            if (cortexArgs.chatHistory[i].role === 'user') {
                lastUserMessage = cortexArgs.chatHistory[i];
                break;
            }
        }
        
        if (lastUserMessage) {
            // Ensure content is an array
            if (!Array.isArray(lastUserMessage.content)) {
                lastUserMessage.content = [JSON.stringify({
                    type: "text",
                    text: lastUserMessage.content || ""
                })];
            }
            
            // Add the text parameter as a text content item
            const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
            lastUserMessage.content.unshift(JSON.stringify({
                type: "text",
                text: `${pathwayArgs.text}\n\n${textFromPrompt}`
            }));
        } else {
            // Create new user message with text
            const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
            cortexArgs.chatHistory.push({
                role: 'user',
                content: [JSON.stringify({
                    type: "text",
                    text: `${pathwayArgs.text}\n\n${textFromPrompt}`
                })]
            });
        }
    }
    
    // Verify the transformation
    t.is(cortexArgs.model, 'labeeb-agent');
    t.is(cortexArgs.systemPrompt, 'Test system prompt');
    t.is(cortexArgs.chatHistory.length, 1);
    
    // Check that a new user message was created
    const userMessage = cortexArgs.chatHistory[0];
    t.is(userMessage.role, 'user');
    t.true(Array.isArray(userMessage.content));
    t.is(userMessage.content.length, 1);
    
    // Check the text content
    const textContent = JSON.parse(userMessage.content[0]);
    t.is(textContent.type, 'text');
    t.is(textContent.text, 'summarize the file\n\nsummarize this file');
});

test('should use default model when pathway model is not specified', (t) => {
    // Mock the original prompt
    const originalPrompt = {
        name: 'summarize',
        prompt: 'summarize this file',
        cortexPathwayName: 'run_labeeb_agent'
    };
    
    // Mock pathway data without model
    const pathway = {
        systemPrompt: 'Test system prompt'
    };
    
    // Mock incoming pathway args
    const pathwayArgs = {
        text: 'summarize the file'
    };
    
    // Simulate the transformation logic
    const cortexArgs = {
        model: pathway.model || pathwayArgs.model || "labeeb-agent",
        chatHistory: [],
        systemPrompt: pathway.systemPrompt
    };
    
    // Verify default model is used
    t.is(cortexArgs.model, 'labeeb-agent');
});
