import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let swaggerSpec;

try {
  // Load the YAML file
  const swaggerYaml = fs.readFileSync(path.join(__dirname, 'swagger.yaml'), 'utf8');
  
  // Parse YAML to JavaScript object
  swaggerSpec = yaml.load(swaggerYaml);
  
  // Update server URL from environment variable if present
  if (process.env.BASE_URL) {
    swaggerSpec.servers[0].url = process.env.BASE_URL;
  }
} catch (error) {
  console.error('Error loading swagger.yaml:', error);
  // Provide a fallback minimal swagger spec
  swaggerSpec = {
    openapi: '3.0.0',
    info: {
      title: 'MOGRT Handler API',
      version: '1.0.0',
      description: 'API for handling MOGRT files and preview GIFs with S3 storage',
    },
    servers: [
      {
        url: process.env.BASE_URL || 'http://localhost:7072',
        description: 'Development server',
      },
    ],
    paths: {},
  };
}

export default swaggerSpec;
