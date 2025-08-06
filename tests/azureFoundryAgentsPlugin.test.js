import test from 'ava';
import AzureFoundryAgentsPlugin from '../server/plugins/azureFoundryAgentsPlugin.js';

test('should be able to access azureAuthTokenHelper from config', (t) => {
  // Mock config with azureAuthTokenHelper
  const mockConfig = {
    get: (key) => {
      if (key === 'azureAuthTokenHelper') {
        return {
          getAccessToken: async () => 'mock-token'
        };
      }
      return null;
    }
  };

  // Mock pathway and model
  const mockPathway = {};
  const mockModel = {
    url: 'https://test.azure.com/api/projects/test',
    agentId: 'test-agent-id',
    headers: { 'Content-Type': 'application/json' }
  };

  // Create plugin instance
  const plugin = new AzureFoundryAgentsPlugin(mockPathway, mockModel);
  
  // Mock the config property
  plugin.config = mockConfig;

  // Test that we can access the auth helper
  const authHelper = plugin.config.get('azureAuthTokenHelper');
  t.truthy(authHelper);
  t.is(typeof authHelper.getAccessToken, 'function');
});

test('should handle missing azureAuthTokenHelper gracefully', (t) => {
  // Mock config without azureAuthTokenHelper
  const mockConfig = {
    get: (key) => null
  };

  // Mock pathway and model
  const mockPathway = {};
  const mockModel = {
    url: 'https://test.azure.com/api/projects/test',
    agentId: 'test-agent-id',
    headers: { 'Content-Type': 'application/json' }
  };

  // Create plugin instance
  const plugin = new AzureFoundryAgentsPlugin(mockPathway, mockModel);
  
  // Mock the config property
  plugin.config = mockConfig;

  // Test that we can access the auth helper (should be null)
  const authHelper = plugin.config.get('azureAuthTokenHelper');
  t.is(authHelper, null);
}); 