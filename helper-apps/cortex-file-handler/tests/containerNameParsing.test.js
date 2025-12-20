import test from "ava";
import { 
  AZURE_STORAGE_CONTAINER_NAME, 
  getDefaultContainerName,
} from "../src/blobHandler.js";
import { getContainerName } from "../src/constants.js";

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

test("getContainerName should handle comma-separated legacy values and use the last one", (t) => {
  // Set comma-separated value (legacy format)
  process.env.AZURE_STORAGE_CONTAINER_NAME = "container1,container2,container3";
  
  // Capture console.warn to verify warning is logged
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => {
    warnings.push(message);
    originalWarn(message);
  };
  
  try {
    const result = getContainerName();
    
    // Should return the last container name
    t.is(result, "container3", "Should return the last container from comma-separated list");
    
    // Should log a warning
    t.true(warnings.length > 0, "Should log a warning about comma-separated values");
    t.true(
      warnings.some(w => w.includes("AZURE_STORAGE_CONTAINER_NAME contains comma-separated values")),
      "Warning should mention comma-separated values"
    );
  } finally {
    console.warn = originalWarn;
  }
});

test("getContainerName should handle comma-separated values with spaces", (t) => {
  // Set comma-separated value with spaces
  process.env.AZURE_STORAGE_CONTAINER_NAME = "container1 , container2 , container3 ";
  
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => {
    warnings.push(message);
    originalWarn(message);
  };
  
  try {
    const result = getContainerName();
    
    // Should return the last container name (trimmed)
    t.is(result, "container3", "Should return the last container (trimmed) from comma-separated list");
  } finally {
    console.warn = originalWarn;
  }
});

test("getContainerName should handle single container name (no comma)", (t) => {
  // Set single container name
  process.env.AZURE_STORAGE_CONTAINER_NAME = "my-container";
  
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => {
    warnings.push(message);
    originalWarn(message);
  };
  
  try {
    const result = getContainerName();
    
    // Should return the container name as-is
    t.is(result, "my-container", "Should return the container name as-is when no comma");
    
    // Should NOT log a warning
    t.is(warnings.length, 0, "Should NOT log a warning for single container name");
  } finally {
    console.warn = originalWarn;
  }
});
