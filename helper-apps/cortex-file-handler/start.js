import CortexFileHandler from "./index.js";
import express from "express";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';
import { readFileSync } from 'fs';

import { publicIpv4 } from 'public-ip';
const ipAddress = await publicIpv4();

const app = express();
const port = process.env.PORT || 7071;
const publicFolder = join(dirname(fileURLToPath(import.meta.url)), 'files');

// Get version from package.json
const packageJson = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'));
const version = packageJson.version;

app.use(cors());
// Serve static files from the public folder
app.use('/files', express.static(publicFolder));

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        version: version
    });
});

// New primary endpoint
app.all('/api/CortexFileHandler', async (req, res) => {
    const context = { req, res, log: console.log }
    try {
        await CortexFileHandler(context, req);
        context.log(context.res);
        res.status(context.res.status || 200).send(context.res.body);
    } catch (error) {
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        res.status(status).send(message);
    }
});

// Legacy endpoint for compatibility
app.all('/api/MediaFileChunker', async (req, res) => {
    const context = { req, res, log: console.log }
    try {
        await CortexFileHandler(context, req);
        context.log(context.res);
        res.status(context.res.status || 200).send(context.res.body);
    } catch (error) {
        const status = error.status || 500;
        const message = error.message || 'Internal server error';
        res.status(status).send(message);
    }
});

app.listen(port, () => {
    console.log(`Cortex File Handler v${version} running on port ${port} (includes legacy MediaFileChunker endpoint)`);
});

export { port, publicFolder, ipAddress };