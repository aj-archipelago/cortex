import MediaFileChunker from "./index.js";
import express from "express";
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { publicIpv4 } from 'public-ip';
const ipAddress = await publicIpv4();

const app = express();
const port = process.env.PORT || 7071;
const publicFolder = join(dirname(fileURLToPath(import.meta.url)), 'files');


// Serve static files from the public folder
app.use('/files', express.static(publicFolder));

app.all('/api/MediaFileChunker', async (req, res) => {
    const context = { req, res, log: console.log }
    await MediaFileChunker(context, req);
    res.send(context.res.body);
});

app.listen(port, () => {
    console.log(`MediaFileChunker helper running on port ${port}`);
});

export { port, publicFolder, ipAddress };