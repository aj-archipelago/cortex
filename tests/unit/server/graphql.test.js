import test from 'ava';
import sinon from 'sinon';
import { getResolvers } from '../../../server/graphql.js';

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
    sinon.restore();
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
    t.true(Array.isArray(result));

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
    t.true(Array.isArray(result));

    // Verify that isLegacyPromptFormat was NOT called since promptNames wasn't provided
    t.false(mockPathwayManager.isLegacyPromptFormat.called);
    t.true(mockPathwayManager.getPathway.calledOnce);
});
