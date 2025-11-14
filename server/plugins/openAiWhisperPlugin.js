// openAiWhisperPlugin.js
import ModelPlugin from './modelPlugin.js';
import { config } from '../../config.js';
import FormData from 'form-data';
import fs from 'fs';
import { publishRequestProgress } from '../../lib/redisSubscription.js';
import logger from '../../lib/logger.js';
import CortexRequest from '../../lib/cortexRequest.js';
import { convertSrtToText, alignSubtitles } from '../../lib/util.js';
import { downloadFile, deleteTempPath, getMediaChunks, markCompletedForCleanUp } from '../../lib/fileUtils.js';


const OFFSET_CHUNK = 500; //seconds of each chunk offset, only used if helper does not provide

class OpenAIWhisperPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Minimal 429 retry wrapper for Whisper API calls
    async executeWhisperRequest(cortexRequest) {
        const maxRetries = 9;
        
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await this.executeRequest(cortexRequest);
            } catch (error) {
                
                // Check if it's a 429 error
                const is429 = error?.status === 429 || 
                             error?.response?.status === 429 ||
                             error?.message?.includes('429');
                
                if (!is429 || attempt === maxRetries - 1) {
                    // Not a 429 or max retries reached, rethrow
                    throw error;
                }
                
                // Calculate backoff delay (exponential with jitter)
                const retryAfter = error?.response?.headers?.['retry-after'];
                // Fix: Validate parseInt result to prevent NaN
                const baseDelay = retryAfter && !isNaN(parseInt(retryAfter)) 
                    ? parseInt(retryAfter) * 1000 
                    : 2000 * Math.pow(2, attempt);
                const jitter = baseDelay * 0.2 * Math.random();
                const delay = baseDelay + jitter;
                
                logger.warn(`Whisper 429 error (attempt ${attempt + 1}/${maxRetries}). Retrying in ${Math.round(delay)}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        
        // Remove unreachable code - this line was never reached
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt, cortexRequest) {
        const { pathwayResolver } = cortexRequest;

        const { responseFormat, wordTimestamped, highlightWords, maxLineWidth, maxLineCount, maxWordsPerLine } = parameters;

        const chunks = [];
        const processChunk = async (uri) => {
            try {
                const cortexRequest = new CortexRequest({ pathwayResolver });

                const chunk = await downloadFile(uri);
                chunks.push(chunk);

                const { language, responseFormat } = parameters;
                const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);
                const response_format = responseFormat || 'text';

                const whisperInitCallback = (requestInstance) => {
                    const formData = new FormData();
                    formData.append('file', fs.createReadStream(chunk));
                    formData.append('model', requestInstance.params.model);
                    formData.append('response_format', response_format);
                    language && formData.append('language', language);
                    modelPromptText && formData.append('prompt', modelPromptText);

                    requestInstance.data = formData;
                    requestInstance.addHeaders = { ...formData.getHeaders() };
                };

                cortexRequest.initCallback = whisperInitCallback;
                
                // return this.executeRequest(cortexRequest);
                return this.executeWhisperRequest(cortexRequest);

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
            tsparams.word_timestamps = !wordTimestamped ? "False" : wordTimestamped;

            const cortexRequest = new CortexRequest({ pathwayResolver });
            const whisperInitCallback = (requestInstance) => {
                requestInstance.data = tsparams;
            };
            cortexRequest.initCallback = whisperInitCallback;

            sendProgress(true, true);
            
            // const res = await this.executeRequest(cortexRequest);
            const res = await this.executeWhisperRequest(cortexRequest);
            
            if (!res) {
                throw new Error('Received null or empty response');
            }
            if(res?.statusCode && res?.statusCode >= 400){
                throw new Error(res?.message || 'An error occurred.');
            }

            if(!wordTimestamped && !responseFormat){ 
                //if no response format, convert to text
                if (!res) {
                    logger.warn("Received null or empty response from timestamped API when expecting SRT/VTT format. Returning empty string.");
                    return ""; 
                }
                return convertSrtToText(res);
            }
            return res;
        }

        let result = [];
        let { file } = parameters;
        let totalCount = 0;
        let completedCount = 0;
        let partialCount = 0;
        const { requestId } = pathwayResolver;
        let partialRatio = 0;

        const sendProgress = (partial=false, resetCount=false) => {
            partialCount = resetCount ? 0 : partialCount;

            if(partial){
                partialCount++;
                const increment = 0.02 / Math.log2(partialCount + 1); // logarithmic diminishing increment
                partialRatio = Math.min(partialRatio + increment, 0.99); // limit to 0.99
            }else{
                partialCount = 0;
                partialRatio = 0;
                completedCount++;
            }
            if(completedCount >= totalCount) return;

            const progress = (completedCount + partialRatio) / totalCount;
            logger.info(`Progress for ${requestId}: ${progress}`);

            publishRequestProgress({
                requestId,
                progress,
                data: null,
            });
        }

        const processURI = async (uri) => {
            let result = null;
            let _promise = null;
            let errorOccurred = false;

            const intervalId = setInterval(() => sendProgress(true), 3000);

            // use Timestamped API if model is oai-whisper-ts
            const useTS = this.modelName === 'oai-whisper-ts';

            if (useTS) {
                _promise = processTS;
            } else {
                _promise = processChunk;
            }

            await _promise(uri).then((ts) => {
                result = ts;
            }).catch((err) => {
                errorOccurred = err;
            }).finally(() => {
                clearInterval(intervalId);
                sendProgress();
            });

            if(errorOccurred) {
                throw errorOccurred;
            }

            return result;
        }

        let offsets = [];
        let uris = []

        try {
            const mediaChunks = await getMediaChunks(file, requestId);
            
            if (!mediaChunks || !mediaChunks.length) {
                throw new Error(`Error in getting chunks from media helper for file ${file}`);
            }

            uris = mediaChunks.map((chunk) => chunk?.uri || chunk);
            offsets = mediaChunks.map((chunk, index) => chunk?.offset || index * OFFSET_CHUNK);

            totalCount = mediaChunks.length + 1; // total number of chunks that will be processed

            const batchSize = 4;
            sendProgress();

            for (let i = 0; i < uris.length; i += batchSize) {
                const currentBatchURIs = uris.slice(i, i + batchSize);
                const promisesToProcess = currentBatchURIs.map(uri => processURI(uri));
                const results = await Promise.all(promisesToProcess); 
                
                for(const res of results) {
                    result.push(res);
                }
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

                await markCompletedForCleanUp(requestId);

            } catch (error) {
                logger.error(`An error occurred while deleting: ${error}`);
            }
        }

        if (['srt','vtt'].includes(responseFormat) || wordTimestamped) { // align subtitles for formats
            return alignSubtitles(result, responseFormat, offsets);
        }
        return result.join(` `);
    }
}

export default OpenAIWhisperPlugin;
