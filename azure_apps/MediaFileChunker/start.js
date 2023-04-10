import MediaFileChunker from "./index.js";
import express from "express";

const app = express();
const port = process.env.PORT || 7071;

app.all('/api/MediaFileChunker', async (req, res) => {
    const context = { req, res, log: console.log }
    await MediaFileChunker(context, req);
    res.send(context.res.body);
});

app.listen(port, () => {
    console.log(`MediaFileChunker helper running on port ${port}`);
});
