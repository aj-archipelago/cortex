import { GoogleAuth } from 'google-auth-library';

class GcpAuthTokenHelper {
  constructor(config) {
    let creds = null;

    if (config.gcpServiceAccountKey) {
      try {
        // First try to parse as-is
        creds = JSON.parse(config.gcpServiceAccountKey);
      } catch (error) {
        try {
          // If that fails, try to fix common JSON issues like unescaped newlines
          const fixedJson = config.gcpServiceAccountKey
            .replace(/\n/g, '\\n')  // Escape newlines
            .replace(/\r/g, '\\r')  // Escape carriage returns
            .replace(/\t/g, '\\t'); // Escape tabs
          creds = JSON.parse(fixedJson);
        } catch (secondError) {
          console.warn('Failed to parse GCP service account key:', secondError.message);
          console.warn('GCP authentication will be disabled.');
          return; // Exit constructor without setting up auth
        }
      }
    }

    if (!creds) {
      console.warn('GCP_SERVICE_ACCOUNT_KEY is missing, undefined, or invalid - GCP authentication disabled');
      return; // Exit constructor without setting up auth
    }

    this.authClient = new GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    this.token = null;
    this.expiry = null;
  }

  async getAccessToken() {
    if (!this.authClient) {
      throw new Error('GCP authentication not properly initialized');
    }
    if (!this.token || !this.isTokenValid()) {
      await this.refreshToken();
    }
    return this.token;
  }

  isTokenValid() {
    if (!this.authClient) return false;
    // Check if token is still valid with a 5-minute buffer
    return this.expiry && Date.now() < this.expiry.getTime() - 5 * 60 * 1000;
  }

  async refreshToken() {
    if (!this.authClient) {
      throw new Error('GCP authentication not properly initialized');
    }
    const authClient = await this.authClient.getClient();
    const accessTokenResponse = await authClient.getAccessToken();
    this.token = accessTokenResponse.token;
    this.expiry = new Date(accessTokenResponse.expirationTime);
  }
}

export default GcpAuthTokenHelper;