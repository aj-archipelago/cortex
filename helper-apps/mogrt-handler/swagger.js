import swaggerJsdoc from 'swagger-jsdoc';

const options = {
  definition: {
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
  },
  // Path patterns to API route files
  apis: ['./routes/*.js', './index.js', './*.js'],
};

const swaggerSpec = swaggerJsdoc(options);

export default swaggerSpec;
