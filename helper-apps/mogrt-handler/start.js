import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerSpec from './swagger.js';
import MogrtHandler from './index.js';
import GlossaryHandler from './glossaryHandler.js';

const app = express();
const port = process.env.PORT || 7072; // Using 7072 to avoid conflict with file-handler

// Middleware
app.use(cors());

// Only parse JSON and URL-encoded bodies for non-multipart requests
app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
        next();
    } else {
        express.json()(req, res, next);
    }
});

app.use((req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
        next();
    } else {
        express.urlencoded({ extended: true })(req, res, next);
    }
});

// Swagger UI setup
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        version: process.env.npm_package_version
    });
});

// Main endpoint for MOGRT handling
app.all('/api/MogrtHandler', async (req, res) => {
    const context = { 
        req, 
        res, 
        log: console.log 
    };

    try {
        await MogrtHandler(context, req);
        res.status(context.res.status || 200).send(context.res.body);
    } catch (error) {
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        res.status(status).send({ error: message });
    }
});

// Endpoint for MOGRT operations with ID (DELETE)
app.all('/api/MogrtHandler/:id', async (req, res) => {
    const context = { 
        req, 
        res, 
        log: console.log 
    };

    try {
        // Set params to make the ID available in the handler
        req.params = req.params || {};
        await MogrtHandler(context, req);
        res.status(context.res.status || 200).send(context.res.body);
    } catch (error) {
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        res.status(status).send({ error: message });
    }
});

// New endpoint for Glossary handling
app.all('/api/glossary/*', async (req, res) => {
    const context = { req, res, log: console.log };
    try {
        await GlossaryHandler(context, req);
        res.status(context.res.status || 200).send(context.res.body);
    } catch (error) {
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        res.status(status).send({ error: message });
    }
});

app.listen(port, () => {
    console.log(`MOGRT Handler running on port ${port} => http://localhost:${port}`);
});
