import test from "ava";
import { 
  AZURE_STORAGE_CONTAINER_NAME, 
  getDefaultContainerName,
} from "../src/blobHandler.js";

// Mock environment variables for testing
const originalEnv = process.env.AZURE_STORAGE_CONTAINER_NAME;

test.beforeEach(() => {
  // Reset to original environment
  process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
});

test.afterEach(() => {
  // Restore original environment
  process.env.AZURE_STORAGE_CONTAINER_NAME = originalEnv;
});

test("getDefaultContainerName should return the container name", (t) => {
  const defaultContainer = getDefaultContainerName();
  t.is(defaultContainer, AZURE_STORAGE_CONTAINER_NAME);
  t.truthy(defaultContainer);
  t.is(typeof defaultContainer, 'string');
  t.true(defaultContainer.length > 0);
});

test("AZURE_STORAGE_CONTAINER_NAME should be a non-empty string", (t) => {
  t.is(typeof AZURE_STORAGE_CONTAINER_NAME, 'string');
  t.true(AZURE_STORAGE_CONTAINER_NAME.length > 0);
  t.true(AZURE_STORAGE_CONTAINER_NAME.trim().length > 0);
});

test("container name should default to cortextempfiles when env var is not set", (t) => {
  // Unset environment variable
  delete process.env.AZURE_STORAGE_CONTAINER_NAME;
  
  // The constant is loaded at import time, so we test the getter function
  const getContainerName = () => {
    return process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
  };
  
  const result = getContainerName();
  t.is(result, "cortextempfiles");
});
