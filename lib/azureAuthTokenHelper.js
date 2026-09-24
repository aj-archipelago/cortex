import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';

const DEFAULT_AZURE_FOUNDRY_SCOPE = 'https://ai.azure.com/.default';

class AzureAuthTokenHelper {
  constructor(config = {}, { credential } = {}) {
    this.scope = config.azureFoundryScope || DEFAULT_AZURE_FOUNDRY_SCOPE;
    this.credential = credential || (process.env.WEBSITE_INSTANCE_ID
      ? new ManagedIdentityCredential()
      : new DefaultAzureCredential());
  }

  getTokenCredential() {
    return this.credential;
  }

  async getAccessToken() {
    try {
      const accessToken = await this.credential.getToken(this.scope);
      if (!accessToken?.token) {
        throw new Error('Azure credential returned no access token');
      }
      return accessToken.token;
    } catch (error) {
      throw new Error(`Failed to acquire Azure token: ${error.message}`);
    }
  }
}

export default AzureAuthTokenHelper;
