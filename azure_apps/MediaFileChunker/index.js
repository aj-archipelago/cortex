const { isValidYoutubeUrl, processYoutubeUrl, splitMediaFile, deleteTempPath } = require("./fileChunker");
const { saveFileToBlob } = require("./blobHandler");


module.exports = async function (context, req) {
    context.log('JavaScript HTTP trigger function processed a request.');

    const uri = (req.query.uri || (req.body && req.body.uri));
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
            const blobName = await saveFileToBlob(chunk);
            result.push(blobName);
            context.log(`Chunk saved to Azure Blob Storage as: ${blobName}`);
        }

        // parallel processing, dropped 
        // result = await Promise.all(mediaSplit.chunks.map(processChunk));

    } catch (error) {
        console.error("An error occurred:", error);
    } finally {
        isYoutubeUrl && (await deleteTempPath(file));
        folder && (await deleteTempPath(folder));
    }



    context.res = {
        // status: 200, /* Defaults to 200 */
        body: result
    };
}