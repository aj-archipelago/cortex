import { GoogleAuth } from 'google-auth-library';

class GcpAuthTokenHelper {
  constructor(config) {
    const serviceAccountEmail = config.gcpServiceAccountEmail;
    const serviceAccountKey = config.gcpServiceAccountKey;
    
    // Support both service account key (legacy) and impersonation (recommended)
    if (serviceAccountEmail) {
      // Use service account impersonation (recommended)
      // When using impersonation, GoogleAuth will use Application Default Credentials (ADC)
      // ADC should be configured via: gcloud auth application-default login --impersonate-service-account=EMAIL
      // Passing no credentials means GoogleAuth will use ADC
      this.authClient = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    } else if (serviceAccountKey) {
      // Fall back to service account key (legacy)
      const creds = JSON.parse(serviceAccountKey);
      this.authClient = new GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    } else {
      throw new Error('Either GCP_SERVICE_ACCOUNT_EMAIL (for impersonation) or GCP_SERVICE_ACCOUNT_KEY must be provided');
    }
    
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