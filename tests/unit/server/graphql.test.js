import test from 'ava';
import sinon from 'sinon';
import { getResolvers } from '../../../server/graphql.js';

// Mock callPathway to avoid actual external calls
const mockCallPathway = sinon.stub();

// Mock logger to avoid actual logging during tests
const mockLogger = {
    info: sinon.stub(),
    debug: sinon.stub(),
    error: sinon.stub(),
    warn: sinon.stub()
};

// Mock config
const mockConfig = {
    get: sinon.stub().returns('test-value')
};

test.beforeEach(t => {
    // Reset stubs before each test
    mockCallPathway.resetHistory();
    mockLogger.info.resetHistory();
    mockLogger.debug.resetHistory();
    mockLogger.error.resetHistory();
    mockLogger.warn.resetHistory();
});

test('executeWorkspace throws error for legacy format with promptNames', async t => {
    // Mock pathwayManager
    const mockPathwayManager = {
        getLatestPathways: sinon.stub().resolves({
            'test-user': {
                'test-pathway': {
                    prompt: ['legacy string prompt 1', 'legacy string prompt 2'], // Legacy format
                    systemPrompt: 'Test system prompt'
                }
            }
        }),
        isLegacyPromptFormat: sinon.stub().returns(true), // Mock returns true for legacy format
        getResolvers: sinon.stub().returns({ Mutation: {} }) // Mock getResolvers method
    };

    // Get the resolvers function (need to mock the import first)
    const resolvers = getResolvers(mockConfig, {}, mockPathwayManager);
    const executeWorkspaceResolver = resolvers.Query.executeWorkspace;

    // Mock GraphQL context and info
    const mockContextValue = { config: mockConfig };
    const mockInfo = {};

    // Test arguments - userId, pathwayName, promptNames are the key ones
    const args = {
        userId: 'test-user',
        pathwayName: 'test-pathway',
        promptNames: ['specific-prompt'], // This triggers the check
        text: 'test input'
    };

    // Execute the resolver and expect it to throw
    const error = await t.throwsAsync(async () => {
        await executeWorkspaceResolver(null, args, mockContextValue, mockInfo);
    });

    // Verify the error message
    t.truthy(error);
    t.true(error.message.includes('legacy prompt format'));
    t.true(error.message.includes('unpublish and republish'));
    t.true(error.message.includes('promptNames parameter'));
    t.true(error.message.includes('test-pathway')); // Should include the pathway name

    // Verify that the pathwayManager methods were called correctly
    t.true(mockPathwayManager.getLatestPathways.calledOnce);
    t.true(mockPathwayManager.isLegacyPromptFormat.calledOnce);
    t.true(mockPathwayManager.isLegacyPromptFormat.calledWith('test-user', 'test-pathway'));
});

test('executeWorkspace does not throw for new format with promptNames', async t => {
    // Mock pathwayManager with new format
    const mockPathwayManager = {
        getLatestPathways: sinon.stub().resolves({
            'test-user': {
                'test-pathway': {
                    prompt: [
                        { name: 'Prompt 1', prompt: 'New format prompt 1' },
                        { name: 'Prompt 2', prompt: 'New format prompt 2' }
                    ], // New format
                    systemPrompt: 'Test system prompt'
                }
            }
        }),
        isLegacyPromptFormat: sinon.stub().returns(false), // Mock returns false for new format
        getPathways: sinon.stub().resolves([
            {
                name: 'specific-prompt',
                prompt: [/* mock prompt object */],
                rootResolver: sinon.stub().resolves({ result: 'test result' })
            }
        ]),
        getResolvers: sinon.stub().returns({ Mutation: {} }) // Mock getResolvers method
    };

    const resolvers = getResolvers(mockConfig, {}, mockPathwayManager);
    const executeWorkspaceResolver = resolvers.Query.executeWorkspace;

    const mockContextValue = { config: mockConfig };
    const mockInfo = {};

    const args = {
        userId: 'test-user',
        pathwayName: 'test-pathway',
        promptNames: ['specific-prompt'],
        text: 'test input'
    };

    // This should not throw an error for new format
    const result = await executeWorkspaceResolver(null, args, mockContextValue, mockInfo);

    // Should return results without error
    t.truthy(result);
    t.is(typeof result, 'object');
    t.false(Array.isArray(result));

    // Verify that the pathwayManager methods were called correctly
    t.true(mockPathwayManager.getLatestPathways.calledOnce);
    t.true(mockPathwayManager.isLegacyPromptFormat.calledOnce);
    t.true(mockPathwayManager.getPathways.calledOnce);
});

test('executeWorkspace does not check format when promptNames not provided', async t => {
    // Mock pathwayManager with legacy format
    const mockPathwayManager = {
        getLatestPathways: sinon.stub().resolves({
            'test-user': {
                'test-pathway': {
                    prompt: ['legacy string prompt 1', 'legacy string prompt 2'], // Legacy format
                    systemPrompt: 'Test system prompt'
                }
            }
        }),
        isLegacyPromptFormat: sinon.stub(), // Should not be called
        getPathway: sinon.stub().resolves({
            rootResolver: sinon.stub().resolves({ result: 'test result' })
        }),
        getResolvers: sinon.stub().returns({ Mutation: {} }) // Mock getResolvers method
    };

    const resolvers = getResolvers(mockConfig, {}, mockPathwayManager);
    const executeWorkspaceResolver = resolvers.Query.executeWorkspace;

    const mockContextValue = { config: mockConfig };
    const mockInfo = {};

    const args = {
        userId: 'test-user',
        pathwayName: 'test-pathway',
        // No promptNames provided - should use default behavior
        text: 'test input'
    };

    // This should not throw an error even with legacy format when promptNames not provided
    const result = await executeWorkspaceResolver(null, args, mockContextValue, mockInfo);

    // Should return results without error
    t.truthy(result);
    t.is(typeof result, 'object');
    t.false(Array.isArray(result));

    // Verify that isLegacyPromptFormat was NOT called since promptNames wasn't provided
    t.false(mockPathwayManager.isLegacyPromptFormat.called);
    t.true(mockPathwayManager.getPathway.calledOnce);
});

test('executeWorkspace helper function DRY refactoring - structure verification', async t => {
    // This test verifies that the DRY refactoring doesn't break existing functionality
    // by testing that all three code paths (wildcard, specific prompts, default) 
    // still work with fallback to legacy execution
    
    const mockRootResolver = sinon.stub().resolves({ result: 'legacy-result' });

    // Test wildcard case with legacy fallback
    const mockPathwayManager = {
        getLatestPathways: sinon.stub().resolves({
            'test-user': {
                'test-pathway': {
                    prompt: [
                        { name: 'prompt1' }, // No cortexPathwayName - will fallback
                        { name: 'prompt2' }  // No cortexPathwayName - will fallback
                    ],
                    systemPrompt: 'Test system prompt'
                }
            }
        }),
        isLegacyPromptFormat: sinon.stub().returns(false),
        getPathways: sinon.stub().resolves([
            {
                name: 'prompt1',
                systemPrompt: 'System prompt 1',
                prompt: [{ messages: ['message1'] }],
                fileHashes: [],
                rootResolver: mockRootResolver
            },
            {
                name: 'prompt2',
                systemPrompt: 'System prompt 2', 
                prompt: [{ messages: ['message2'] }],
                fileHashes: [],
                rootResolver: mockRootResolver
            }
        ]),
        getResolvers: sinon.stub().returns({ Mutation: {} })
    };

    const resolvers = getResolvers(mockConfig, {}, mockPathwayManager);
    const executeWorkspaceResolver = resolvers.Query.executeWorkspace;

    const mockContextValue = { config: mockConfig };
    const mockInfo = {};

    const args = {
        userId: 'test-user',
        pathwayName: 'test-pathway',
        promptNames: ['*'], // Wildcard to execute all
        text: 'test input'
    };

    const result = await executeWorkspaceResolver(null, args, mockContextValue, mockInfo);

    // Verify that legacy resolvers were called (indicating the DRY helper function worked)
    t.is(mockRootResolver.callCount, 2); // Called twice for both prompts
    
    // Verify result structure matches expected format
    t.truthy(result);
    t.truthy(result.result);
    t.true(result.debug.includes('Executed 2 prompts in parallel'));
    
    // Parse the result to verify both prompts were executed
    const parsedResult = JSON.parse(result.result);
    t.is(parsedResult.length, 2);
    t.is(parsedResult[0].promptName, 'prompt1');
    t.is(parsedResult[1].promptName, 'prompt2');
});

test('executeWorkspace helper function DRY refactoring - default case structure', async t => {
    // Test that the default case still works with the DRY helper function
    
    const mockRootResolver = sinon.stub().resolves({ result: 'default-legacy-result' });

    const mockPathwayManager = {
        getLatestPathways: sinon.stub().resolves({
            'test-user': {
                'test-pathway': {
                    prompt: [
                        { name: 'default-prompt' } // No cortexPathwayName
                    ],
                    systemPrompt: 'Test system prompt'
                }
            }
        }),
        getPathway: sinon.stub().resolves({
            prompt: [{ name: 'default-prompt' }], // No cortexPathwayName
            systemPrompt: 'Test system prompt',
            fileHashes: [],
            rootResolver: mockRootResolver
        }),
        getResolvers: sinon.stub().returns({ Mutation: {} })
    };

    const resolvers = getResolvers(mockConfig, {}, mockPathwayManager);
    const executeWorkspaceResolver = resolvers.Query.executeWorkspace;

    const mockContextValue = { config: mockConfig };
    const mockInfo = {};

    const args = {
        userId: 'test-user',
        pathwayName: 'test-pathway',
        text: 'test input'
        // No promptNames provided - uses default case
    };

    const result = await executeWorkspaceResolver(null, args, mockContextValue, mockInfo);

    // Verify that legacy resolver was called (indicating DRY helper function worked for default case)
    t.is(mockRootResolver.callCount, 1);
    
    // Verify result structure
    t.truthy(result);
    t.is(result.result, 'default-legacy-result');
});
