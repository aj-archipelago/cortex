import { GoogleAuth } from 'google-auth-library';

class GcpAuthTokenHelper {
  constructor(config) {
    const creds = config.gcpServiceAccountKey ? JSON.parse(config.gcpServiceAccountKey) : null;
    if (!creds) {
      throw new Error('GCP_SERVICE_ACCOUNT_KEY is missing or undefined');
    }
    this.authClient = new GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    this.token = null;
    this.expiry = null;
  }

  async getAccessToken() {
    if (!this.token || !this.isTokenValid()) {
      await this.refreshToken();
    }
    return this.token;
  }

  isTokenValid() {
    // Check if token is still valid with a 5-minute buffer
    return this.expiry && Date.now() < this.expiry.getTime() - 5 * 60 * 1000;
  }

  async refreshToken() {
    const authClient = await this.authClient.getClient();
    const accessTokenResponse = await authClient.getAccessToken();
    this.token = accessTokenResponse.token;
    this.expiry = new Date(accessTokenResponse.expirationTime);
  }
}

export default GcpAuthTokenHelper;