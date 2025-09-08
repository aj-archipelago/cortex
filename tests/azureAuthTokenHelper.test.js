import test from 'ava';
import AzureAuthTokenHelper from '../lib/azureAuthTokenHelper.js';

test('should initialize with valid credentials', (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: '648085d9-6878-44a9-a76b-0223882f8268',
      client_id: '8796f9a6-cd80-45dd-91b8-9ddf384ee42c',
      client_secret: 'test-secret',
      scope: 'https://ai.azure.com/.default'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  
  t.is(azureHelper.tenantId, '648085d9-6878-44a9-a76b-0223882f8268');
  t.is(azureHelper.clientId, '8796f9a6-cd80-45dd-91b8-9ddf384ee42c');
  t.is(azureHelper.clientSecret, 'test-secret');
  t.is(azureHelper.scope, 'https://ai.azure.com/.default');
  t.is(azureHelper.tokenUrl, 'https://login.microsoftonline.com/648085d9-6878-44a9-a76b-0223882f8268/oauth2/v2.0/token');
});

test('should throw error when azureCredentials is missing', (t) => {
  t.throws(() => {
    new AzureAuthTokenHelper({});
  }, { message: 'AZURE_SERVICE_PRINCIPAL_CREDENTIALS is missing or undefined' });
});

test('should throw error when required fields are missing', (t) => {
  const invalidConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant'
      // missing client_id and client_secret
    })
  };

  t.throws(() => {
    new AzureAuthTokenHelper(invalidConfig);
  }, { message: 'Azure credentials must include tenant_id, client_id, and client_secret' });
});

test('should support both snake_case and camelCase field names', (t) => {
  const camelCaseConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenantId: '648085d9-6878-44a9-a76b-0223882f8268',
      clientId: '8796f9a6-cd80-45dd-91b8-9ddf384ee42c',
      clientSecret: 'test-secret',
      scope: 'https://ai.azure.com/.default'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(camelCaseConfig);
  
  t.is(azureHelper.tenantId, '648085d9-6878-44a9-a76b-0223882f8268');
  t.is(azureHelper.clientId, '8796f9a6-cd80-45dd-91b8-9ddf384ee42c');
  t.is(azureHelper.clientSecret, 'test-secret');
});

test('isTokenValid should return false when no token exists', (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant',
      client_id: 'test-client',
      client_secret: 'test-secret'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  t.false(azureHelper.isTokenValid());
});

test('isTokenValid should return false when token is expired', (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant',
      client_id: 'test-client',
      client_secret: 'test-secret'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  azureHelper.token = 'test-token';
  azureHelper.expiry = new Date(Date.now() - 1000); // expired 1 second ago
  t.false(azureHelper.isTokenValid());
});

test('isTokenValid should return true when token is valid with buffer', (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant',
      client_id: 'test-client',
      client_secret: 'test-secret'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  azureHelper.token = 'test-token';
  azureHelper.expiry = new Date(Date.now() + 10 * 60 * 1000); // expires in 10 minutes
  t.true(azureHelper.isTokenValid());
});

test('isTokenValid should return false when token expires within buffer time', (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant',
      client_id: 'test-client',
      client_secret: 'test-secret'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  azureHelper.token = 'test-token';
  azureHelper.expiry = new Date(Date.now() + 3 * 60 * 1000); // expires in 3 minutes (within 5-minute buffer)
  t.false(azureHelper.isTokenValid());
});

test('getAccessToken should return existing token if valid', async (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant',
      client_id: 'test-client',
      client_secret: 'test-secret'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  azureHelper.token = 'existing-token';
  azureHelper.expiry = new Date(Date.now() + 10 * 60 * 1000);

  const token = await azureHelper.getAccessToken();
  t.is(token, 'existing-token');
});

test('getAccessToken should throw error when token is invalid and no network available', async (t) => {
  const mockConfig = {
    azureServicePrincipalCredentials: JSON.stringify({
      tenant_id: 'test-tenant',
      client_id: 'test-client',
      client_secret: 'test-secret'
    })
  };

  const azureHelper = new AzureAuthTokenHelper(mockConfig);
  // No token set, so it will try to refresh and fail

  await t.throwsAsync(
    azureHelper.getAccessToken(),
    { message: /Failed to refresh Azure token/ }
  );
}); 