import test from 'ava';
import OpenAIVisionPlugin from '../server/plugins/openAiVisionPlugin.js';
import Claude3VertexPlugin from '../server/plugins/claude3VertexPlugin.js';
import Gemini15VisionPlugin from '../server/plugins/gemini15VisionPlugin.js';
import GeminiVisionPlugin from '../server/plugins/geminiVisionPlugin.js';

// Mock pathway and model for plugin initialization
const mockPathway = { name: 'test', temperature: 0.7 };
const mockModel = { name: 'test-model' };

// Helper function to create plugin instances
const createPlugins = () => ({
    openai: new OpenAIVisionPlugin(mockPathway, mockModel),
    claude: new Claude3VertexPlugin(mockPathway, mockModel),
    gemini15: new Gemini15VisionPlugin(mockPathway, mockModel),
    gemini: new GeminiVisionPlugin(mockPathway, mockModel)
});

// Sample base64 image data
const sampleBase64Image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAA...';

// Test OpenAI to Claude conversion
test('OpenAI to Claude conversion data url', async (t) => {
    const { openai, claude } = createPlugins();
    
    const openaiMessages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: [
            { type: 'text', text: 'What\'s in this image?' },
            { type: 'image_url', image_url: { url: sampleBase64Image } }
        ]}
    ];

    const parsedOpenAI = openai.tryParseMessages(openaiMessages);
    const { system, modifiedMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    t.is(modifiedMessages.length, 1);
    t.is(system, 'You are a helpful assistant.');
    t.is(modifiedMessages[0].role, 'user');
    t.true(modifiedMessages[0].content[0].type === 'text');
    t.is(modifiedMessages[0].content[0].text, 'What\'s in this image?');
    t.true(modifiedMessages[0].content[1].type === 'image');
    t.true(modifiedMessages[0].content[1].source.data.startsWith('/9j/4AAQ'));
});

// Test OpenAI to Claude conversion with a regular image url
test('OpenAI to Claude conversion image url', async (t) => {
    const { openai, claude } = createPlugins();
    
    const openaiMessages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: [
            { type: 'text', text: 'What\'s in this image?' },
            { type: 'image_url', image_url: { url: "https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg" } }
        ]}
    ];

    const parsedOpenAI = openai.tryParseMessages(openaiMessages);
    const { system, modifiedMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    t.is(modifiedMessages.length, 1);
    t.is(system, 'You are a helpful assistant.');
    t.is(modifiedMessages[0].role, 'user');
    t.true(modifiedMessages[0].content[0].type === 'text');
    t.is(modifiedMessages[0].content[0].text, 'What\'s in this image?');
    t.true(modifiedMessages[0].content[1].type === 'image');
    t.true(modifiedMessages[0].content[1].source.data.startsWith('/9j/4AAQ'));
});

// Test OpenAI to Gemini conversion
test('OpenAI to Gemini conversion', t => {
    const { openai, gemini, gemini15 } = createPlugins();
    
    const openaiMessages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: [
            { type: 'text', text: 'Describe this image:' },
            { type: 'image_url', image_url: { url: 'gs://my-bucket/image.jpg' } }
        ]}
    ];

    const parsedOpenAI = openai.tryParseMessages(openaiMessages);
    const { modifiedMessages, system } = gemini.convertMessagesToGemini(parsedOpenAI);
    const { modifiedMessages: modifiedMessages15, system: system15 } = gemini15.convertMessagesToGemini(parsedOpenAI);

    // Gemini
    t.is(modifiedMessages.length, 1);
    t.is(modifiedMessages[0].role, 'user');
    t.is(modifiedMessages[0].parts.length, 3);
    t.is(modifiedMessages[0].parts[0].text, 'You are a helpful assistant.');
    t.is(modifiedMessages[0].parts[1].text, 'Describe this image:');
    t.is(modifiedMessages[0].parts[2].fileData.fileUri, 'gs://my-bucket/image.jpg');

    // Gemini 1.5
    t.is(system15.parts.length, 1);
    t.is(modifiedMessages15.length, 1);
    t.is(modifiedMessages15[0].role, 'user');
    t.is(modifiedMessages15[0].parts.length, 2);
    t.is(modifiedMessages15[0].parts[0].text, 'Describe this image:');
    t.is(modifiedMessages15[0].parts[1].fileData.fileUri, 'gs://my-bucket/image.jpg');
    t.is(system15.parts[0].text, 'You are a helpful assistant.');
});

// Test special Cortex properties (gcs and url)
test('Cortex special properties conversion', async (t) => {
    const { openai, claude, gemini, gemini15 } = createPlugins();
    
    const cortexMessages = [
        { role: 'user', content: [
            { type: 'text', text: 'Analyze this image:' },
            { type: 'image_url', gcs: 'gs://cortex-bucket/special-image.png', url: 'https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg' }
        ]}
    ];

    const parsedOpenAI = openai.tryParseMessages(cortexMessages);
    const { system: claudeSystem, modifiedMessages: claudeMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    const { modifiedMessages: geminiMessages } = gemini.convertMessagesToGemini(parsedOpenAI);
    const { modifiedMessages: geminiMessages15, system: geminiSystem15 } = gemini15.convertMessagesToGemini(parsedOpenAI);

    // Check Claude conversion
    t.true(claudeMessages[0].content[1].source.data.startsWith('/9j/4AAQ'));

    // Check Gemini conversion
    t.is(geminiMessages[0].parts[1].fileData.fileUri, 'gs://cortex-bucket/special-image.png');
    t.is(geminiMessages15[0].parts[1].fileData.fileUri, 'gs://cortex-bucket/special-image.png');
});

// Test mixed content types
test('Mixed content types conversion', async (t) => {
    const { openai, claude, gemini, gemini15 } = createPlugins();
    
    const mixedMessages = [
        { role: 'system', content: 'You are a vision analysis AI.' },
        { role: 'user', content: 'What do you see?' },
        { role: 'assistant', content: 'I need an image to analyze.' },
        { role: 'user', content: [
            { type: 'text', text: 'Here\'s an image:' },
            { type: 'image_url', image_url: { url: sampleBase64Image } },
            { type: 'text', text: 'And another one:' },
            { type: 'image_url', gcs: 'gs://cortex-bucket/another-image.jpg', url: 'https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg' }
        ]}
    ];

    const parsedOpenAI = openai.tryParseMessages(mixedMessages);
    const { system: claudeSystem, modifiedMessages: claudeMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);
    const { modifiedMessages } = gemini.convertMessagesToGemini(parsedOpenAI);
    const { modifiedMessages: modifiedMessages15, system: system15 } = gemini15.convertMessagesToGemini(parsedOpenAI);

    // Check Claude conversion
    t.is(claudeMessages.length, 3);
    t.true(claudeMessages[2].content[0].text.includes('Here\'s an image:'));
    t.true(claudeMessages[2].content[1].source.type === 'base64');
    t.true(claudeMessages[2].content[1].source.data.startsWith('/9j/4AAQ'));
    t.true(claudeMessages[2].content[2].text.includes('And another one:'));
    t.true(claudeMessages[2].content[3].source.type === 'base64');
    t.true(claudeMessages[2].content[3].source.data.startsWith('/9j/4AAQ'));
    t.is(claudeSystem, 'You are a vision analysis AI.');

    // Check Gemini conversion
    t.is(modifiedMessages.length, 3);
    t.is(modifiedMessages[0].parts.length, 2);
    t.is(modifiedMessages[0].parts[0].text, 'You are a vision analysis AI.');
    t.is(modifiedMessages[0].parts[1].text, 'What do you see?');
    t.is(modifiedMessages[1].parts[0].text, 'I need an image to analyze.');
    t.is(modifiedMessages[2].parts.length, 4);
    t.is(modifiedMessages[2].parts[0].text, 'Here\'s an image:');
    t.true('inlineData' in modifiedMessages[2].parts[1]);
    t.is(modifiedMessages[2].parts[2].text, 'And another one:');
    t.is(modifiedMessages[2].parts[3].fileData.fileUri, 'gs://cortex-bucket/another-image.jpg');

    // Check Gemini 1.5 conversion
    t.is(modifiedMessages15.length, 3);
    t.is(modifiedMessages15[2].parts.length, 4);
    t.is(modifiedMessages15[2].parts[0].text, 'Here\'s an image:');
    t.true('inlineData' in modifiedMessages15[2].parts[1]);
    t.is(modifiedMessages15[2].parts[2].text, 'And another one:');
    t.is(modifiedMessages15[2].parts[3].fileData.fileUri, 'gs://cortex-bucket/another-image.jpg');
    t.is(system15.parts[0].text, 'You are a vision analysis AI.');
});

// Test unsupported mime types (e.g., PDF for Claude)
test('Unsupported mime type conversion', async (t) => {
    const { openai, claude } = createPlugins();
    
    const pdfMessage = [
        { role: 'user', content: [
            { type: 'text', text: 'Can you analyze this PDF?' },
            { type: 'image_url', image_url: { url: 'https://unec.edu.az/application/uploads/2014/12/pdf-sample.pdf' } }
        ]}
    ];

    const parsedOpenAI = openai.tryParseMessages(pdfMessage);
    const { system, modifiedMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    t.is(modifiedMessages[0].content.length, 1);
    t.is(modifiedMessages[0].content[0].text, 'Can you analyze this PDF?');
});

// Test pathological cases
test('Pathological cases', async (t) => {
    const { openai, claude, gemini, gemini15 } = createPlugins();
    
    const pathologicalMessages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'Another greeting' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'system', content: 'You are also very knowledgeable.' },
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'How are you?' },
        { role: 'user', content: [
            { type: 'text', text: 'What\'s this?' },
            { type: 'image_url', image_url: { url: sampleBase64Image } }
        ]},
        { role: 'user', content: 'Another question' },
    ];

    const parsedOpenAI = openai.tryParseMessages(pathologicalMessages);
    
    // Test Claude conversion
    const { system: claudeSystem, modifiedMessages: claudeMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    t.is(claudeSystem, 'You are a helpful assistant.\nYou are also very knowledgeable.');
    t.is(claudeMessages.length, 3);
    t.is(claudeMessages[0].role, 'user');
    t.is(claudeMessages[0].content[0].text, 'Hello\nAnother greeting');
    t.is(claudeMessages[1].role, 'assistant');
    t.is(claudeMessages[1].content[0].text, 'Hi there!');
    t.is(claudeMessages[2].role, 'user');
    t.true(Array.isArray(claudeMessages[2].content));
    t.is(claudeMessages[2].content[0].text, 'How are you?');
    t.is(claudeMessages[2].content[1].text, 'What\'s this?');
    t.is(claudeMessages[2].content[2].type, 'image');
    t.true(claudeMessages[2].content[2].source.data.startsWith('/9j/4AAQ'));  
    t.is(claudeMessages[2].content[3].text, 'Another question');

    // Test Gemini conversion
    const { modifiedMessages: geminiMessages } = gemini.convertMessagesToGemini(parsedOpenAI);

    t.is(geminiMessages.length, 3);
    t.is(geminiMessages[0].role, 'user');
    t.is(geminiMessages[0].parts[0].text, 'You are a helpful assistant.');
    t.is(geminiMessages[0].parts[1].text, 'Hello');
    t.is(geminiMessages[0].parts[2].text, 'Another greeting');
    t.is(geminiMessages[1].parts[0].text, 'Hi there!');
    t.is(geminiMessages[2].parts[0].text, 'You are also very knowledgeable.');
    t.is(geminiMessages[2].parts[1].text, 'How are you?');
    t.is(geminiMessages[2].parts[2].text, 'What\'s this?');
    t.true('inlineData' in geminiMessages[2].parts[3]);
    t.is(geminiMessages[2].parts[4].text, 'Another question');

    // Test Gemini 1.5 conversion
    const { modifiedMessages: geminiMessages15, system: geminiSystem15 } = gemini15.convertMessagesToGemini(parsedOpenAI);

    t.is(geminiSystem15.parts[0].text, 'You are a helpful assistant.');
    t.is(geminiSystem15.parts[1].text, 'You are also very knowledgeable.');
    t.is(geminiMessages15.length, 3);
    t.is(geminiMessages15[0].role, 'user');
    t.is(geminiMessages15[0].parts[0].text, 'Hello');
    t.is(geminiMessages15[0].parts[1].text, 'Another greeting');
    t.is(geminiMessages15[1].role, 'assistant');
    t.is(geminiMessages15[1].parts[0].text, 'Hi there!');
    t.is(geminiMessages15[2].role, 'user');
    t.is(geminiMessages15[2].parts[0].text, 'How are you?');
    t.is(geminiMessages15[2].parts[1].text, 'What\'s this?');
    t.true('inlineData' in geminiMessages15[2].parts[2]);
    t.is(geminiMessages15[2].parts[3].text, 'Another question');
});

// Test empty message array
test('Empty message array', async (t) => {
    const { openai, claude, gemini, gemini15 } = createPlugins();
    
    const emptyMessages = [];

    const parsedOpenAI = openai.tryParseMessages(emptyMessages);
    
    // Test Claude conversion
    const { system: claudeSystem, modifiedMessages: claudeMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    t.is(claudeSystem, '');
    t.is(claudeMessages.length, 0);

    // Test Gemini conversion
    const { modifiedMessages: geminiMessages } = gemini.convertMessagesToGemini(parsedOpenAI);

    t.is(geminiMessages.length, 0);

    // Test Gemini 1.5 conversion   
    const { modifiedMessages: geminiMessages15, system: geminiSystem15 } = gemini15.convertMessagesToGemini(parsedOpenAI);

    t.is(geminiSystem15, null);
    t.is(geminiMessages15.length, 0);
});

// Test messages with only system messages
test('Only system messages', async (t) => {
    const { openai, claude, gemini, gemini15 } = createPlugins();
    
    const onlySystemMessages = [
        { role: 'system', content: 'You are an AI assistant.' },
        { role: 'system', content: 'You are helpful and friendly.' },
    ];

    const parsedOpenAI = openai.tryParseMessages(onlySystemMessages);
    
    // Test Claude conversion
    const { system: claudeSystem, modifiedMessages: claudeMessages } = await claude.convertMessagesToClaudeVertex(parsedOpenAI);

    t.is(claudeSystem, 'You are an AI assistant.\nYou are helpful and friendly.');
    t.is(claudeMessages.length, 0);

    // Test Gemini conversion
    const { modifiedMessages: geminiMessages } = gemini.convertMessagesToGemini(parsedOpenAI);

    t.is(geminiMessages.length, 1);
    t.is(geminiMessages[0].parts[0].text, 'You are an AI assistant.');
    t.is(geminiMessages[0].parts[1].text, 'You are helpful and friendly.');

    // Test Gemini 1.5 conversion
    const { modifiedMessages: geminiMessages15, system: geminiSystem15 } = gemini15.convertMessagesToGemini(parsedOpenAI);

    t.is(geminiSystem15.parts[0].text, 'You are an AI assistant.');
    t.is(geminiSystem15.parts[1].text, 'You are helpful and friendly.');
    t.is(geminiMessages15.length, 0);
});
