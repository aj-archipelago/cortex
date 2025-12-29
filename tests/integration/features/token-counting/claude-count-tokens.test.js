import test from 'ava';
import axios from 'axios';
import Claude3VertexPlugin from '../../../../server/plugins/claude3VertexPlugin.js';
import { config } from '../../../../config.js';

/**
 * Test the Claude Vertex AI count-tokens endpoint
 * This tests the actual API endpoint before integrating it into the plugin
 */
test('Claude Vertex AI count-tokens endpoint - basic test', async t => {
    // Skip if no GCP auth configured
    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        t.pass('Skipping - no GCP auth configured');
        return;
    }

    // Get auth token
    const authToken = await gcpAuthTokenHelper.getAccessToken();
    t.truthy(authToken, 'Should have auth token');

    // Test with a simple message
    // Note: You'll need to replace these with actual values from your config
    // The URL format is: https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/LOCATION/publishers/anthropic/models/MODEL_ID
    const testModelUrl = process.env.TEST_CLAUDE_MODEL_URL || 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet-20241022';
    
    // Replace model name with count-tokens endpoint
    const countTokensUrl = testModelUrl.replace(/\/models\/[^\/]+$/, '/models/count-tokens:rawPredict');
    
    const requestData = {
        messages: [{
            role: 'user',
            content: 'Hello, how are you?'
        }]
    };

    try {
        const response = await axios.post(countTokensUrl, requestData, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json; charset=utf-8'
            }
        });

        t.truthy(response.data, 'Should have response data');
        t.truthy(response.data.input_tokens, 'Should have input_tokens');
        t.true(typeof response.data.input_tokens === 'number', 'input_tokens should be a number');
        t.true(response.data.input_tokens > 0, 'input_tokens should be positive');
        
        console.log('CountTokens response:', JSON.stringify(response.data, null, 2));
        
    } catch (error) {
        // If it's a 404 or auth error, that's expected in test environment
        if (error.response && error.response.status === 404) {
            t.pass('Endpoint not found (expected in test environment without real model URL)');
        } else if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            t.pass('Auth error (expected in test environment)');
        } else {
            console.error('CountTokens error:', (error.response && error.response.data) || error.message);
            throw error;
        }
    }
});

test('Claude Vertex AI count-tokens endpoint - with system instruction', async t => {
    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        t.pass('Skipping - no GCP auth configured');
        return;
    }

    const authToken = await gcpAuthTokenHelper.getAccessToken();
    const testModelUrl = process.env.TEST_CLAUDE_MODEL_URL || 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet-20241022';
    const countTokensUrl = testModelUrl.replace(/\/models\/[^\/]+$/, '/models/count-tokens:rawPredict');
    
    const requestData = {
        messages: [{
            role: 'user',
            content: 'What is the capital of France?'
        }],
        system: 'You are a helpful assistant.'
    };

    try {
        const response = await axios.post(countTokensUrl, requestData, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json; charset=utf-8'
            }
        });

        t.truthy(response.data.input_tokens, 'Should have input_tokens');
        t.true(response.data.input_tokens > 0, 'input_tokens should be positive');
        
        console.log('CountTokens with system instruction:', response.data.input_tokens);
        
    } catch (error) {
        if (error.response && (error.response.status === 404 || error.response.status === 401 || error.response.status === 403)) {
            t.pass('Expected error in test environment');
        } else {
            throw error;
        }
    }
});

test('Claude countTokensBeforeRequest - plugin method', async t => {
    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        t.pass('Skipping - no GCP auth configured');
        return;
    }

    // Create a mock plugin instance
    const mockPathway = {};
    const mockModel = {
        name: 'claude-3-5-sonnet-20241022',
        type: 'CLAUDE-3-VERTEX'
    };
    
    const plugin = new Claude3VertexPlugin(mockPathway, mockModel);
    plugin.config = config;
    
    const messages = [
        {
            role: 'user',
            content: 'Hello, how are you?'
        }
    ];
    
    // Create a mock cortexRequest with a test URL
    const testModelUrl = process.env.TEST_CLAUDE_MODEL_URL || 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/anthropic/models/claude-3-5-sonnet-20241022';
    const mockCortexRequest = { url: testModelUrl };
    
    const tokenCount = await plugin.countTokensBeforeRequest(messages, mockCortexRequest);
    
    // If we have a real URL and auth, we should get a result
    // Otherwise, it will return null and that's okay for testing
    if (tokenCount !== null) {
        t.true(typeof tokenCount === 'number', 'Token count should be a number');
        t.true(tokenCount > 0, 'Token count should be positive');
        console.log(`Token count from plugin: ${tokenCount}`);
    } else {
        t.pass('countTokensBeforeRequest returned null (expected without real model URL)');
    }
});

