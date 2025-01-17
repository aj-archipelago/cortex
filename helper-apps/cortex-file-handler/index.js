import { downloadFile, splitMediaFile } from './fileChunker.js';
import { saveFileToBlob, deleteBlob, deleteGCS, uploadBlob, cleanup, cleanupGCS, gcsUrlExists, ensureGCSUpload, gcs, AZURE_STORAGE_CONTAINER_NAME } from './blobHandler.js';
import { cleanupRedisFileStoreMap, getFileStoreMap, publishRequestProgress, removeFromFileStoreMap, setFileStoreMap } from './redis.js';
import { ensureEncoded, ensureFileExtension } from './helper.js';
import { moveFileToPublicFolder, deleteFolder, cleanupLocal } from './localFileHandler.js';
import { documentToText, easyChunker } from './docHelper.js';
import { DOC_EXTENSIONS, isAcceptedMimeType } from './constants.js';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import http from 'http';
import https from 'https';

const useAzure = process.env.AZURE_STORAGE_CONNECTION_STRING ? true : false;

console.log(`Storage configuration - ${useAzure ? 'Azure' : 'Local'} Storage${gcs ? ' and Google Cloud Storage' : ''}`);

let isCleanupRunning = false;
async function cleanupInactive(context) {
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
                await cleanup(context, cleanedAzure);
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
  
  try {
    // Basic URL validation
    const urlObj = new URL(url);
    if (!['http:', 'https:'].includes(urlObj.protocol)) {
      throw new Error('Invalid protocol - only HTTP and HTTPS are supported');
    }

    const httpModule = urlObj.protocol === 'https:' ? https : http;
    
    return new Promise((resolve) => {
      const request = httpModule.request(url, { method: 'HEAD' }, function(response) {
        if (response.statusCode >= 200 && response.statusCode < 400) {
          const contentType = response.headers['content-type'];
          const cleanContentType = contentType ? contentType.split(';')[0].trim() : '';
          // Check if the content type is one we accept
          if (cleanContentType && isAcceptedMimeType(cleanContentType)) {
            resolve({ valid: true, contentType: cleanContentType });
          } else {
            console.log(`Unsupported content type: ${contentType}`);
            resolve({ valid: false });
          }
        } else {
          resolve({ valid: false });
        }
      });
      
      request.on('error', function(err) {
        console.error('URL validation error:', err.message);
        resolve({ valid: false });
      });
      
      request.end();
    });
  } catch (error) {
    console.error('URL validation error:', error.message);
    return { valid: false };
  }
}

async function CortexFileHandler(context, req) {
    const { uri, requestId, save, hash, checkHash, clearHash, fetch, load, restore } = req.body?.params || req.query;
    const operation = save ? 'save' : 
                     checkHash ? 'checkHash' : 
                     clearHash ? 'clearHash' : 
                     fetch || load || restore ? 'remoteFile' : 
                     req.method.toLowerCase() === 'delete' || req.query.operation === 'delete' ? 'delete' :
                     uri ? (DOC_EXTENSIONS.some(ext => uri.toLowerCase().endsWith(ext)) ? 'document_processing' : 'media_chunking') : 
                     'upload';
    
    context.log(`Processing ${req.method} request - ${requestId ? `requestId: ${requestId}, ` : ''}${uri ? `uri: ${uri}, ` : ''}${hash ? `hash: ${hash}, ` : ''}operation: ${operation}`);

    cleanupInactive(context); //trigger & no need to wait for it

    // Clean up blob when request delete which means processing marked completed
    if (operation === 'delete') {
        const deleteRequestId = req.query.requestId || requestId;
        if (!deleteRequestId) {
            context.res = {
                status: 400,
                body: "Please pass a requestId on the query string"
            };
            return;
        }
        
        // Delete from Azure/Local storage
        const azureResult = useAzure ? await deleteBlob(deleteRequestId) : await deleteFolder(deleteRequestId);
        const gcsResult = [];
        if (gcs) {
            for (const blobName of azureResult) {
                gcsResult.push(...await deleteGCS(blobName));
            }
        }
        
        context.res = {
            status: 200,
            body: { body: [...azureResult, ...gcsResult] }
        };
        return;
    }

    const remoteUrl = fetch || restore || load;
    if (req.method.toLowerCase() === `get` && remoteUrl) {
        context.log(`Remote file: ${remoteUrl}`);
        let filename;  // Declare filename outside try block
        try {
            // Validate URL format and accessibility
            const urlCheck = await urlExists(remoteUrl);
            if (!urlCheck.valid) {
                context.res = {
                    status: 400,
                    body: 'Invalid or inaccessible URL'
                };
                return;
            }

            // Check if file already exists (using hash as the key)
            let exists = await getFileStoreMap(remoteUrl);
            if(exists){
                context.res = {
                    status: 200,
                    body: exists
                };
                //update redis timestamp with current time
                await setFileStoreMap(remoteUrl, exists);
                return;
            }

            // Download the file first
            const urlObj = new URL(remoteUrl);
            let originalFileName = path.basename(urlObj.pathname);
            if (!originalFileName || originalFileName === '') {
                originalFileName = urlObj.hostname;
            }
            
            // Ensure the filename has the correct extension based on content type
            originalFileName = ensureFileExtension(originalFileName, urlCheck.contentType);

            const maxLength = 200; // Set the maximum length for the filename
            let truncatedFileName = originalFileName;
            if (originalFileName.length > maxLength) {
                const extension = path.extname(originalFileName);
                const basename = path.basename(originalFileName, extension);
                truncatedFileName = basename.substring(0, maxLength - extension.length) + extension;
            }

            // Use the original-truncated file name when saving the downloaded file
            filename = path.join(os.tmpdir(), truncatedFileName);
            await downloadFile(remoteUrl, filename);
            
            // Now upload the downloaded file
            const res = await uploadBlob(context, null, !useAzure, filename, remoteUrl);

            //Update Redis (using hash as the key)
            await setFileStoreMap(remoteUrl, res);

            // Return the file URL
            context.res = {
                status: 200,
                body: res,
            };
        } catch (error) {
            context.log("Error processing remote file request:", error);
            context.res = {
                status: 500,
                body: `Error processing file: ${error.message}`
            };
        } finally {
            // Cleanup temp file if it exists
            try {
                if (filename && fs.existsSync(filename)) {
                    fs.unlinkSync(filename);
                }
            } catch (err) {
                context.log("Error cleaning up temp file:", err);
            }
        }
        return;
    }

    if(hash && clearHash){
        try {
            const hashValue = await getFileStoreMap(hash);
            if (hashValue) {
                await removeFromFileStoreMap(hash);
                context.res = {
                    status: 200,
                    body: `Hash ${hash} removed`
                };
            } else {
                context.res = {
                    status: 404,
                    body: `Hash ${hash} not found`
                };
            }
        } catch (error) {
            context.res = {
                status: 500,
                body: `Error occurred during hash cleanup: ${error}`
            };
            console.log('Error occurred during hash cleanup:', error);
        }
        return;
    }

    if(hash && checkHash){ //check if hash exists
        let hashResult = await getFileStoreMap(hash);

        if(hashResult){
            context.log(`File exists in map: ${hash}`);
            const exists = await urlExists(hashResult?.url);

            if(!exists.valid){
                context.log(`File is not in storage. Removing from map: ${hash}`);
                await removeFromFileStoreMap(hash);
                context.res = {
                    status: 404,
                    body: `Hash ${hash} not found`
                };
                return;
            }

            if (gcs) {
                const gcsExists = await gcsUrlExists(hashResult?.gcs);
                if(!gcsExists){
                    hashResult = await ensureGCSUpload(context, hashResult);
                }
            }

            //update redis timestamp with current time
            await setFileStoreMap(hash, hashResult);

            context.res = {
                status: 200,
                body: hashResult
            };
            return;
        }

        context.res = {
            status: 404,
            body: `Hash ${hash} not found`
        };
        return;
    }

    if (req.method.toLowerCase() === `post`) {
        await uploadBlob(context, req, !useAzure, null, hash);
        if(hash && context?.res?.body){ 
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

    const result = [];

    const sendProgress = async (data = null) => {
        completedCount++;
        const progress = completedCount / totalCount;
        await publishRequestProgress({ requestId, progress, completedCount, totalCount, numberOfChunks, data });
    }

    try {
        // Parse URL and get pathname without query parameters for extension check
        const urlObj = new URL(uri);
        const pathWithoutQuery = urlObj.pathname;
        
        if (DOC_EXTENSIONS.some(ext => pathWithoutQuery.toLowerCase().endsWith(ext))) {
            const extension = path.extname(pathWithoutQuery).toLowerCase();
            const tempDir = path.join(os.tmpdir(), `${uuidv4()}`);
            fs.mkdirSync(tempDir);
            const downloadedFile = path.join(tempDir, `${uuidv4()}${extension}`);
            await downloadFile(uri, downloadedFile);
            const text = await documentToText(downloadedFile);
            let tmpPath;

            try {
                if (save) {
                    const fileName = `${uuidv4()}.txt`; // generate unique file name
                    const filePath = path.join(tempDir, fileName);
                    tmpPath = filePath;
                    fs.writeFileSync(filePath, text); // write text to file
            
                    // save file to the cloud or local file system
                    const saveResult = useAzure ? await saveFileToBlob(filePath, requestId) : await moveFileToPublicFolder(filePath, requestId);
                    result.push(saveResult);

                } else {
                    result.push(...easyChunker(text));
                }
            } catch(err) {
                console.log(`Error saving file ${uri} with request id ${requestId}:`, err);
            } finally {
                try {
                    // delete temporary files
                    tmpPath && fs.unlinkSync(tmpPath);
                    downloadedFile && fs.unlinkSync(downloadedFile);
                    console.log(`Cleaned temp files ${tmpPath}, ${downloadedFile}`);
                } catch(err) {
                    console.log(`Error cleaning temp files ${tmpPath}, ${downloadedFile}:`, err);
                }
                
                try {
                    //delete uploaded prev nontext file
                    //check cleanup for uploaded files url
                    const regex = new RegExp(`${AZURE_STORAGE_CONTAINER_NAME}/([a-z0-9-]+)`);
                    const match = uri.match(regex);
                    if (match && match[1]) {
                        const extractedValue = match[1];
                        useAzure ? await deleteBlob(extractedValue) : await deleteFolder(extractedValue);
                        console.log(`Cleaned temp file ${uri} with request id ${extractedValue}`);
                    }
                } catch(err) {
                    console.log(`Error cleaning temp file ${uri}:`, err);
                }
            }
        } else {
            const { chunkPromises, chunkOffsets, uniqueOutputPath } = await splitMediaFile(file);

            numberOfChunks = chunkPromises.length; // for progress reporting
            totalCount += chunkPromises.length * 4; // 4 steps for each chunk (download and upload)

            // sequential download of chunks
            const chunks = [];
            for (const chunkPromise of chunkPromises) {
                const chunkPath = await chunkPromise;
                chunks.push(chunkPath);
                await sendProgress();
            }

            // sequential processing of chunks
            for (let index = 0; index < chunks.length; index++) {
                const chunkPath = chunks[index];
                const blobName = useAzure ? await saveFileToBlob(chunkPath, requestId) : await moveFileToPublicFolder(chunkPath, requestId);
                const chunkOffset = chunkOffsets[index];
                result.push({ uri: blobName, offset: chunkOffset });
                console.log(`Saved chunk as: ${blobName}`);
                await sendProgress();
            }

            // Cleanup the temp directory
            try {
                if (uniqueOutputPath && fs.existsSync(uniqueOutputPath)) {
                    fs.rmSync(uniqueOutputPath, { recursive: true });
                    console.log(`Cleaned temp directory: ${uniqueOutputPath}`);
                }
            } catch (err) {
                console.log(`Error cleaning temp directory ${uniqueOutputPath}:`, err);
            }
        }
    } catch (error) {
        console.error("An error occurred:", error);
        context.res = {
            status: 500,
            body: error.message || error
        };
        return;
    }

    console.log('result:', result.map(item =>
        typeof item === 'object' ? JSON.stringify(item, null, 2) : item
    ).join('\n'));
    
    context.res = {
        body: result
    };
}

export default CortexFileHandler;