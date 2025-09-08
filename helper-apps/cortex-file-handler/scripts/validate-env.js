#!/usr/bin/env node

/**
 * Environment Variable Validation Script
 * 
 * This script validates that all required environment variables are present
 * and properly configured before running tests. It fails fast if any critical
 * environment variables are missing or misconfigured.
 */

import { existsSync } from 'fs';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Required environment variables for Azure tests
const REQUIRED_ENV_VARS = {
  NODE_ENV: {
    required: true,
    expectedValue: 'test',
    description: 'Must be set to "test" for test environment'
  },
  AZURE_STORAGE_CONNECTION_STRING: {
    required: true,
    expectedValue: 'UseDevelopmentStorage=true',
    description: 'Must be set to use Azurite development storage'
  },
  AZURE_STORAGE_CONTAINER_NAME: {
    required: true,
    description: 'Must specify container names (comma-separated for multiple)'
  },
  REDIS_CONNECTION_STRING: {
    required: false,
    description: 'Redis connection string (optional for tests)'
  },
  PORT: {
    required: false,
    description: 'Port for test server'
  }
};

// Validate environment variables
function validateEnvironment() {
  console.log('🔍 Validating environment variables for Azure tests...\n');
  
  let hasErrors = false;
  const errors = [];
  const warnings = [];

  // Check if .env.test.azure exists
  if (!existsSync('.env.test.azure')) {
    errors.push('❌ .env.test.azure file not found');
    hasErrors = true;
  } else {
    console.log('✅ .env.test.azure file found');
  }

  // Validate each required environment variable
  for (const [varName, config] of Object.entries(REQUIRED_ENV_VARS)) {
    const value = process.env[varName];
    
    if (config.required && (!value || value.trim() === '')) {
      errors.push(`❌ Missing required environment variable: ${varName}`);
      if (config.description) {
        errors.push(`   Description: ${config.description}`);
      }
      hasErrors = true;
    } else if (config.expectedValue && value !== config.expectedValue) {
      errors.push(`❌ Invalid value for ${varName}: "${value}"`);
      errors.push(`   Expected: "${config.expectedValue}"`);
      errors.push(`   Description: ${config.description}`);
      hasErrors = true;
    } else if (value) {
      console.log(`✅ ${varName}: ${value}`);
    } else if (!config.required) {
      warnings.push(`⚠️  Optional variable ${varName} not set`);
    }
  }

  // Validate container names format
  const containerNames = process.env.AZURE_STORAGE_CONTAINER_NAME;
  if (containerNames) {
    const containers = containerNames.split(',').map(name => name.trim());
    console.log(`✅ Container names: ${containers.join(', ')}`);
    
    // Check for common test containers that might be missing
    const commonTestContainers = ['test1', 'test2', 'test3', 'container1', 'container2', 'container3', 'test-container'];
    const missingContainers = commonTestContainers.filter(container => !containers.includes(container));
    
    if (missingContainers.length > 0) {
      warnings.push(`⚠️  Some test containers might be missing: ${missingContainers.join(', ')}`);
      warnings.push(`   Consider adding them to AZURE_STORAGE_CONTAINER_NAME if tests fail`);
    }
  }

  // Check if Azurite is available
  try {
    execSync('which azurite', { stdio: 'ignore' });
    console.log('✅ Azurite is installed and available');
  } catch (error) {
    errors.push('❌ Azurite is not installed or not in PATH');
    errors.push('   Install with: npm install -g azurite');
    hasErrors = true;
  }

  // Print warnings
  if (warnings.length > 0) {
    console.log('\n⚠️  Warnings:');
    warnings.forEach(warning => console.log(warning));
  }

  // Print errors and exit if any
  if (hasErrors) {
    console.log('\n❌ Environment validation failed:');
    errors.forEach(error => console.log(error));
    console.log('\n💡 To fix these issues:');
    console.log('1. Ensure .env.test.azure exists and contains all required variables');
    console.log('2. Install Azurite: npm install -g azurite');
    console.log('3. Check that DOTENV_CONFIG_PATH=.env.test.azure is set when running tests');
    process.exit(1);
  }

  console.log('\n✅ Environment validation passed! Ready to run Azure tests.');
  return true;
}

// Run validation if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    validateEnvironment();
  } catch (error) {
    console.error('❌ Environment validation failed:', error.message);
    process.exit(1);
  }
}

export { validateEnvironment };