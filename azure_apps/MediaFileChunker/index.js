const { isValidYoutubeUrl, processYoutubeUrl, splitMediaFile, deleteTempPath } = require("./fileChunker");
const { saveFileToBlob, deleteBlob } = require("./blobHandler");

async function main(context, req) {
    context.log('Starting req processing..');

    // Clean up blob when request delete which means processing marked completed
    if (req.method.toLowerCase() === `delete`) {
        const { requestId } = req.query;
        const result = await deleteBlob(requestId);
        context.res = {
            body: result
        };
        return;
    }

    const { uri, requestId } = req.body?.params || req.query;
    if (!uri || !requestId) {
        context.res = {
            status: 400,
            body: "Please pass a uri and requestId on the query string or in the request body"
        };
        return;
    }

    let file = uri;
    let folder;
    const isYoutubeUrl = isValidYoutubeUrl(uri);

    const result = [];

    try {
        if (isYoutubeUrl) {
            file = await processYoutubeUrl(file);
        }

        const { chunkPromises, uniqueOutputPath } = await splitMediaFile(file);
        folder = uniqueOutputPath;

        // sequential download of chunks
        const chunks = [];
        for (const chunkPromise of chunkPromises) {
            chunks.push(await chunkPromise);
        }

        // sequential processing of chunks
        for (const chunk of chunks) {
            const blobName = await saveFileToBlob(chunk, requestId);
            result.push(blobName);
            context.log(`Chunk saved to Azure Blob Storage as: ${blobName}`);
        }

        // parallel processing, dropped 
        // result = await Promise.all(mediaSplit.chunks.map(processChunk));

    } catch (error) {
        console.error("An error occurred:", error);
    } finally {
        try {
            isYoutubeUrl && (await deleteTempPath(file));
            folder && (await deleteTempPath(folder));
        } catch (error) {
            console.error("An error occurred while deleting:", error);
        }
    }


    console.log(`result: ${result}`);

    context.res = {
        // status: 200, /* Defaults to 200 */
        body: result
    };
}

// main(console, { query: { uri: "https://www.youtube.com/watch?v=QH2-TGUlwu4" } });

module.exports = main;