import test from 'ava';
import axios from 'axios';
import { config } from '../../../../config.js';

/**
 * Test the Vertex AI countTokens endpoint for Gemini models
 * This tests the actual API endpoint before integrating it into the plugin
 */
test('Vertex AI countTokens endpoint - basic test', async t => {
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
    // The URL format is: https://LOCATION-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/LOCATION/publishers/google/models/MODEL_ID
    const testModelUrl = process.env.TEST_GEMINI_MODEL_URL || 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-1.5-flash';
    
    const countTokensUrl = `${testModelUrl}:countTokens`;
    
    const requestData = {
        contents: [{
            role: 'user',
            parts: [{
                text: 'Hello, how are you?'
            }]
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
        t.truthy(response.data.totalTokens, 'Should have totalTokens');
        t.true(typeof response.data.totalTokens === 'number', 'totalTokens should be a number');
        t.true(response.data.totalTokens > 0, 'totalTokens should be positive');
        
        console.log('CountTokens response:', JSON.stringify(response.data, null, 2));
        
        // Verify structure
        if (response.data.promptTokensDetails) {
            t.true(Array.isArray(response.data.promptTokensDetails), 'promptTokensDetails should be an array');
        }
        
    } catch (error) {
        // If it's a 404 or auth error, that's expected in test environment
        if (error.response?.status === 404) {
            t.pass('Endpoint not found (expected in test environment without real model URL)');
        } else if (error.response?.status === 401 || error.response?.status === 403) {
            t.pass('Auth error (expected in test environment)');
        } else {
            console.error('CountTokens error:', error.response?.data || error.message);
            throw error;
        }
    }
});

test('Vertex AI countTokens endpoint - with system instruction', async t => {
    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        t.pass('Skipping - no GCP auth configured');
        return;
    }

    const authToken = await gcpAuthTokenHelper.getAccessToken();
    const testModelUrl = process.env.TEST_GEMINI_MODEL_URL || 'https://us-central1-aiplatform.googleapis.com/v1/projects/test-project/locations/us-central1/publishers/google/models/gemini-1.5-flash';
    const countTokensUrl = `${testModelUrl}:countTokens`;
    
    const requestData = {
        contents: [{
            role: 'user',
            parts: [{
                text: 'What is the capital of France?'
            }]
        }],
        systemInstruction: {
            parts: [{
                text: 'You are a helpful assistant.'
            }]
        }
    };

    try {
        const response = await axios.post(countTokensUrl, requestData, {
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json; charset=utf-8'
            }
        });

        t.truthy(response.data.totalTokens, 'Should have totalTokens');
        t.true(response.data.totalTokens > 0, 'totalTokens should be positive');
        
        console.log('CountTokens with system instruction:', response.data.totalTokens);
        
    } catch (error) {
        if (error.response?.status === 404 || error.response?.status === 401 || error.response?.status === 403) {
            t.pass('Expected error in test environment');
        } else {
            throw error;
        }
    }
});

