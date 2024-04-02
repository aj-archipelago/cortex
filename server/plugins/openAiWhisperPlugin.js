// openAiWhisperPlugin.js
import ModelPlugin from './modelPlugin.js';
import { config } from '../../config.js';
import subsrt from 'subsrt';
import FormData from 'form-data';
import fs from 'fs';
import { axios } from '../../lib/requestExecutor.js';
import stream from 'stream';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import { publishRequestProgress } from '../../lib/redisSubscription.js';
import logger from '../../lib/logger.js';
const pipeline = promisify(stream.pipeline);

const API_URL = config.get('whisperMediaApiUrl');
const WHISPER_TS_API_URL  = config.get('whisperTSApiUrl');
if(WHISPER_TS_API_URL){
    logger.info(`WHISPER API URL using ${WHISPER_TS_API_URL}`);
}else{
    logger.warn(`WHISPER API URL not set using default OpenAI API Whisper`);
}

const OFFSET_CHUNK = 1000 * 500; // 500 seconds chunk offset

async function deleteTempPath(path) {
    try {
        if (!path) {
            logger.warn('Temporary path is not defined.');
            return;
        }
        if (!fs.existsSync(path)) {
            logger.warn(`Temporary path ${path} does not exist.`);
            return;
        }
        const stats = fs.statSync(path);
        if (stats.isFile()) {
            fs.unlinkSync(path);
            logger.info(`Temporary file ${path} deleted successfully.`);
        } else if (stats.isDirectory()) {
            fs.rmSync(path, { recursive: true });
            logger.info(`Temporary folder ${path} and its contents deleted successfully.`);
        }
    } catch (err) {
        logger.error(`Error occurred while deleting the temporary path: ${err}`);
    }
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

// convert srt format to text
function convertToText(str) {
    return str
      .split('\n')
      .filter(line => !line.match(/^\d+$/) && !line.match(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/) && line !== '')
      .join(' ');
}

function alignSubtitles(subtitles, format) {
    const result = [];

    function preprocessStr(str) {
        try{
            if(!str) return '';
            return str.trim().replace(/(\n\n)(?!\n)/g, '\n\n\n');
        }catch(e){
            logger.error(`An error occurred in content text preprocessing: ${e}`);
            return '';
        }
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


class OpenAIWhisperPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
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
            logger.error(`Error getting media chunks list from api: ${err}`);
            throw err;
        }
    }

    async markCompletedForCleanUp(requestId) {
        try {
            if (API_URL) {
                //call helper api to mark processing as completed
                const res = await axios.delete(API_URL, { params: { requestId } });
                logger.info(`Marked request ${requestId} as completed:`, res.data);
                return res.data;
            }
        } catch (err) {
            logger.error(`Error marking request ${requestId} as completed: ${err}`);
        }
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt, cortexRequest) {
        const { pathwayResolver } = cortexRequest;
        const { responseFormat, wordTimestamped, highlightWords, maxLineWidth, maxLineCount, maxWordsPerLine } = parameters;
        cortexRequest.url = this.requestUrl(text);

        const chunks = [];
        const processChunk = async (uri) => {
            try {
                const chunk = await downloadFile(uri);
                chunks.push(chunk);

                const { language, responseFormat } = parameters;
                cortexRequest.url = this.requestUrl(text);
                const params = {};
                const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);
                const response_format = responseFormat || 'text';

                const formData = new FormData();
                formData.append('file', fs.createReadStream(chunk));
                formData.append('model', this.model.params.model);
                formData.append('response_format', response_format);
                language && formData.append('language', language);
                modelPromptText && formData.append('prompt', modelPromptText);

                cortexRequest.data = formData;
                cortexRequest.params = params;
                cortexRequest.headers = { ...cortexRequest.headers, ...formData.getHeaders() };

                return this.executeRequest(cortexRequest);
            } catch (err) {
                logger.error(`Error getting word timestamped data from api: ${err}`);
                throw err;
            }
        }

        const processTS = async (uri) => {
            const tsparams = { fileurl:uri };
            const { language } = parameters;
            if(language) tsparams.language = language;
            if(highlightWords) tsparams.highlight_words = highlightWords ? "True" : "False";
            if(maxLineWidth) tsparams.max_line_width = maxLineWidth;
            if(maxLineCount) tsparams.max_line_count = maxLineCount;
            if(maxWordsPerLine) tsparams.max_words_per_line = maxWordsPerLine;
            if(wordTimestamped!=null) {
                if(!wordTimestamped) {
                    tsparams.word_timestamps = "False";
                }else{
                    tsparams.word_timestamps = wordTimestamped;    
                }
            }

            cortexRequest.url = WHISPER_TS_API_URL;
            cortexRequest.data = tsparams;

            const res = await this.executeRequest(cortexRequest);
            if (res.statusCode && res.statusCode >= 400) {
                throw new Error(res.message || 'An error occurred.');
            }

            if(!wordTimestamped && !responseFormat){ 
                //if no response format, convert to text
                return convertToText(res);
            }
            return res;
        }

        let result = [];
        let { file } = parameters;
        let totalCount = 0;
        let completedCount = 0;
        let partialCount = 0;
        const { requestId } = pathwayResolver;

        const MAXPARTIALCOUNT = 60;
        const sendProgress = (partial=false) => {
            if(partial){
                partialCount = Math.min(partialCount + 1, MAXPARTIALCOUNT-1);
            }else {
                partialCount = 0;
                completedCount++;
            }
            if (completedCount >= totalCount) return;

            const progress = (partialCount / MAXPARTIALCOUNT + completedCount) / totalCount;
            logger.info(`Progress for ${requestId}: ${progress}`);

            publishRequestProgress({
                requestId,
                progress,
                data: null,
            });
        }

        async function processURI(uri) {
            let result = null;
            let _promise = null;
            let errorOccurred = false;
        
            const useTS = WHISPER_TS_API_URL && (wordTimestamped || highlightWords);
        
            if (useTS) {
                _promise = processTS;
            } else {
                _promise = processChunk;
            }
            
            _promise(uri).then((ts) => {
                result = ts;
            }).catch((err) => {
                logger.error(`Error occurred while processing URI: ${err}`);
                errorOccurred = err;
            });
        
            while(result === null && !errorOccurred) {
                sendProgress(true);
                await new Promise(r => setTimeout(r, 3000));
            }

            if(errorOccurred) {
                throw errorOccurred;
            }
            
            return result;
        }

        try {
            const uris = await this.getMediaChunks(file, requestId); // array of remote file uris
            if (!uris || !uris.length) {
                throw new Error(`Error in getting chunks from media helper for file ${file}`);
            }
            totalCount = uris.length + 1; // total number of chunks that will be processed

            // sequential process of chunks
            for (const uri of uris) {
                sendProgress(); 
                const ts = await processURI(uri);
                result.push(ts);
            }

        } catch (error) {
            const errMsg = `Transcribe error: ${error?.response?.data || error?.message || error}`;
            logger.error(errMsg);
            return errMsg;
        }
        finally {
            try {
                for (const chunk of chunks) {
                    try {
                        await deleteTempPath(chunk);
                    } catch (error) {
                        //ignore error
                    } 
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
