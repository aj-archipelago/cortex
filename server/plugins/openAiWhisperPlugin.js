// openAiWhisperPlugin.js
import ModelPlugin from './modelPlugin.js';
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
import { promisify } from 'util';
import subsrt from 'subsrt';
const pipeline = promisify(stream.pipeline);


const API_URL = config.get('whisperMediaApiUrl');
const WHISPER_TS_API_URL  = config.get('whisperTSApiUrl');

const OFFSET_CHUNK = 1000 * 60 * 10; // 10 minutes for each chunk

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
        console.error("An error occurred in content text parsing: ", error);
    }
    
    return subsrt.build(result, { format: format === 'vtt' ? 'vtt' : 'srt' });
}


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
        const { responseFormat,wordTimestamped,highlightWords,maxLineWidth,maxLineCount,maxWordsPerLine } = parameters;

        const processTS = async (uri) => {
            if (!WHISPER_TS_API_URL) {
                throw new Error(`WHISPER_TS_API_URL not set for word timestamped processing`);
            }

            try {
                const tsparams = { fileurl:uri };
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

                const res = await this.executeRequest(WHISPER_TS_API_URL, tsparams, {}, {}, {}, requestId, pathway);

                if(!wordTimestamped && !responseFormat){ 
                    //if no response format, convert to text
                    return convertToText(res);
                }
                return res;
            } catch (err) {
                console.log(`Error getting word timestamped data from api:`, err);
                throw err;
            }
        }

        let result = [];
        let { file } = parameters;
        let totalCount = 0;
        let completedCount = 0;
        let partialCount = 0;
        const { requestId, pathway } = pathwayResolver;

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
            console.log(`Progress: ${progress}`);

            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    progress,
                    data: null,
                }
            });
        }

        async function processURI(uri) {
            let result = null;
            processTS(uri).then((ts) => { result = ts;});

            //send updates while waiting for result
            while(!result) {
                sendProgress(true);
                await new Promise(r => setTimeout(r, 3000));
            }
            return result;
        }

        let chunks = []; // array of local file paths
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

        if (['srt','vtt'].includes(responseFormat) || wordTimestamped) { // align subtitles for formats
            return alignSubtitles(result, responseFormat);
        }
        return result.join(` `);
    }
}

export default OpenAIWhisperPlugin;

