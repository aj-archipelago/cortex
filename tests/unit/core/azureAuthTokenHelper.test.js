import test from 'ava';
import AzureAuthTokenHelper from '../../../lib/azureAuthTokenHelper.js';

test.serial('uses managed identity exclusively in Azure App Service', (t) => {
  const previousInstanceId = process.env.WEBSITE_INSTANCE_ID;
  const previousClientId = process.env.AZURE_CLIENT_ID;
  const previousTenantId = process.env.AZURE_TENANT_ID;
  const previousClientSecret = process.env.AZURE_CLIENT_SECRET;
  process.env.WEBSITE_INSTANCE_ID = 'test-instance';
  process.env.AZURE_CLIENT_ID = 'must-not-be-used';
  process.env.AZURE_TENANT_ID = 'must-not-be-used';
  process.env.AZURE_CLIENT_SECRET = 'must-not-be-used';

  try {
    const helper = new AzureAuthTokenHelper({});
    t.is(helper.getTokenCredential().constructor.name, 'ManagedIdentityCredential');
  } finally {
    if (previousInstanceId === undefined) {
      delete process.env.WEBSITE_INSTANCE_ID;
    } else {
      process.env.WEBSITE_INSTANCE_ID = previousInstanceId;
    }
    for (const [name, value] of [
      ['AZURE_CLIENT_ID', previousClientId],
      ['AZURE_TENANT_ID', previousTenantId],
      ['AZURE_CLIENT_SECRET', previousClientSecret],
    ]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test.serial('uses the local Azure credential chain outside App Service', (t) => {
  const previousInstanceId = process.env.WEBSITE_INSTANCE_ID;
  delete process.env.WEBSITE_INSTANCE_ID;

  try {
    const helper = new AzureAuthTokenHelper({});
    t.is(helper.getTokenCredential().constructor.name, 'DefaultAzureCredential');
  } finally {
    if (previousInstanceId !== undefined) {
      process.env.WEBSITE_INSTANCE_ID = previousInstanceId;
    }
  }
});

test('uses one shared Azure token credential', async (t) => {
  let requestedScope;
  const credential = {
    getToken: async (scope) => {
      requestedScope = scope;
      return { token: 'managed-identity-token' };
    },
  };
  const helper = new AzureAuthTokenHelper({}, { credential });

  t.is(helper.getTokenCredential(), credential);
  t.is(await helper.getAccessToken(), 'managed-identity-token');
  t.is(requestedScope, 'https://ai.azure.com/.default');
});

test('supports an explicit Azure Foundry scope', async (t) => {
  let requestedScope;
  const credential = {
    getToken: async (scope) => {
      requestedScope = scope;
      return { token: 'test-token' };
    },
  };
  const helper = new AzureAuthTokenHelper(
    { azureFoundryScope: 'https://example.test/.default' },
    { credential },
  );

  t.is(await helper.getAccessToken(), 'test-token');
  t.is(requestedScope, 'https://example.test/.default');
});

test('reports credential-chain failures clearly', async (t) => {
  const credential = {
    getToken: async () => {
      throw new Error('managed identity unavailable');
    },
  };
  const helper = new AzureAuthTokenHelper({}, { credential });

  await t.throwsAsync(
    helper.getAccessToken(),
    { message: 'Failed to acquire Azure token: managed identity unavailable' },
  );
});

test('rejects an empty access-token response', async (t) => {
  const helper = new AzureAuthTokenHelper({}, {
    credential: { getToken: async () => null },
  });

  await t.throwsAsync(
    helper.getAccessToken(),
    { message: 'Failed to acquire Azure token: Azure credential returned no access token' },
  );
});
