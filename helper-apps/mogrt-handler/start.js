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

/**
 * @swagger
 * /api/MogrtHandler:
 *   get:
 *     summary: Get MOGRT manifest
 *     parameters:
 *       - in: query
 *         name: manifestId
 *         schema:
 *           type: string
 *         description: ID of the manifest to retrieve. If not provided, returns master manifest.
 *     responses:
 *       200:
 *         description: Returns the requested manifest
 *       500:
 *         description: Server error
 *   post:
 *     summary: Upload MOGRT and preview files
 *     tags: [Files]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               mogrt:
 *                 type: string
 *                 format: binary
 *                 description: The MOGRT file to upload
 *               preview:
 *                 type: string
 *                 format: binary
 *                 description: The preview file (GIF or MP4)
 *             required:
 *               - mogrt
 *               - preview
 *               - name
 *     responses:
 *       200:
 *         description: Files uploaded successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                   description: Unique identifier for the upload
 *                 name:
 *                   type: string
 *                   description: Name of the MOGRT
 *                 mogrtUrl:
 *                   type: string
 *                   description: URL to access the uploaded MOGRT file
 *                 previewUrl:
 *                   type: string
 *                   description: URL to access the uploaded preview file
 *       400:
 *         description: Invalid request or missing files
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
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

/**
 * @swagger
 * /api/glossary/list:
 *   get:
 *     summary: List all glossaries
 *     responses:
 *       200:
 *         description: List of glossaries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 glossaries:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 *
 * /api/glossary/{langPair}:
 *   post:
 *     summary: Create a new glossary
 *     parameters:
 *       - in: path
 *         name: langPair
 *         required: true
 *         schema:
 *           type: string
 *         description: Language pair (e.g. en-es)
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Name of the glossary
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source_lang_code:
 *                 type: string
 *               target_lang_code:
 *                 type: string
 *               entries:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     source:
 *                       type: string
 *                     target:
 *                       type: string
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Glossary created
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       500:
 *         description: Server error
 *
 * /api/glossary/{id}:
 *   delete:
 *     summary: Delete a glossary by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The glossary ID
 *     responses:
 *       200:
 *         description: Glossary deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Glossary not found
 *       500:
 *         description: Server error
 *
 * /api/glossary/edit/{id}:
 *   post:
 *     summary: Edit a glossary by ID (delete and recreate)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: The glossary ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               source_lang_code:
 *                 type: string
 *               target_lang_code:
 *                 type: string
 *               entries:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     source:
 *                       type: string
 *                     target:
 *                       type: string
 *               name:
 *                 type: string
 *     responses:
 *       200:
 *         description: Glossary edited
 *       400:
 *         description: Invalid input
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Glossary not found
 *       500:
 *         description: Server error
 */
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
    console.log(`MOGRT Handler running on port ${port}`);
});
