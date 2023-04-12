// openAiWhisperPlugin.js
import ModelPlugin from './modelPlugin.js';
import FormData from 'form-data';
import fs from 'fs';
import pubsub from '../pubsub.js';
import { splitMediaFile, isValidYoutubeUrl, processYoutubeUrl, deleteTempPath } from '../../azure_apps/MediaFileChunker/fileChunker.js';
import { axios } from '../../lib/request.js';
import https from 'https';
import stream from 'stream';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { PassThrough } from 'stream';
import { config } from '../../config.js';

const API_URL = config.get('whisperMediaApiUrl');

function generateUniqueFilename(extension) {
    return `${uuidv4()}.${extension}`;
}

function downloadFile(uri) {
    return new Promise((resolve, reject) => {
        https.get(uri, (res) => {
            const fileExtension = path.extname(uri).slice(1);
            const uniqueFilename = generateUniqueFilename(fileExtension);
            const tempDir = os.tmpdir();
            const localFilePath = `${tempDir}/${uniqueFilename}`;

            const writeStream = fs.createWriteStream(localFilePath);
            res.pipe(writeStream);

            writeStream.on('finish', () => {
                console.log(`Finished downloading file to ${localFilePath}`);
                resolve(localFilePath);
            });

            writeStream.on('error', (err) => {
                console.error(`Error occurred while downloading file:`, err);
                reject(err);
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}



function getPassThroughStreamFromRemoteFile(remoteUrl) {
    return new Promise((resolve, reject) => {
        // Obtain the remote file as a readable stream
        https.get(remoteUrl, (fileStream) => {
            // Initialize a PassThrough stream to pipe the file data
            const passThroughStream = new PassThrough();

            // Pipe the remote file stream to the PassThrough stream
            fileStream.pipe(passThroughStream);

            // Wait for the stream to finish piping before resolving the Promise
            finished(passThroughStream, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(passThroughStream);
                }
            });
        }).on('error', (err) => {
            reject(err);
        });
    });
}


class OpenAIWhisperPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    async getMediaChunks(file, requestId) {
        try {
            if (API_URL) {
                //call helper api and get list of file uris
                const res = await axios.get(API_URL, { params: { uri: file, requestId } });
                return res.data;
            } else {
                console.log(`No API_URL set, returning file as chunk`);
                return [file];
            }
        } catch (err) {
            console.log(`Error getting media chunks list from api:`, err);
        }
    }

    async markCompletedForCleanUp(requestId) {
        if (API_URL) {
            //call helper api to mark processing as completed
            const res = await axios.delete(API_URL, { params: { requestId } });
            console.log(`Marked request ${requestId} as completed:`, res.data);
            return res.data;
        }
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl(text);
        const params = {};
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

        const processChunk = async (chunk) => {
            try {
                const formData = new FormData();
                formData.append('file', fs.createReadStream(chunk));
                formData.append('model', this.model.params.model);
                formData.append('response_format', 'text');
                // formData.append('language', 'tr');
                modelPromptText && formData.append('prompt', modelPromptText);

                return this.executeRequest(url, formData, params, { ...this.model.headers, ...formData.getHeaders() });
            } catch (err) {
                console.log(err);
            }
        }

        let result = ``;
        let { file } = parameters;
        let folder;
        const isYoutubeUrl = isValidYoutubeUrl(file);
        let totalCount = 0;
        let completedCount = 0;
        const { requestId } = pathwayResolver;

        const sendProgress = () => {
            completedCount++;
            if(completedCount >= totalCount) return;
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    progress: completedCount / totalCount,
                    data: null,
                }
            });
        }

        let chunks = []; // array of local file paths
        try {
            // if (isYoutubeUrl) {
            //     // totalCount += 1; // extra 1 step for youtube download
            //     file = await processYoutubeUrl(file);
            // }

            // const { chunkPromises, uniqueOutputPath } = await splitMediaFile(file);
            // folder = uniqueOutputPath;
            // totalCount += chunkPromises.length * 2; // 2 steps for each chunk (download and upload)
            // // isYoutubeUrl && sendProgress(); // send progress for youtube download after total count is calculated


            const uris = await this.getMediaChunks(file, requestId); // array of remote file uris
            totalCount = uris.length * 4; // 4 steps for each chunk (download and upload)
            API_URL && (completedCount = uris.length); // api progress is already calculated

            // sequential download of chunks
            for (const uri of uris) {
                chunks.push(await downloadFile(uri));
                sendProgress();
            }


            // sequential processing of chunks
            for (const chunk of chunks) {
                result += await processChunk(chunk);
                sendProgress();
            }

            // parallel processing, dropped 
            // result = await Promise.all(mediaSplit.chunks.map(processChunk));

        } catch (error) {
            console.error("An error occurred:", error);
        }
        finally {
            // isYoutubeUrl && (await deleteTempPath(file));
            // folder && (await deleteTempPath(folder));
            try {
                for (const chunk of chunks) {
                    await deleteTempPath(chunk);
                }

                await this.markCompletedForCleanUp(requestId);
            } catch (error) {
                console.error("An error occurred while deleting:", error);
            }
        }
        return result;
    }
}

export default OpenAIWhisperPlugin;

