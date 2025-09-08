import fetch from 'node-fetch';

class AzureAuthTokenHelper {
  constructor(config) {
    // Parse Azure credentials from config
    const azureCredentials = config.azureServicePrincipalCredentials ? JSON.parse(config.azureServicePrincipalCredentials) : null;
    
    if (!azureCredentials) {
      throw new Error('AZURE_SERVICE_PRINCIPAL_CREDENTIALS is missing or undefined');
    }

    // Extract required fields
    this.tenantId = azureCredentials.tenant_id || azureCredentials.tenantId;
    this.clientId = azureCredentials.client_id || azureCredentials.clientId;
    this.clientSecret = azureCredentials.client_secret || azureCredentials.clientSecret;
    this.scope = azureCredentials.scope || 'https://ai.azure.com/.default';

    if (!this.tenantId || !this.clientId || !this.clientSecret) {
      throw new Error('Azure credentials must include tenant_id, client_id, and client_secret');
    }

    this.token = null;
    this.expiry = null;
    this.tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
  }

  async getAccessToken() {
    if (!this.token || !this.isTokenValid()) {
      await this.refreshToken();
    }
    return this.token;
  }

  isTokenValid() {
    // Check if token is still valid with a 5-minute buffer
    return !!(this.expiry && Date.now() < this.expiry.getTime() - 5 * 60 * 1000);
  }

  async refreshToken() {
    try {
      const formData = new URLSearchParams();
      formData.append('client_id', this.clientId);
      formData.append('client_secret', this.clientSecret);
      formData.append('scope', this.scope);
      formData.append('grant_type', 'client_credentials');

      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure token request failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const tokenData = await response.json();

      if (!tokenData.access_token) {
        throw new Error('Azure token response missing access_token');
      }

      this.token = tokenData.access_token;
      
      // Calculate expiry time (expires_in is in seconds)
      const expiresInMs = (tokenData.expires_in || 3600) * 1000;
      this.expiry = new Date(Date.now() + expiresInMs);

    } catch (error) {
      throw new Error(`Failed to refresh Azure token: ${error.message}`);
    }
  }
}

export default AzureAuthTokenHelper; 