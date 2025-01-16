import CortexFileHandler from "./index.js";
import express from "express";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import cors from 'cors';

import { publicIpv4 } from 'public-ip';
const ipAddress = await publicIpv4();

const app = express();
const port = process.env.PORT || 7071;
const publicFolder = join(dirname(fileURLToPath(import.meta.url)), 'files');

app.use(cors());
// Serve static files from the public folder
app.use('/files', express.static(publicFolder));

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
    console.log(`Cortex File Handler running on port ${port} (includes legacy MediaFileChunker endpoint)`);
});

export { port, publicFolder, ipAddress };