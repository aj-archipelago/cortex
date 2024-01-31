// openAiWhisperPlugin.js
import ModelPlugin from './modelPlugin.js';
import FormData from 'form-data';
import fs from 'fs';
import { axios } from '../../lib/request.js';
import stream from 'stream';
import os from 'os';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../../config.js';
import { deleteTempPath } from '../../helper_apps/CortexFileHandler/helper.js';
import http from 'http';
import https from 'https';
import { promisify } from 'util';
import subsrt from 'subsrt';
import { publishRequestProgress } from '../../lib/redisSubscription.js';
import logger from '../../lib/logger.js';

const pipeline = promisify(stream.pipeline);

const API_URL = config.get('whisperMediaApiUrl');
const WHISPER_TS_API_URL  = config.get('whisperTSApiUrl');

const OFFSET_CHUNK = 1000 * 60 * 10; // 10 minutes for each chunk

function alignSubtitles(subtitles, format) {
    const result = [];

    function preprocessStr(str) {
        return str.trim().replace(/(\n\n)(?!\n)/g, '\n\n\n');
    }

    function shiftSubtitles(subtitle, shiftOffset) {
        const captions = subsrt.parse(preprocessStr(subtitle));
        const resynced = subsrt.resync(captions, { offset: shiftOffset });
        return resynced;
    }

    for (let i = 0; i < subtitles.length; i++) {
        result.push(...shiftSubtitles(subtitles[i], i * OFFSET_CHUNK));
    }
    
    try {
        //if content has needed html style tags, keep them
        for(const obj of result) {
            if(obj && obj.content){ 
                obj.text = obj.content;
            }
        }
    } catch (error) {
        logger.error(`An error occurred in content text parsing: ${error}`);
    }
    
    return subsrt.build(result, { format: format === 'vtt' ? 'vtt' : 'srt' });
}

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
            const parsedUrl = new URL(fileUrl);
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
            logger.info(`Downloaded file to ${localFilePath}`);
            resolve(localFilePath);
        } catch (error) {
            fs.unlink(localFilePath, () => {
                reject(error);
            });
            //throw error;
        }
    });
};

class OpenAIWhisperPlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    async getMediaChunks(file, requestId) {
        try {
            if (API_URL) {
                //call helper api and get list of file uris
                const res = await axios.get(API_URL, { params: { uri: file, requestId } });
                return res.data;
            } else {
                logger.info(`No API_URL set, returning file as chunk`);
                return [file];
            }
        } catch (err) {
            logger.error(`Error getting media chunks list from api:`, err);
            throw err;
        }
    }

    async markCompletedForCleanUp(requestId) {
        try {
            if (API_URL) {
                //call helper api to mark processing as completed
                const res = await axios.delete(API_URL, { params: { requestId } });
                logger.info(`Marked request ${requestId} as completed: ${res.data}`);
                return res.data;
            }
        } catch (err) {
            logger.error(`Error marking request ${requestId} as completed: ${err}`);
        }
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt, pathwayResolver) {
        const { responseFormat,wordTimestamped,highlightWords,maxLineWidth,maxLineCount,maxWordsPerLine } = parameters;
        const url = this.requestUrl(text);
        const params = {};
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

        const processTS = async (uri) => {
            if (wordTimestamped) {
                if (!WHISPER_TS_API_URL) {
                    throw new Error(`WHISPER_TS_API_URL not set for word timestamped processing`);
                }

                try {
                    const tsparams = { fileurl:uri };
                    if(highlightWords) tsparams.highlight_words = highlightWords ? "True" : "False";
                    if(maxLineWidth) tsparams.max_line_width = maxLineWidth;
                    if(maxLineCount) tsparams.max_line_count = maxLineCount;
                    if(maxWordsPerLine) tsparams.max_words_per_line = maxWordsPerLine;
                    if(wordTimestamped!=null) tsparams.word_timestamps = wordTimestamped;

                    const res = await this.executeRequest(WHISPER_TS_API_URL, tsparams, {}, {}, {}, requestId, pathway);
                    return res;
                } catch (err) {
                    logger.error(`Error getting word timestamped data from api: ${err}`);
                    throw err;
                }
            }
        }

        const processChunk = async (chunk) => {
            try {
                const { language, responseFormat } = parameters;
                const response_format = responseFormat || 'text';

                const formData = new FormData();
                formData.append('file', fs.createReadStream(chunk));
                formData.append('model', this.model.params.model);
                formData.append('response_format', response_format);
                language && formData.append('language', language);
                modelPromptText && formData.append('prompt', modelPromptText);

                return this.executeRequest(url, formData, params, { ...this.model.headers, ...formData.getHeaders() }, {}, requestId, pathway);
            } catch (err) {
                logger.error(err);
                throw err;
            }
        }

        let result = [];
        let { file } = parameters;
        let totalCount = 0;
        let completedCount = 0;
        const { requestId, pathway } = pathwayResolver;

        const sendProgress = () => {
            completedCount++;
            if (completedCount >= totalCount) return;
            publishRequestProgress({
                    requestId,
                    progress: completedCount / totalCount,
                    data: null,
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
                if (wordTimestamped) { // get word timestamped data 
                    sendProgress(); // no download needed auto progress 
                    const ts = await processTS(uri);
                    result.push(ts);
                } else {
                    chunks.push(await downloadFile(uri));
                }
                sendProgress();
            }


            // sequential processing of chunks
            for (const chunk of chunks) {
                result.push(await processChunk(chunk));
                sendProgress();
            }

            // parallel processing, dropped 
            // result = await Promise.all(mediaSplit.chunks.map(processChunk));

        } catch (error) {
            const errMsg = `Transcribe error: ${error?.message || JSON.stringify(error)}`;
            logger.error(errMsg);
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
                    logger.info(`Cleaned temp whisper file ${file} with request id ${extractedValue}`);
                }

            } catch (error) {
                logger.error(`An error occurred while deleting: ${error}`);
            }
        }

        if (['srt','vtt'].includes(responseFormat) || wordTimestamped) { // align subtitles for formats
            return alignSubtitles(result, responseFormat);
        }
        return result.join(` `);
    }
}

export default OpenAIWhisperPlugin;

