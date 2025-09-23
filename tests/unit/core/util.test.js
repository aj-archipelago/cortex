// util.test.js
// Tests for utility functions in cortex/lib/util.js

import test from 'ava';
import { removeOldImageAndFileContent } from '../../../lib/util.js';

// Test removeOldImageAndFileContent function

test('removeOldImageAndFileContent should return original chat history if empty', t => {
    const chatHistory = [];
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, chatHistory);
});

test('removeOldImageAndFileContent should return original chat history if null or undefined', t => {
    t.deepEqual(removeOldImageAndFileContent(null), null);
    t.deepEqual(removeOldImageAndFileContent(undefined), undefined);
});

test('removeOldImageAndFileContent should not modify chat history without image or file content', t => {
    const chatHistory = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
    ];
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, chatHistory);
});

test('removeOldImageAndFileContent should keep only the last user message with image content', t => {
    const chatHistory = [
        { role: 'user', content: [{ type: 'image_url', url: 'image1.jpg' }, 'Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: [{ type: 'image_url', url: 'image2.jpg' }, 'Text 2'] },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const expected = [
        { role: 'user', content: ['Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: [{ type: 'image_url', url: 'image2.jpg' }, 'Text 2'] },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle string JSON content', t => {
    const chatHistory = [
        { role: 'user', content: JSON.stringify({ type: 'image_url', url: 'image1.jpg' }) },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: JSON.stringify({ type: 'image_url', url: 'image2.jpg' }) },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: JSON.stringify({ type: 'image_url', url: 'image2.jpg' }) },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle object content', t => {
    const chatHistory = [
        { role: 'user', content: { type: 'image_url', url: 'image1.jpg' } },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: 'I see image 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle file content', t => {
    const chatHistory = [
        { role: 'user', content: { type: 'file', url: 'document1.pdf' } },
        { role: 'assistant', content: 'I see document 1' },
        { role: 'user', content: { type: 'file', url: 'document2.pdf' } },
        { role: 'assistant', content: 'I see document 2' }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'I see document 1' },
        { role: 'user', content: { type: 'file', url: 'document2.pdf' } },
        { role: 'assistant', content: 'I see document 2' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should only process user messages', t => {
    const chatHistory = [
        { role: 'user', content: { type: 'image_url', url: 'image1.jpg' } },
        { role: 'assistant', content: { type: 'image_url', url: 'response1.jpg' } },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: { type: 'image_url', url: 'response2.jpg' } }
    ];
    
    const expected = [
        { role: 'user', content: '' },
        { role: 'assistant', content: { type: 'image_url', url: 'response1.jpg' } },
        { role: 'user', content: { type: 'image_url', url: 'image2.jpg' } },
        { role: 'assistant', content: { type: 'image_url', url: 'response2.jpg' } }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});

test('removeOldImageAndFileContent should handle mixed content types', t => {
    const chatHistory = [
        { role: 'user', content: [{ type: 'image_url', url: 'image1.jpg' }, 'Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: 'Just text' },
        { role: 'assistant', content: 'I see text' },
        { role: 'user', content: [{ type: 'file', url: 'document.pdf' }, 'Text 2'] },
        { role: 'assistant', content: 'I see document' }
    ];
    
    const expected = [
        { role: 'user', content: ['Text 1'] },
        { role: 'assistant', content: 'I see image 1' },
        { role: 'user', content: 'Just text' },
        { role: 'assistant', content: 'I see text' },
        { role: 'user', content: [{ type: 'file', url: 'document.pdf' }, 'Text 2'] },
        { role: 'assistant', content: 'I see document' }
    ];
    
    const result = removeOldImageAndFileContent(chatHistory);
    t.deepEqual(result, expected);
});