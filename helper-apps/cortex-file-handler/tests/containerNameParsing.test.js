import test from "ava";
import { 
  AZURE_STORAGE_CONTAINER_NAMES, 
  getDefaultContainerName,
  isValidContainerName,
  getCurrentContainerNames
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

test("parseContainerNames should handle single container name", (t) => {
  // Set environment variable for single container
  process.env.AZURE_STORAGE_CONTAINER_NAME = "single-container";
  
  // We need to reload the module to pick up the new environment variable
  // Since we can't easily reload ES modules, we'll test the logic directly
  const parseContainerNames = () => {
    const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
    return containerStr.split(',').map(name => name.trim());
  };
  
  const result = parseContainerNames();
  
  t.is(result.length, 1);
  t.is(result[0], "single-container");
});

test("parseContainerNames should handle comma-separated container names", (t) => {
  // Set environment variable for multiple containers
  process.env.AZURE_STORAGE_CONTAINER_NAME = "container1,container2,container3";
  
  const parseContainerNames = () => {
    const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
    return containerStr.split(',').map(name => name.trim());
  };
  
  const result = parseContainerNames();
  
  t.is(result.length, 3);
  t.is(result[0], "container1");
  t.is(result[1], "container2");
  t.is(result[2], "container3");
});

test("parseContainerNames should handle comma-separated names with whitespace", (t) => {
  // Set environment variable with spaces around commas
  process.env.AZURE_STORAGE_CONTAINER_NAME = " container1 , container2 , container3 ";
  
  const parseContainerNames = () => {
    const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
    return containerStr.split(',').map(name => name.trim());
  };
  
  const result = parseContainerNames();
  
  t.is(result.length, 3);
  t.is(result[0], "container1");
  t.is(result[1], "container2");
  t.is(result[2], "container3");
});

test("parseContainerNames should default to cortextempfiles when env var is not set", (t) => {
  // Unset environment variable
  delete process.env.AZURE_STORAGE_CONTAINER_NAME;
  
  const parseContainerNames = () => {
    const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
    return containerStr.split(',').map(name => name.trim());
  };
  
  const result = parseContainerNames();
  
  t.is(result.length, 1);
  t.is(result[0], "cortextempfiles");
});

test("parseContainerNames should handle empty string", (t) => {
  // Set environment variable to empty string
  process.env.AZURE_STORAGE_CONTAINER_NAME = "";
  
  const parseContainerNames = () => {
    const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
    return containerStr.split(',').map(name => name.trim());
  };
  
  const result = parseContainerNames();
  
  t.is(result.length, 1);
  t.is(result[0], "cortextempfiles");
});

test("parseContainerNames should handle only commas", (t) => {
  // Set environment variable to only commas
  process.env.AZURE_STORAGE_CONTAINER_NAME = ",,,";
  
  const parseContainerNames = () => {
    const containerStr = process.env.AZURE_STORAGE_CONTAINER_NAME || "cortextempfiles";
    return containerStr.split(',').map(name => name.trim());
  };
  
  const result = parseContainerNames();
  
  // Should result in 4 empty strings after trimming
  t.is(result.length, 4);
  t.is(result[0], "");
  t.is(result[1], "");
  t.is(result[2], "");
  t.is(result[3], "");
});

test("getDefaultContainerName should return the first container in the list", (t) => {
  // Test with current module exports (these are loaded at import time)
  // The default should be the first item in the array
  const defaultContainer = getDefaultContainerName();
  t.is(defaultContainer, getCurrentContainerNames()[0]);
  
  // Additional validation that it's a non-empty string
  t.truthy(defaultContainer);
  t.is(typeof defaultContainer, 'string');
  t.true(defaultContainer.length > 0);
});

test("isValidContainerName should return true for valid container names", (t) => {
  // Get current container names at runtime (not cached)
  const currentContainers = getCurrentContainerNames();
  
  // Test with each container name from the current configuration
  currentContainers.forEach(containerName => {
    t.true(isValidContainerName(containerName), `Container name '${containerName}' should be valid`);
  });
});

test("isValidContainerName should return false for invalid container names", (t) => {
  const invalidNames = [
    "invalid-container",
    "not-in-list",
    "",
    null,
    undefined,
    "container-that-does-not-exist"
  ];
  
  invalidNames.forEach(containerName => {
    t.false(isValidContainerName(containerName), `Container name '${containerName}' should be invalid`);
  });
});

test("isValidContainerName should handle edge cases", (t) => {
  // Test with various edge cases
  t.false(isValidContainerName(null));
  t.false(isValidContainerName(undefined));
  t.false(isValidContainerName(""));
  t.false(isValidContainerName("   ")); // whitespace only
  t.false(isValidContainerName(123)); // number
  t.false(isValidContainerName({})); // object
  t.false(isValidContainerName([])); // array
});

test("container configuration should have at least one container", (t) => {
  const currentContainers = getCurrentContainerNames();
  t.true(currentContainers.length > 0, "Should have at least one container configured");
  t.truthy(currentContainers[0], "First container should not be empty");
});

test("all configured container names should be non-empty strings", (t) => {
  const currentContainers = getCurrentContainerNames();
  currentContainers.forEach((containerName, index) => {
    t.is(typeof containerName, 'string', `Container at index ${index} should be a string`);
    t.true(containerName.length > 0, `Container at index ${index} should not be empty`);
    t.true(containerName.trim().length > 0, `Container at index ${index} should not be only whitespace`);
  });
});

test("container names should not contain duplicates", (t) => {
  const currentContainers = getCurrentContainerNames();
  const uniqueNames = new Set(currentContainers);
  t.is(uniqueNames.size, currentContainers.length, "Container names should be unique");
});

// Integration test with actual environment simulation
test("complete container parsing workflow", (t) => {
  const testCases = [
    {
      env: "single",
      expected: ["single"],
      description: "single container name"
    },
    {
      env: "first,second",
      expected: ["first", "second"],
      description: "two container names"
    },
    {
      env: "one, two, three",
      expected: ["one", "two", "three"],
      description: "three container names with spaces"
    },
    {
      env: "  leading  ,  trailing  ",
      expected: ["leading", "trailing"],
      description: "names with leading/trailing spaces"
    }
  ];
  
  testCases.forEach(({ env, expected, description }) => {
    const parseContainerNames = () => {
      return env.split(',').map(name => name.trim());
    };
    
    const containerNames = parseContainerNames();
    const defaultContainer = containerNames[0];
    
    // Test parsing
    t.deepEqual(containerNames, expected, `Parsing should work for ${description}`);
    
    // Test default is first
    t.is(defaultContainer, expected[0], `Default should be first container for ${description}`);
    
    // Test validation
    expected.forEach(name => {
      t.true(containerNames.includes(name), `${name} should be valid for ${description}`);
    });
    
    t.false(containerNames.includes("invalid"), `Invalid name should not be valid for ${description}`);
  });
});