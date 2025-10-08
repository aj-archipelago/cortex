/**
 * PathwayManager File Handling Tests
 * 
 * This test suite validates the PathwayManager's file handling functionality, specifically
 * testing how the manager processes and transforms pathway prompts that include file attachments.
 * 
 * Key functionality tested:
 * - File hash transformation from 'files' to 'fileHashes' property
 * - Collection and deduplication of file hashes at the pathway level
 * - Backward compatibility with legacy string-based prompts without file attachments
 * - Handling of edge cases (null, undefined, empty file arrays)
 * - Prompt object creation with file metadata
 * 
 * The PathwayManager allows prompts to reference files by their hashes, which are then
 * processed and made available to the execution context. This test suite ensures that
 * file metadata is correctly preserved, transformed, and aggregated during pathway processing.
 * 
 * Test scenarios covered:
 * 1. Prompts with multiple file attachments
 * 2. Prompts with empty or missing file arrays
 * 3. Legacy string prompts (no file support)
 * 4. Duplicate file hash deduplication
 * 5. Null/undefined file handling
 * 6. Direct prompt object creation with files
 */

import test from 'ava';
import PathwayManager from '../../../lib/pathwayManager.js';

// Mock config for PathwayManager
const mockConfig = {
    storageType: 'local',
    filePath: './test-pathways.json',
    publishKey: 'test-key'
};

// Mock base pathway
const mockBasePathway = {
    name: 'base',
    prompt: '{{text}}',
    systemPrompt: '',
    inputParameters: {},
    typeDef: 'type Test { test: String }',
    rootResolver: () => {},
    resolver: () => {}
};

// Mock storage strategy
class MockStorageStrategy {
    async load() {
        return {};
    }
    
    async save(data) {
        // Do nothing
    }
    
    async getLastModified() {
        return Date.now();
    }
}

test('pathwayManager handles prompt format with files correctly', async t => {
    const pathwayManager = new PathwayManager(mockConfig, mockBasePathway);
    
    // Replace storage with mock
    pathwayManager.storage = new MockStorageStrategy();
    
    // Test prompts with files
    const pathwayWithFiles = {
        prompt: [
            {
                name: 'Analyze Document',
                prompt: 'Please analyze the provided document',
                files: ['abc123def456', 'def456ghi789']
            },
            {
                name: 'Summarize Text',
                prompt: 'Please summarize the text',
                files: []
            },
            {
                name: 'Simple Task',
                prompt: 'Perform a simple task'
                // No files property
            }
        ],
        systemPrompt: 'You are a helpful assistant'
    };
    
    // Test transformPrompts method
    const transformedPathway = await pathwayManager.transformPrompts(pathwayWithFiles);
    
    // Verify the transformed pathway structure
    t.truthy(transformedPathway);
    t.true(Array.isArray(transformedPathway.prompt));
    t.is(transformedPathway.prompt.length, 3);
    
    // Verify first prompt with files
    const firstPrompt = transformedPathway.prompt[0];
    t.is(firstPrompt.name, 'Analyze Document');
    t.truthy(firstPrompt.fileHashes);
    t.deepEqual(firstPrompt.fileHashes, ['abc123def456', 'def456ghi789']);
    
    // Verify second prompt with empty files
    const secondPrompt = transformedPathway.prompt[1];
    t.is(secondPrompt.name, 'Summarize Text');
    t.falsy(secondPrompt.fileHashes); // Empty array results in no fileHashes property
    
    // Verify third prompt without files property
    const thirdPrompt = transformedPathway.prompt[2];
    t.is(thirdPrompt.name, 'Simple Task');
    t.falsy(thirdPrompt.fileHashes);
    
    // Verify pathway-level file hashes collection
    t.truthy(transformedPathway.fileHashes);
    t.deepEqual(transformedPathway.fileHashes, ['abc123def456', 'def456ghi789']);
});

test('pathwayManager handles legacy string prompts correctly', async t => {
    const pathwayManager = new PathwayManager(mockConfig, mockBasePathway);
    
    // Replace storage with mock
    pathwayManager.storage = new MockStorageStrategy();
    
    // Test legacy string prompts
    const legacyPathway = {
        prompt: [
            'Please analyze the data',
            'Summarize the findings'
        ],
        systemPrompt: 'You are a helpful assistant'
    };
    
    // Test transformPrompts method
    const transformedPathway = await pathwayManager.transformPrompts(legacyPathway);
    
    // Verify the transformed pathway structure
    t.truthy(transformedPathway);
    t.true(Array.isArray(transformedPathway.prompt));
    t.is(transformedPathway.prompt.length, 2);
    
    // Verify prompts don't have file hashes
    transformedPathway.prompt.forEach(prompt => {
        t.falsy(prompt.fileHashes);
    });
    
    // Verify no pathway-level file hashes
    t.falsy(transformedPathway.fileHashes);
});

test('pathwayManager removes duplicate file hashes at pathway level', async t => {
    const pathwayManager = new PathwayManager(mockConfig, mockBasePathway);
    
    // Replace storage with mock
    pathwayManager.storage = new MockStorageStrategy();
    
    // Test prompts with duplicate file hashes
    const pathwayWithDuplicateFiles = {
        prompt: [
            {
                name: 'First Task',
                prompt: 'Analyze document 1',
                files: ['abc123def456', 'def456ghi789']
            },
            {
                name: 'Second Task', 
                prompt: 'Analyze document 2',
                files: ['abc123def456', 'ghi789jkl012'] // abc123def456 is duplicate
            }
        ],
        systemPrompt: 'You are a helpful assistant'
    };
    
    // Test transformPrompts method
    const transformedPathway = await pathwayManager.transformPrompts(pathwayWithDuplicateFiles);
    
    // Verify pathway-level file hashes are deduplicated
    t.truthy(transformedPathway.fileHashes);
    t.deepEqual(transformedPathway.fileHashes, ['abc123def456', 'def456ghi789', 'ghi789jkl012']);
    t.is(transformedPathway.fileHashes.length, 3); // Should not have duplicates
});

test('pathwayManager handles null and undefined files gracefully', async t => {
    const pathwayManager = new PathwayManager(mockConfig, mockBasePathway);
    
    // Replace storage with mock
    pathwayManager.storage = new MockStorageStrategy();
    
    // Test prompts with null/undefined files
    const pathwayWithNullFiles = {
        prompt: [
            {
                name: 'Task with null files',
                prompt: 'Do something', 
                files: null
            },
            {
                name: 'Task with undefined files',
                prompt: 'Do something else'
                // files property is undefined
            }
        ],
        systemPrompt: 'You are a helpful assistant'
    };
    
    // Test transformPrompts method
    const transformedPathway = await pathwayManager.transformPrompts(pathwayWithNullFiles);
    
    // Verify the transformation handles null/undefined gracefully
    t.truthy(transformedPathway);
    t.true(Array.isArray(transformedPathway.prompt));
    
    // Both prompts should have empty or undefined fileHashes
    transformedPathway.prompt.forEach(prompt => {
        t.true(!prompt.fileHashes || prompt.fileHashes.length === 0);
    });
    
    // No pathway-level file hashes should be set
    t.falsy(transformedPathway.fileHashes);
});

test('pathwayManager _createPromptObject handles files correctly', t => {
    const pathwayManager = new PathwayManager(mockConfig, mockBasePathway);
    
    // Test with object prompt containing files
    const promptWithFiles = {
        name: 'Test Prompt',
        prompt: 'Analyze this document',
        files: ['file1hash', 'file2hash']
    };
    
    const createdPrompt = pathwayManager._createPromptObject(promptWithFiles, 'System prompt');
    
    t.is(createdPrompt.name, 'Test Prompt');
    t.truthy(createdPrompt.fileHashes);
    t.deepEqual(createdPrompt.fileHashes, ['file1hash', 'file2hash']);
    
    // Test with string prompt (no files)
    const stringPrompt = 'Simple text prompt';
    const createdStringPrompt = pathwayManager._createPromptObject(stringPrompt, 'System prompt', 'Default Name');
    
    t.is(createdStringPrompt.name, 'Default Name');
    t.falsy(createdStringPrompt.fileHashes);
    
    // Test with object prompt without files
    const promptWithoutFiles = {
        name: 'No Files Prompt',
        prompt: 'Simple task'
    };
    
    const createdPromptNoFiles = pathwayManager._createPromptObject(promptWithoutFiles, 'System prompt');
    
    t.is(createdPromptNoFiles.name, 'No Files Prompt');
    t.falsy(createdPromptNoFiles.fileHashes);
});
