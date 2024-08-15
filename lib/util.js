import logger from "./logger.js";
import stream from 'stream';
import subsrt from 'subsrt';
import os from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';
import { axios } from './requestExecutor.js';
import { config } from '../config.js';
import fs from 'fs';

const pipeline = promisify(stream.pipeline);
const MEDIA_API_URL = config.get('whisperMediaApiUrl');



function convertToSingleContentChatHistory(chatHistory){
    for(let i=0; i<chatHistory.length; i++){
        //if isarray make it single string
        if (Array.isArray(chatHistory[i]?.content)) {
            chatHistory[i].content = chatHistory[i].content.join("\n");
        }
    }
}

//check if args has a type in chatHistory
function chatArgsHasType(args, type){
    const { chatHistory } = args;
    for(const ch of chatHistory){
        for(const content of ch.content){
            try{
                if(JSON.parse(content).type == type){
                    return true;
                }
            }catch(e){
                continue;
            }
        }
    }
    return false;
}

//check if args has an image_url in chatHistory
function chatArgsHasImageUrl(args){
    return chatArgsHasType(args, 'image_url');
}


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
    const fileExtension = fileUrl.split('/').pop().split('?')[0].split('.').pop();
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
function convertSrtToText(str) {
    return str
      .split('\n')
      .filter(line => !line.match(/^\d+$/) && !line.match(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/) && line !== '')
      .join(' ');
}

function alignSubtitles(subtitles, format, offsets) {
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
        result.push(...shiftSubtitles(subtitles[i], offsets[i]*1000)); // convert to milliseconds
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


async function getMediaChunks(file, requestId) {
    try {
        if (MEDIA_API_URL) {
            //call helper api and get list of file uris
            const res = await axios.get(MEDIA_API_URL, { params: { uri: file, requestId } });
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

async function markCompletedForCleanUp(requestId) {
    try {
        if (MEDIA_API_URL) {
            //call helper api to mark processing as completed
            const res = await axios.delete(MEDIA_API_URL, { params: { requestId } });
            logger.info(`Marked request ${requestId} as completed:`, res.data);
            return res.data;
        }
    } catch (err) {
        logger.error(`Error marking request ${requestId} as completed: ${err}`);
    }
}

export { 
    convertToSingleContentChatHistory,
    chatArgsHasImageUrl, 
    chatArgsHasType,
    deleteTempPath,
    downloadFile,
    convertSrtToText,
    alignSubtitles,
    getMediaChunks,
    markCompletedForCleanUp
};