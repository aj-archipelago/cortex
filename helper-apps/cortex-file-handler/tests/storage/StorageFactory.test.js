import test from "ava";
import { StorageFactory } from "../../src/services/storage/StorageFactory.js";

test("should get primary provider based on environment", (t) => {
  const factory = new StorageFactory();
  const provider = factory.getPrimaryProvider();
  t.truthy(provider);
});

test("should get azure provider when configured", (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();
  const provider = factory.getAzureProvider();
  t.truthy(provider);
});

test("should get gcs provider when configured", (t) => {
  if (
    !process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 &&
    !process.env.GCP_SERVICE_ACCOUNT_KEY
  ) {
    t.pass("Skipping test - GCS not configured");
    return;
  }

  const factory = new StorageFactory();
  const provider = factory.getGCSProvider();
  t.truthy(provider);
});

test("should get local provider", (t) => {
  const factory = new StorageFactory();
  const provider = factory.getLocalProvider();
  t.truthy(provider);
});

test("should return null for gcs provider when not configured", (t) => {
  // Save original env
  const originalGcpKey = process.env.GCP_SERVICE_ACCOUNT_KEY;
  const originalGcpKeyBase64 = process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;

  // Clear GCP credentials
  delete process.env.GCP_SERVICE_ACCOUNT_KEY;
  delete process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;

  const factory = new StorageFactory();
  const provider = factory.getGCSProvider();
  t.is(provider, null);

  // Restore original env
  process.env.GCP_SERVICE_ACCOUNT_KEY = originalGcpKey;
  process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 = originalGcpKeyBase64;
});

test("should parse base64 gcs credentials", (t) => {
  const testCredentials = {
    project_id: "test-project",
    client_email: "test@test.com",
    private_key: "test-key",
  };

  const base64Credentials = Buffer.from(
    JSON.stringify(testCredentials),
  ).toString("base64");
  process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64 = base64Credentials;

  const factory = new StorageFactory();
  const credentials = factory.parseGCSCredentials();
  t.deepEqual(credentials, testCredentials);

  // Cleanup
  delete process.env.GCP_SERVICE_ACCOUNT_KEY_BASE64;
});

test("should parse json gcs credentials", (t) => {
  const testCredentials = {
    project_id: "test-project",
    client_email: "test@test.com",
    private_key: "test-key",
  };

  process.env.GCP_SERVICE_ACCOUNT_KEY = JSON.stringify(testCredentials);

  const factory = new StorageFactory();
  const credentials = factory.parseGCSCredentials();
  t.deepEqual(credentials, testCredentials);

  // Cleanup
  delete process.env.GCP_SERVICE_ACCOUNT_KEY;
});

test("should return null for invalid gcs credentials", (t) => {
  process.env.GCP_SERVICE_ACCOUNT_KEY = "invalid-json";

  const factory = new StorageFactory();
  const credentials = factory.parseGCSCredentials();
  t.is(credentials, null);

  // Cleanup
  delete process.env.GCP_SERVICE_ACCOUNT_KEY;
});

// Container-specific tests
test("should get azure provider with default container when no container specified", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();
  const provider = await factory.getAzureProvider();
  t.truthy(provider);
  t.truthy(provider.containerName);
});

test("should get azure provider with custom container name", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();

  // Custom container names are used for per-user containers
  const provider = await factory.getAzureProvider("custom-container");
  t.truthy(provider);
  t.is(provider.containerName, "custom-container");
});

test("should return different providers for different container names", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();

  const provider1 = await factory.getAzureProvider("container-a");
  const provider2 = await factory.getAzureProvider();

  // Different containers should yield different provider instances
  t.not(provider1, provider2);
  t.is(provider1.containerName, "container-a");
});

test("should cache provider instance per container name", async (t) => {
  if (!process.env.AZURE_STORAGE_CONNECTION_STRING) {
    t.pass("Skipping test - Azure not configured");
    return;
  }

  const factory = new StorageFactory();

  // Same container name should return the same cached instance
  const provider1 = await factory.getAzureProvider();
  const provider2 = await factory.getAzureProvider();
  t.is(provider1, provider2);

  // Different container name returns a different instance
  const provider3 = await factory.getAzureProvider("other-container");
  t.not(provider1, provider3);

  // But asking for that same name again returns the cached one
  const provider4 = await factory.getAzureProvider("other-container");
  t.is(provider3, provider4);
});
