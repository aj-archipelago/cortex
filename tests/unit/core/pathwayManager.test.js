import test from 'ava';
import sinon from 'sinon';
import PathwayManager from '../../../lib/pathwayManager.js';
import { Prompt } from '../../../server/prompt.js';

// Mock config
const mockConfig = {
    storageType: 'local',
    filePath: '/tmp/test-pathways.json',
    publishKey: 'test-key'
};

test.beforeEach(t => {
    t.context.pathwayManager = new PathwayManager(mockConfig);
});

test('transformPrompts handles array of strings (legacy format)', async t => {
    const pathway = {
        prompt: [
            'First prompt text',
            'Second prompt text'
        ],
        systemPrompt: 'You are a helpful assistant'
    };

    const result = await t.context.pathwayManager.transformPrompts(pathway);

    t.is(result.prompt.length, 2);
    t.true(result.prompt[0] instanceof Prompt);
    t.true(result.prompt[1] instanceof Prompt);
    
    // Check that the prompt text is correctly embedded
    t.is(result.prompt[0].messages[1].content, '{{text}}\n\nFirst prompt text');
    t.is(result.prompt[1].messages[1].content, '{{text}}\n\nSecond prompt text');
    
    // Check system prompt is included
    t.is(result.prompt[0].messages[0].content, 'You are a helpful assistant');
    t.is(result.prompt[1].messages[0].content, 'You are a helpful assistant');
    
    // Names should be null for legacy format
    t.is(result.prompt[0].name, null);
    t.is(result.prompt[1].name, null);
});

test('transformPrompts handles array of objects (new format)', async t => {
    const pathway = {
        prompt: [
            { name: 'First Prompt', prompt: 'First prompt text' },
            { name: 'Second Prompt', prompt: 'Second prompt text' }
        ],
        systemPrompt: 'You are a helpful assistant'
    };

    const result = await t.context.pathwayManager.transformPrompts(pathway);

    t.is(result.prompt.length, 2);
    t.true(result.prompt[0] instanceof Prompt);
    t.true(result.prompt[1] instanceof Prompt);
    
    // Check that the prompt text is correctly embedded
    t.is(result.prompt[0].messages[1].content, '{{text}}\n\nFirst prompt text');
    t.is(result.prompt[1].messages[1].content, '{{text}}\n\nSecond prompt text');
    
    // Check system prompt is included
    t.is(result.prompt[0].messages[0].content, 'You are a helpful assistant');
    t.is(result.prompt[1].messages[0].content, 'You are a helpful assistant');
    
    // Names should be preserved for new format
    t.is(result.prompt[0].name, 'First Prompt');
    t.is(result.prompt[1].name, 'Second Prompt');
});

test('transformPrompts handles mixed format arrays', async t => {
    const pathway = {
        prompt: [
            'Legacy prompt text',
            { name: 'Named Prompt', prompt: 'Named prompt text' }
        ],
        systemPrompt: 'You are a helpful assistant'
    };

    const result = await t.context.pathwayManager.transformPrompts(pathway);

    t.is(result.prompt.length, 2);
    
    // First prompt (legacy format)
    t.is(result.prompt[0].messages[1].content, '{{text}}\n\nLegacy prompt text');
    t.is(result.prompt[0].name, null);
    
    // Second prompt (new format)
    t.is(result.prompt[1].messages[1].content, '{{text}}\n\nNamed prompt text');
    t.is(result.prompt[1].name, 'Named Prompt');
});

test('transformPrompts preserves other pathway properties', async t => {
    const pathway = {
        prompt: [{ name: 'Test', prompt: 'Test prompt' }],
        systemPrompt: 'System prompt',
        name: 'Test Pathway',
        model: 'gpt-4',
        otherProperty: 'value'
    };

    const result = await t.context.pathwayManager.transformPrompts(pathway);

    t.is(result.name, 'Test Pathway');
    t.is(result.model, 'gpt-4');
    t.is(result.otherProperty, 'value');
    t.is(result.systemPrompt, 'System prompt');
});

test('transformPrompts handles empty prompt array', async t => {
    const pathway = {
        prompt: [],
        systemPrompt: 'You are a helpful assistant'
    };

    const result = await t.context.pathwayManager.transformPrompts(pathway);

    t.is(result.prompt.length, 0);
    t.true(Array.isArray(result.prompt));
});

test('_createPromptObject handles string prompt with default name', t => {
    const promptItem = 'Test prompt text';
    const systemPrompt = 'You are a helpful assistant';
    const defaultName = 'test_prompt';

    const result = t.context.pathwayManager._createPromptObject(promptItem, systemPrompt, defaultName);

    t.true(result instanceof Prompt);
    t.is(result.name, 'test_prompt');
    t.is(result.messages.length, 2);
    t.is(result.messages[0].role, 'system');
    t.is(result.messages[0].content, 'You are a helpful assistant');
    t.is(result.messages[1].role, 'user');
    t.is(result.messages[1].content, '{{text}}\n\nTest prompt text');
});

test('_createPromptObject handles string prompt without default name', t => {
    const promptItem = 'Test prompt text';
    const systemPrompt = 'You are a helpful assistant';

    const result = t.context.pathwayManager._createPromptObject(promptItem, systemPrompt);

    t.true(result instanceof Prompt);
    t.is(result.name, null);
    t.is(result.messages.length, 2);
    t.is(result.messages[0].role, 'system');
    t.is(result.messages[0].content, 'You are a helpful assistant');
    t.is(result.messages[1].role, 'user');
    t.is(result.messages[1].content, '{{text}}\n\nTest prompt text');
});

test('_createPromptObject handles object prompt with name', t => {
    const promptItem = { name: 'Custom Prompt', prompt: 'Test prompt text' };
    const systemPrompt = 'You are a helpful assistant';
    const defaultName = 'fallback_name';

    const result = t.context.pathwayManager._createPromptObject(promptItem, systemPrompt, defaultName);

    t.true(result instanceof Prompt);
    t.is(result.name, 'Custom Prompt');
    t.is(result.messages.length, 2);
    t.is(result.messages[0].role, 'system');
    t.is(result.messages[0].content, 'You are a helpful assistant');
    t.is(result.messages[1].role, 'user');
    t.is(result.messages[1].content, '{{text}}\n\nTest prompt text');
});

test('_createPromptObject handles object prompt without name', t => {
    const promptItem = { prompt: 'Test prompt text' };
    const systemPrompt = 'You are a helpful assistant';
    const defaultName = 'fallback_name';

    const result = t.context.pathwayManager._createPromptObject(promptItem, systemPrompt, defaultName);

    t.true(result instanceof Prompt);
    t.is(result.name, 'fallback_name'); // Uses defaultName when promptItem.name is undefined
    t.is(result.messages.length, 2);
    t.is(result.messages[0].role, 'system');
    t.is(result.messages[0].content, 'You are a helpful assistant');
    t.is(result.messages[1].role, 'user');
    t.is(result.messages[1].content, '{{text}}\n\nTest prompt text');
});

test('_createPromptObject handles empty system prompt', t => {
    const promptItem = 'Test prompt text';
    const systemPrompt = '';
    const defaultName = 'test_prompt';

    const result = t.context.pathwayManager._createPromptObject(promptItem, systemPrompt, defaultName);

    t.true(result instanceof Prompt);
    t.is(result.name, 'test_prompt');
    t.is(result.messages[0].content, '{{text}}\n\nTest prompt text');
});

test('_createPromptObject handles null system prompt', t => {
    const promptItem = 'Test prompt text';
    const systemPrompt = null;
    const defaultName = 'test_prompt';

    const result = t.context.pathwayManager._createPromptObject(promptItem, systemPrompt, defaultName);

    t.true(result instanceof Prompt);
    t.is(result.name, 'test_prompt');
    t.is(result.messages[0].content, '{{text}}\n\nTest prompt text');
});

test('putPathway requires userId and secret', async t => {
    const pathway = { prompt: ['test'] };
    
    // Missing both
    await t.throwsAsync(
        () => t.context.pathwayManager.putPathway('test', pathway),
        { message: 'Both userId and secret are mandatory for adding or updating a pathway' }
    );
    
    // Missing secret
    await t.throwsAsync(
        () => t.context.pathwayManager.putPathway('test', pathway, 'user123'),
        { message: 'Both userId and secret are mandatory for adding or updating a pathway' }
    );
    
    // Missing userId
    await t.throwsAsync(
        () => t.context.pathwayManager.putPathway('test', pathway, null, 'secret123'),
        { message: 'Both userId and secret are mandatory for adding or updating a pathway' }
    );
});

test('putPathway stores pathway with correct format', async t => {
    // Mock the storage and loading methods
    const mockPathways = {};
    t.context.pathwayManager.pathways = mockPathways;
    t.context.pathwayManager.getLatestPathways = sinon.stub().resolves(mockPathways);
    t.context.pathwayManager.savePathways = sinon.stub().resolves();
    t.context.pathwayManager.loadPathways = sinon.stub().resolves();

    const pathway = {
        prompt: [
            { name: 'Test Prompt', prompt: 'Test prompt text' }
        ],
        systemPrompt: 'System prompt',
        model: 'gpt-4'
    };

    const result = await t.context.pathwayManager.putPathway(
        'testPathway',
        pathway,
        'user123',
        'secret123',
        'Test Pathway Display'
    );

    t.is(result, 'testPathway');
    t.truthy(mockPathways['user123']);
    t.truthy(mockPathways['user123']['testPathway']);
    
    const storedPathway = mockPathways['user123']['testPathway'];
    t.is(storedPathway.secret, 'secret123');
    t.is(storedPathway.displayName, 'Test Pathway Display');
    t.deepEqual(storedPathway.prompt, pathway.prompt);
    t.is(storedPathway.systemPrompt, 'System prompt');
    t.is(storedPathway.model, 'gpt-4');
});

test('getPathways returns array of pathways for each prompt (string format)', async t => {
    const pathwayTemplate = {
        prompt: [
            'First prompt text',
            'Second prompt text',
            'Third prompt text'
        ],
        systemPrompt: 'You are a helpful assistant',
        model: 'gpt-4',
        enableCache: true,
        customProperty: 'test-value'
    };

    const result = await t.context.pathwayManager.getPathways(pathwayTemplate);

    t.is(result.length, 3);
    
    // Check each pathway has the correct structure
    result.forEach((pathway, index) => {
        t.is(pathway.systemPrompt, 'You are a helpful assistant');
        t.is(pathway.model, 'gpt-4');
        t.is(pathway.enableCache, true);
        t.is(pathway.customProperty, 'test-value');
        t.is(pathway.prompt.length, 1);
        t.true(pathway.prompt[0] instanceof Prompt);
        
        // Check the prompt content
        const expectedContent = `{{text}}\n\n${pathwayTemplate.prompt[index]}`;
        t.is(pathway.prompt[0].messages[1].content, expectedContent);
        t.is(pathway.prompt[0].messages[0].content, 'You are a helpful assistant');
        t.is(pathway.prompt[0].name, `prompt_${index}`);
    });
});

test('getPathways returns array of pathways for each prompt (object format)', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'Grammar Check', prompt: 'Check the grammar of this text' },
            { name: 'Tone Analysis', prompt: 'Analyze the tone of this text' },
            { name: 'Summary', prompt: 'Summarize this text' }
        ],
        systemPrompt: 'You are an expert editor',
        model: 'gpt-4-turbo'
    };

    const result = await t.context.pathwayManager.getPathways(pathwayTemplate);

    t.is(result.length, 3);
    
    // Check each pathway has the correct structure and names
    const expectedNames = ['Grammar Check', 'Tone Analysis', 'Summary'];
    const expectedPrompts = [
        'Check the grammar of this text',
        'Analyze the tone of this text', 
        'Summarize this text'
    ];
    
    result.forEach((pathway, index) => {
        t.is(pathway.systemPrompt, 'You are an expert editor');
        t.is(pathway.model, 'gpt-4-turbo');
        t.is(pathway.prompt.length, 1);
        t.true(pathway.prompt[0] instanceof Prompt);
        
        // Check the prompt content and name
        const expectedContent = `{{text}}\n\n${expectedPrompts[index]}`;
        t.is(pathway.prompt[0].messages[1].content, expectedContent);
        t.is(pathway.prompt[0].messages[0].content, 'You are an expert editor');
        t.is(pathway.prompt[0].name, expectedNames[index]);
    });
});

test('getPathways handles mixed format prompt arrays', async t => {
    const pathwayTemplate = {
        prompt: [
            'Legacy string prompt',
            { name: 'Named Prompt', prompt: 'Named prompt text' },
            { prompt: 'Unnamed object prompt' }
        ],
        systemPrompt: 'Mixed format system'
    };

    const result = await t.context.pathwayManager.getPathways(pathwayTemplate);

    t.is(result.length, 3);
    
    // First pathway (string format)
    t.is(result[0].prompt[0].messages[1].content, '{{text}}\n\nLegacy string prompt');
    t.is(result[0].prompt[0].name, 'prompt_0');
    
    // Second pathway (named object)
    t.is(result[1].prompt[0].messages[1].content, '{{text}}\n\nNamed prompt text');
    t.is(result[1].prompt[0].name, 'Named Prompt');
    
    // Third pathway (unnamed object)
    t.is(result[2].prompt[0].messages[1].content, '{{text}}\n\nUnnamed object prompt');
    t.is(result[2].prompt[0].name, 'prompt_2');
});

test('getPathways throws error for non-array prompt', async t => {
    const pathwayTemplate = {
        prompt: 'This should be an array',
        systemPrompt: 'Test system prompt'
    };

    await t.throwsAsync(
        () => t.context.pathwayManager.getPathways(pathwayTemplate),
        { message: 'pathwayTemplate.prompt must be an array' }
    );
});

test('getPathways handles empty prompt array', async t => {
    const pathwayTemplate = {
        prompt: [],
        systemPrompt: 'Empty array test'
    };

    const result = await t.context.pathwayManager.getPathways(pathwayTemplate);

    t.is(result.length, 0);
    t.true(Array.isArray(result));
});

test('getPathways preserves all template properties', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'Test Prompt', prompt: 'Test content' }
        ],
        systemPrompt: 'System test',
        model: 'gpt-4',
        enableCache: false,
        inputParameters: { temperature: 0.7 },
        customProperty: 'preserved',
        displayName: 'Test Display Name'
    };

    const result = await t.context.pathwayManager.getPathways(pathwayTemplate);

    t.is(result.length, 1);
    const pathway = result[0];
    
    t.is(pathway.systemPrompt, 'System test');
    t.is(pathway.model, 'gpt-4');
    t.is(pathway.enableCache, false);
    t.deepEqual(pathway.inputParameters, { temperature: 0.7 });
    t.is(pathway.customProperty, 'preserved');
    t.is(pathway.displayName, 'Test Display Name');
});

test('getPathways filters by promptNames (object format)', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'Grammar Check', prompt: 'Check the grammar of this text' },
            { name: 'Tone Analysis', prompt: 'Analyze the tone of this text' },
            { name: 'Summary', prompt: 'Summarize this text' },
            { name: 'Translation', prompt: 'Translate this text' }
        ],
        systemPrompt: 'You are an expert editor'
    };

    const result = await t.context.pathwayManager.getPathways(
        pathwayTemplate, 
        ['Grammar Check', 'Summary']
    );

    t.is(result.length, 2);
    
    // Check that only the requested prompts are included
    t.is(result[0].prompt[0].name, 'Grammar Check');
    t.is(result[0].prompt[0].messages[1].content, '{{text}}\n\nCheck the grammar of this text');
    
    t.is(result[1].prompt[0].name, 'Summary');
    t.is(result[1].prompt[0].messages[1].content, '{{text}}\n\nSummarize this text');
    
    // Ensure no _originalPromptName property remains
    t.false('_originalPromptName' in result[0]);
    t.false('_originalPromptName' in result[1]);
});

test('getPathways filters by promptNames (string format)', async t => {
    const pathwayTemplate = {
        prompt: [
            'First prompt text',
            'Second prompt text',
            'Third prompt text'
        ],
        systemPrompt: 'You are a helpful assistant'
    };

    const result = await t.context.pathwayManager.getPathways(
        pathwayTemplate, 
        ['prompt_0', 'prompt_2']
    );

    t.is(result.length, 2);
    
    // Check that only the requested prompts are included
    t.is(result[0].prompt[0].name, 'prompt_0');
    t.is(result[0].prompt[0].messages[1].content, '{{text}}\n\nFirst prompt text');
    
    t.is(result[1].prompt[0].name, 'prompt_2');
    t.is(result[1].prompt[0].messages[1].content, '{{text}}\n\nThird prompt text');
});

test('getPathways filters by promptNames (mixed format)', async t => {
    const pathwayTemplate = {
        prompt: [
            'Legacy string prompt',
            { name: 'Named Prompt', prompt: 'Named prompt text' },
            { prompt: 'Unnamed object prompt' }
        ],
        systemPrompt: 'Mixed format system'
    };

    const result = await t.context.pathwayManager.getPathways(
        pathwayTemplate, 
        ['prompt_0', 'Named Prompt']
    );

    t.is(result.length, 2);
    
    // Check first filtered result (string format)
    t.is(result[0].prompt[0].name, 'prompt_0');
    t.is(result[0].prompt[0].messages[1].content, '{{text}}\n\nLegacy string prompt');
    
    // Check second filtered result (named object)
    t.is(result[1].prompt[0].name, 'Named Prompt');
    t.is(result[1].prompt[0].messages[1].content, '{{text}}\n\nNamed prompt text');
});

test('getPathways returns empty array when no promptNames match', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'Grammar Check', prompt: 'Check grammar' },
            { name: 'Tone Analysis', prompt: 'Analyze tone' }
        ],
        systemPrompt: 'System prompt'
    };

    const result = await t.context.pathwayManager.getPathways(
        pathwayTemplate, 
        ['Non-existent Prompt', 'Another Missing Prompt']
    );

    t.is(result.length, 0);
    t.true(Array.isArray(result));
});

test('getPathways returns all pathways when promptNames is empty array', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'First', prompt: 'First prompt' },
            { name: 'Second', prompt: 'Second prompt' }
        ],
        systemPrompt: 'System prompt'
    };

    const result = await t.context.pathwayManager.getPathways(
        pathwayTemplate, 
        []
    );

    t.is(result.length, 2);
});

test('getPathways returns all pathways when promptNames is null', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'First', prompt: 'First prompt' },
            { name: 'Second', prompt: 'Second prompt' }
        ],
        systemPrompt: 'System prompt'
    };

    const result = await t.context.pathwayManager.getPathways(pathwayTemplate, null);

    t.is(result.length, 2);
});

test('isLegacyPromptFormat identifies legacy format (array of strings)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with legacy prompts
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [
                    'First prompt text',
                    'Second prompt text',
                    'Third prompt text'
                ]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.true(result);
});

test('isLegacyPromptFormat identifies new format (array of objects)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with new format prompts
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [
                    { name: 'First Prompt', prompt: 'First prompt text' },
                    { name: 'Second Prompt', prompt: 'Second prompt text' },
                    { prompt: 'Third prompt text' } // name is optional
                ]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.false(result);
});

test('isLegacyPromptFormat handles empty array (defaults to new format)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with empty prompts array
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: []
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.false(result);
});

test('isLegacyPromptFormat handles mixed format (treats as legacy)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with mixed format prompts
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [
                    'Legacy string prompt',
                    { name: 'New format prompt', prompt: 'New format text' }
                ]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.true(result);
});

test('isLegacyPromptFormat throws error for invalid parameters', t => {
    t.throws(() => {
        t.context.pathwayManager.isLegacyPromptFormat('', 'pathwayName');
    }, { message: 'userId must be a non-empty string' });
    
    t.throws(() => {
        t.context.pathwayManager.isLegacyPromptFormat(null, 'pathwayName');
    }, { message: 'userId must be a non-empty string' });
    
    t.throws(() => {
        t.context.pathwayManager.isLegacyPromptFormat('userId', '');
    }, { message: 'pathwayName must be a non-empty string' });
    
    t.throws(() => {
        t.context.pathwayManager.isLegacyPromptFormat('userId', null);
    }, { message: 'pathwayName must be a non-empty string' });
});

test('isLegacyPromptFormat handles objects with missing prompt property (treats as legacy)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with invalid objects
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [
                    { name: 'Missing prompt property' },
                    { name: 'Another invalid object', notPrompt: 'invalid' }
                ]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.true(result);
});

test('isLegacyPromptFormat handles objects with null prompt property (treats as legacy)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with null prompt properties
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [
                    { name: 'Null prompt', prompt: null },
                    { name: 'Another null prompt', prompt: null }
                ]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.true(result);
});

test('isLegacyPromptFormat handles array with null elements (treats as legacy)', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with null elements
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [
                    null,
                    'Some string prompt',
                    null
                ]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.true(result);
});

test('isLegacyPromptFormat handles single string element', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with single string element
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: ['Only prompt']
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.true(result);
});

test('isLegacyPromptFormat handles single object element', t => {
    const userId = 'testUser';
    const pathwayName = 'testPathway';
    
    // Set up pathway with single object element
    t.context.pathwayManager.pathways = {
        [userId]: {
            [pathwayName]: {
                prompt: [{ name: 'Only prompt', prompt: 'Only prompt text' }]
            }
        }
    };
    
    const result = t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    t.false(result);
});

test('isLegacyPromptFormat throws error when pathway not found', t => {
    const userId = 'testUser';
    const pathwayName = 'nonExistentPathway';
    
    // Set up empty pathways
    t.context.pathwayManager.pathways = {};
    
    t.throws(() => {
        t.context.pathwayManager.isLegacyPromptFormat(userId, pathwayName);
    }, { message: `Pathway 'nonExistentPathway' not found for user 'testUser'` });
});

test('getPathways throws error for non-array promptNames', async t => {
    const pathwayTemplate = {
        prompt: [
            { name: 'Test', prompt: 'Test prompt' }
        ],
        systemPrompt: 'System prompt'
    };

    await t.throwsAsync(
        () => t.context.pathwayManager.getPathways(pathwayTemplate, 'not-an-array'),
        { message: 'promptNames must be an array if provided' }
    );
});

// Note: executeSpecificPrompts tests have been moved to GraphQL integration tests
// since the function is now part of the GraphQL resolver layer, not the PathwayManager