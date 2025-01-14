import { downloadFile, processYoutubeUrl, splitMediaFile } from './fileChunker.js';
import { saveFileToBlob, deleteBlob, uploadBlob, cleanup, cleanupGCS, gcsUrlExists, ensureGCSUpload } from './blobHandler.js';
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
import axios from "axios";
import { pipeline } from "stream";
import { promisify } from "util";
const pipelineUtility = promisify(pipeline); // To pipe streams using async/await

const DOC_EXTENSIONS =  [".txt", ".json", ".csv", ".md", ".xml", ".js", ".html", ".css", '.pdf', '.docx', '.xlsx', '.csv'];

const useAzure = process.env.AZURE_STORAGE_CONNECTION_STRING ? true : false;
console.log(useAzure ? 'Using Azure Storage' : 'Using local file system');


let isCleanupRunning = false;
async function cleanupInactive() {
    try {
        if (isCleanupRunning) { return; } //no need to cleanup every call
        isCleanupRunning = true;
        const cleaned = await cleanupRedisFileStoreMap();

        const cleanedAzure = [];
        const cleanedLocal = [];
        const cleanedGCS = [];

        for(const key in cleaned){
            const item = cleaned[key];
            const {url,gcs} = item;
            if(url){
                if(url.includes('.blob.core.windows.net/')){ 
                    cleanedAzure.push(url);
                }else if(url.startsWith('gs://')){
                    cleanedGCS.push(url);
                }else{
                    cleanedLocal.push(url);
                }
            }

            if(item && item.gcs){
                cleanedGCS.push(gcs);
            }
        }
        
        try {
            if (cleanedAzure && cleanedAzure.length > 0) {
                await cleanup(cleanedAzure);
            }
        } catch (error) {
            console.log('Error occurred during azure cleanup:', error);
        }

        try {
            if (cleanedLocal && cleanedLocal.length > 0) {
                await cleanupLocal(cleanedLocal);
            }
        }catch(err){
            console.log('Error occurred during local cleanup:', err);
        }

        try{
            if(cleanedGCS && cleanedGCS.length > 0){
                await cleanupGCS(cleanedGCS);
            }
        }catch(err){
            console.log('Error occurred during GCS cleanup:', err);
        }
         
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
    const request = httpModule.request(url, { method: 'HEAD' }, function(response) {
      resolve(response.statusCode === 200);
    });
    
    request.on('error', function() {
      resolve(false);
    });
    
    request.end();
  });
}

  
async function main(context, req) {
    context.log('Starting req processing..');

    cleanupInactive(); //trigger & no need to wait for it

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

    const { uri, requestId, save, hash, checkHash, clearHash, fetch, load, restore } = req.body?.params || req.query;

    const filepond = fetch || restore || load;
    if (req.method.toLowerCase() === `get` && filepond) {
        context.log(`Remote file: ${filepond}`);
        // Check if file already exists (using hash as the key)
        let exists = await getFileStoreMap(filepond);
        if(exists){
            context.res = {
                status: 200,
                body: exists
            };
            return;
        }

        // Check if it's a youtube url
        let youtubeDownloadedFile = null; 
        if(isValidYoutubeUrl(filepond)){
            youtubeDownloadedFile = await processYoutubeUrl(filepond, true);
        }
        const filename = path.join(os.tmpdir(), path.basename(youtubeDownloadedFile || filepond));
        // Download the remote file to a local/temporary location keep name & ext
        if(!youtubeDownloadedFile){
            const response = await axios.get(filepond, { responseType: "stream" });
            await pipelineUtility(response.data, fs.createWriteStream(filename));
        }

        
        const res = await uploadBlob(context, null, !useAzure, true, filename); 
        context.log(`File uploaded: ${JSON.stringify(res)}`);

        //Update Redis (using hash as the key)
        await setFileStoreMap(filepond, res);

        // Return the file URL
        context.res = {
            status: 200,
            body: res,
        };

        return;
    }

    if(hash && clearHash){
        try {
            const hashValue = await getFileStoreMap(hash);
            await removeFromFileStoreMap(hash);
            context.res = {
                status: 200,
                body: hashValue ? `Hash ${hash} removed` : `Hash ${hash} not found`
            };
        } catch (error) {
            context.res = {
                status: 500,
                body: `Error occurred during hash cleanup: ${error}`
            };
            console.log('Error occurred during hash cleanup:', error);
        }
        return
    }

    if(hash && checkHash){ //check if hash exists
        let result = await getFileStoreMap(hash);

        if(result){
            context.log(`File exists in map: ${hash}`);
            const exists = await urlExists(result?.url);

            if(!exists){
                context.log(`File is not in storage. Removing from map: ${hash}`);
                await removeFromFileStoreMap(hash);
                return;
            }

            const gcsExists = await gcsUrlExists(result?.gcs);
            if(!gcsExists){
                context.log(`GCS file may be missing. Correcting if needed: ${hash}`);
                result = await ensureGCSUpload(result, result.filename);
            }

            //update redis timestamp with current time
            await setFileStoreMap(hash, result);
        }
        context.res = {
            body: result
        };
        return;
    }

    if (req.method.toLowerCase() === `post`) {
        const { useGoogle } = req.body?.params || req.query;
        const { url } = await uploadBlob(context, req, !useAzure, useGoogle, null, hash);
        context.log(`File url: ${url}`);
        if(hash && context?.res?.body){ 
            //save hash after upload
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
                const processAsVideo = req.body?.params?.processAsVideo || req.query?.processAsVideo;
                file = await processYoutubeUrl(file, processAsVideo);
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