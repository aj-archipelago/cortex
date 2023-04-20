// openAiWhisperPlugin.js
import ModelPlugin from './modelPlugin.js';
import FormData from 'form-data';
import fs from 'fs';
import pubsub from '../pubsub.js';
import { axios } from '../../lib/request.js';
import stream from 'stream';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config.js';
import { deleteTempPath } from '../../helper_apps/MediaFileChunker/helper.js';
import http from 'http';
import https from 'https';
import url from 'url';
import { promisify } from 'util';
const pipeline = promisify(stream.pipeline);


const API_URL = config.get('whisperMediaApiUrl');

function generateUniqueFilename(extension) {
    return `${uuidv4()}.${extension}`;
}

const downloadFile = async (fileUrl) => {
    const fileExtension = path.extname(fileUrl).slice(1);
    const uniqueFilename = generateUniqueFilename(fileExtension);
    const tempDir = os.tmpdir();
    const localFilePath = `${tempDir}/${uniqueFilename}`;

    // eslint-disable-next-line no-async-promise-executor
    return new Promise(async (resolve, reject) => {
        try {
            const parsedUrl = url.parse(fileUrl);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const response = await new Promise((resolve, reject) => {
                protocol.get(parsedUrl, (res) => {
                    if (res.statusCode === 200) {
                        resolve(res);
                    } else {
                        reject(new Error(`HTTP request failed with status code ${res.statusCode}`));
                    }
                }).on('error', reject);
            });

            await pipeline(response, fs.createWriteStream(localFilePath));
            console.log(`Downloaded file to ${localFilePath}`);
            resolve(localFilePath);
        } catch (error) {
            fs.unlink(localFilePath, () => {
                reject(error);
            });
            throw error;
        }
    });
};

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
            throw err;
        }
    }

    async markCompletedForCleanUp(requestId) {
        try {
            if (API_URL) {
                //call helper api to mark processing as completed
                const res = await axios.delete(API_URL, { params: { requestId } });
                console.log(`Marked request ${requestId} as completed:`, res.data);
                return res.data;
            }
        } catch (err) {
            console.log(`Error marking request ${requestId} as completed:`, err);
        }
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl(text);
        const params = {};
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

        const processChunk = async (chunk) => {
            try {
                const { language } = parameters;
                const formData = new FormData();
                formData.append('file', fs.createReadStream(chunk));
                formData.append('model', this.model.params.model);
                formData.append('response_format', 'text');
                language && formData.append('language', language);
                modelPromptText && formData.append('prompt', modelPromptText);

                return this.executeRequest(url, formData, params, { ...this.model.headers, ...formData.getHeaders() });
            } catch (err) {
                console.log(err);
                throw err;
            }
        }

        let result = ``;
        let { file } = parameters;
        let totalCount = 0;
        let completedCount = 0;
        const { requestId } = pathwayResolver;

        const sendProgress = () => {
            completedCount++;
            if (completedCount >= totalCount) return;
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

            const uris = await this.getMediaChunks(file, requestId); // array of remote file uris
            if (!uris || !uris.length) {
                throw new Error(`Error in getting chunks from media helper for file ${file}`);
            }
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
            const errMsg = `Transcribe error: ${error?.message || JSON.stringify(error)}`;
            console.error(errMsg);
            return errMsg;
        }
        finally {
            try {
                for (const chunk of chunks) {
                    await deleteTempPath(chunk);
                }

                await this.markCompletedForCleanUp(requestId);

                //check cleanup for whisper temp uploaded files url
                const regex = /whispertempfiles\/([a-z0-9-]+)/;
                const match = file.match(regex);
                if (match && match[1]) {
                    const extractedValue = match[1];
                    await this.markCompletedForCleanUp(extractedValue);
                    console.log(`Cleaned temp whisper file ${file} with request id ${extractedValue}`);
                }

            } catch (error) {
                console.error("An error occurred while deleting:", error);
            }
        }
        return result;
    }
}

export default OpenAIWhisperPlugin;

