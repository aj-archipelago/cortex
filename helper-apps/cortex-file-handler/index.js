import { downloadFile, processYoutubeUrl, splitMediaFile } from './fileChunker.js';
import { saveFileToBlob, deleteBlob, uploadBlob, cleanup, cleanupGCS } from './blobHandler.js';
import { cleanupRedisFileStoreMap, getFileStoreMap, publishRequestProgress, removeFromFileStoreMap, setFileStoreMap } from './redis.js';
import { deleteTempPath, ensureEncoded, isValidYoutubeUrl } from './helper.js';
import { moveFileToPublicFolder, deleteFolder, cleanupLocal } from './localFileHandler.js';
import { documentToText, easyChunker } from './docHelper.js';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import http from 'http';
import https from 'https';

const DOC_EXTENSIONS =  [".txt", ".json", ".csv", ".md", ".xml", ".js", ".html", ".css", '.pdf', '.docx', '.xlsx', '.csv'];

const useAzure = process.env.AZURE_STORAGE_CONNECTION_STRING ? true : false;
console.log(useAzure ? 'Using Azure Storage' : 'Using local file system');


let isCleanupRunning = false;
async function cleanupInactive(useAzure) {
    try {
        let cleanedUrls = [];
        if (isCleanupRunning) { return; } //no need to cleanup every call
        isCleanupRunning = true;
        try {
            if (useAzure) {
                const c =  await cleanup();
                cleanedUrls.push(...c);
            } else {
                const c = await cleanupLocal();
                cleanedUrls.push(...c);
            }
        } catch (error) {
            console.log('Error occurred during cleanup:', error);
        }


        try{
            const c = await cleanupGCS();
            cleanedUrls.push(...c);
        }catch(err){
            console.log('Error occurred during GCS cleanup:', err);
        }

        await cleanupRedisFileStoreMap(cleanedUrls);
         
    } catch (error) {
        console.log('Error occurred during cleanup:', error);
    } finally{
        isCleanupRunning = false;
    }
}

async function urlExists(url) {
  if(!url) return false;
  const httpModule = url.startsWith('https') ? https : http;
  
  return new Promise((resolve) => {
    httpModule
      .get(url, function (response) {
        // Check if the response status is OK
        resolve(response.statusCode === 200);
      })
      .on('error', function () {
        resolve(false);
      });
  });
}

  
async function main(context, req) {
    context.log('Starting req processing..');

    cleanupInactive(useAzure); //trigger & no need to wait for it

    // Clean up blob when request delete which means processing marked completed
    if (req.method.toLowerCase() === `delete`) {
        const { requestId } = req.query;
        if (!requestId) {
            context.res = {
                status: 400,
                body: "Please pass a requestId on the query string"
            };
            return;
        }
        const result = useAzure ? await deleteBlob(requestId) : await deleteFolder(requestId);
        context.res = {
            body: result
        };
        return;
    }

    const { uri, requestId, save, hash, checkHash } = req.body?.params || req.query;

    if(hash && checkHash){ //check if hash exists
        context.log(`Checking hash: ${hash}`);
        const result = await getFileStoreMap(hash);

        const exists = await urlExists(result?.url);

        if(!exists){
            await removeFromFileStoreMap(hash);
            return;
        }

        if(result){
            context.log(`Hash exists: ${hash}`);
        }
        context.res = {
            body: result
        };
        return;
    }

    if (req.method.toLowerCase() === `post`) {
        const { useGoogle } = req.body?.params || req.query;
        const { url } = await uploadBlob(context, req, !useAzure, useGoogle);
        context.log(`File url: ${url}`);
        if(hash && context?.res?.body){ //save hash after upload
            await setFileStoreMap(hash, context.res.body);
        }
        return
    }

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

    let file = ensureEncoded(uri); // encode url to handle special characters
    let folder;
    const isYoutubeUrl = isValidYoutubeUrl(uri);

    const result = [];

    const sendProgress = async (data = null) => {
        completedCount++;
        const progress = completedCount / totalCount;
        await publishRequestProgress({ requestId, progress, completedCount, totalCount, numberOfChunks, data });
    }

    const isDocument = DOC_EXTENSIONS.some(ext => uri.toLowerCase().endsWith(ext));

    try {
        if (isDocument) {
            const extension = path.extname(uri).toLowerCase();
            const file = path.join(os.tmpdir(), `${uuidv4()}${extension}`);
            await downloadFile(uri, file)
            const text = await documentToText(file);
            let tmpPath;

            try{
                if (save) {
                    const fileName = `${uuidv4()}.txt`; // generate unique file name
                    const filePath = path.join(os.tmpdir(), fileName);
                    tmpPath = filePath;
                    fs.writeFileSync(filePath, text); // write text to file
            
                    // save file to the cloud or local file system
                    const saveResult = useAzure ? await saveFileToBlob(filePath, requestId) : await moveFileToPublicFolder(filePath, requestId);
                    result.push(saveResult);

                } else {
                    result.push(...easyChunker(text));
                }
            }catch(err){
                console.log(`Error saving file ${uri} with request id ${requestId}:`, err);
            }finally{
                try{
                    // delete temporary files
                    tmpPath && fs.unlinkSync(tmpPath);
                    file && fs.unlinkSync(file);
                    console.log(`Cleaned temp files ${tmpPath}, ${file}`);
                }catch(err){
                    console.log(`Error cleaning temp files ${tmpPath}, ${file}:`, err);
                }
                
                try{
                    //delete uploaded prev nontext file
                    //check cleanup for whisper temp uploaded files url
                    const regex = /whispertempfiles\/([a-z0-9-]+)/;
                    const match = uri.match(regex);
                    if (match && match[1]) {
                        const extractedValue = match[1];
                        useAzure ? await deleteBlob(extractedValue) : await deleteFolder(extractedValue);
                        console.log(`Cleaned temp file ${uri} with request id ${extractedValue}`);
                    }
                }catch(err){
                    console.log(`Error cleaning temp file ${uri}:`, err);
                }
            }
        }else{

            if (isYoutubeUrl) {
                // totalCount += 1; // extra 1 step for youtube download
                file = await processYoutubeUrl(file);
            }

            const { chunkPromises, chunkOffsets, uniqueOutputPath } = await splitMediaFile(file);
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
            for (let index = 0; index < chunks.length; index++) {
                const chunk = chunks[index];
                const blobName = useAzure ? await saveFileToBlob(chunk, requestId) : await moveFileToPublicFolder(chunk, requestId);
                const chunkOffset = chunkOffsets[index];
                result.push({ uri:blobName, offset:chunkOffset });
                context.log(`Saved chunk as: ${blobName}`);
                sendProgress();
            }

            // parallel processing, dropped 
            // result = await Promise.all(mediaSplit.chunks.map(processChunk));
        }
    } catch (error) {
        console.error("An error occurred:", error);
        context.res.status(500);
        context.res.body = error.message || error;
        return;
    } finally {
        try {
            (isYoutubeUrl) && (await deleteTempPath(file));
            folder && (await deleteTempPath(folder));
        } catch (error) {
            console.error("An error occurred while deleting:", error);
        }
    }

    console.log('result:', result.map(item =>
        typeof item === 'object' ? JSON.stringify(item, null, 2) : item
    ).join('\n'));
    
    context.res = {
        body: result
    };

}


export default main;