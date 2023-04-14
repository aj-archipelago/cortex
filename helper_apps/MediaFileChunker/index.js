import { processYoutubeUrl, splitMediaFile } from './fileChunker.js';
import { saveFileToBlob, deleteBlob, uploadBlob } from './blobHandler.js';
import { publishRequestProgress, connectClient } from './redis.js';
import { deleteTempPath, isValidYoutubeUrl } from './helper.js';
import { moveFileToPublicFolder, deleteFolder, uploadToPublicFolder } from './localFileHandler.js';

const useAzure = process.env.AZURE_STORAGE_CONNECTION_STRING ? true : false;
console.log(useAzure ? 'Using Azure Storage' : 'Using local file system');


async function main(context, req) {
    context.log('Starting req processing..');
    // await publishRequestProgress({ requestId:222, progress: 0, data: null });

    // Clean up blob when request delete which means processing marked completed
    if (req.method.toLowerCase() === `delete`) {
        const { requestId } = req.query;
        const result = useAzure ? await deleteBlob(requestId) : await deleteFolder(requestId);
        context.res = {
            body: result
        };
        return;
    }

    if (req.method.toLowerCase() === `post`) {
        const { message, url } = await uploadBlob(context, req, !useAzure);
        context.log(`File url: ${url}`);
        return
    }

    const { uri, requestId } = req.body?.params || req.query;
    if (!uri || !requestId) {
        context.res = {
            status: 400,
            body: "Please pass a uri and requestId on the query string or in the request body"
        };
        return;
    }

    let totalCount = 0;
    let completedCount = 0;
    let numberOfChunks;

    let file = uri;
    let folder;
    const isYoutubeUrl = isValidYoutubeUrl(uri);

    const result = [];

    const sendProgress = async (data = null) => {
        completedCount++;
        const progress = completedCount / totalCount;
        await publishRequestProgress({ requestId, progress, completedCount, totalCount, numberOfChunks, data });
    }

    try {
        if (isYoutubeUrl) {
            // totalCount += 1; // extra 1 step for youtube download
            file = await processYoutubeUrl(file);
        }

        const { chunkPromises, uniqueOutputPath } = await splitMediaFile(file);
        folder = uniqueOutputPath;

        numberOfChunks = chunkPromises.length; // for progress reporting
        totalCount += chunkPromises.length * 4; // 4 steps for each chunk (download and upload)
        // isYoutubeUrl && sendProgress(); // send progress for youtube download after total count is calculated

        // sequential download of chunks
        const chunks = [];
        for (const chunkPromise of chunkPromises) {
            chunks.push(await chunkPromise);
            sendProgress();
        }

        // sequential processing of chunks
        for (const chunk of chunks) {
            const blobName = useAzure ? await saveFileToBlob(chunk, requestId) : await moveFileToPublicFolder(chunk, requestId);
            result.push(blobName);
            context.log(`Saved chunk as: ${blobName}`);
            sendProgress();
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

export default main;