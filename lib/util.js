import logger from "./logger.js";
import stream from 'stream';
import subvibe from '@aj-archipelago/subvibe';
import os from 'os';
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

function getUniqueId(){
    return uuidv4();
}

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
        // Handle both array and string content
        const contents = Array.isArray(ch.content) ? ch.content : [ch.content];
        for(const content of contents){
            try{
                if((content?.type || JSON.parse(content).type) == type){
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
    const urlObj = new URL(fileUrl);
    const pathname = urlObj.pathname;
    const fileExtension = pathname.substring(pathname.lastIndexOf('.') + 1);
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

    function shiftSubtitles(subtitle, shiftOffset) {
        const captions = subvibe.parse(subtitle);
        const resynced = subvibe.resync(captions.cues, { offset: shiftOffset });
        return resynced;
    }

    for (let i = 0; i < subtitles.length; i++) {
        result.push(...shiftSubtitles(subtitles[i], offsets[i]*1000)); // convert to milliseconds
    }
    
    
    return subvibe.build(result, format || 'srt');
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

function removeOldImageAndFileContent(chatHistory) {
    if (!chatHistory || !Array.isArray(chatHistory) || chatHistory.length === 0) {
        return chatHistory;
    }
    
    // Find the index of the last user message with image or file content
    let lastImageOrFileIndex = -1;
    
    for (let i = chatHistory.length - 1; i >= 0; i--) {
        const message = chatHistory[i];
        
        // Skip non-user messages
        if (message.role !== 'user') {
            continue;
        }
        
        // Check if this message has image or file content
        if (messageHasImageOrFile(message)) {
            lastImageOrFileIndex = i;
            break;
        }
    }
    
    // If no message with image or file found, return original
    if (lastImageOrFileIndex === -1) {
        return chatHistory;
    }
    
    // Create a deep copy of the chat history
    const modifiedChatHistory = JSON.parse(JSON.stringify(chatHistory));
    
    // Process earlier messages to remove image and file content
    for (let i = 0; i < lastImageOrFileIndex; i++) {
        const message = modifiedChatHistory[i];
        
        // Only process user messages
        if (message.role !== 'user') {
            continue;
        }
        
        // Remove image and file content
        modifiedChatHistory[i] = removeImageAndFileFromMessage(message);
    }
    
    return modifiedChatHistory;
}

// Helper function to check if a message has image or file content
function messageHasImageOrFile(message) {
    if (!message || !message.content) {
        return false;
    }
    
    // Handle array content
    if (Array.isArray(message.content)) {
        for (const content of message.content) {
            try {
                const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
                if (contentObj.type === 'image_url' || contentObj.type === 'file') {
                    return true;
                }
            } catch (e) {
                // Not JSON or couldn't be parsed, continue
                continue;
            }
        }
    } 
    // Handle string content
    else if (typeof message.content === 'string') {
        try {
            const contentObj = JSON.parse(message.content);
            if (contentObj.type === 'image_url' || contentObj.type === 'file') {
                return true;
            }
        } catch (e) {
            // Not JSON or couldn't be parsed
            return false;
        }
    }
    // Handle object content
    else if (typeof message.content === 'object') {
        return message.content.type === 'image_url' || message.content.type === 'file';
    }
    
    return false;
}

// Helper function to remove image and file content from a message
function removeImageAndFileFromMessage(message) {
    if (!message || !message.content) {
        return message;
    }
    
    const modifiedMessage = { ...message };
    
    // Handle array content
    if (Array.isArray(message.content)) {
        modifiedMessage.content = message.content.filter(content => {
            try {
                const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
                // Keep content that's not image or file
                return !(contentObj.type === 'image_url' || contentObj.type === 'file');
            } catch (e) {
                // Not JSON or couldn't be parsed, keep it
                return true;
            }
        });
        
        // If all content was removed, add an empty string
        if (modifiedMessage.content.length === 0) {
            modifiedMessage.content = [""];
        }
    }
    // Handle string content
    else if (typeof message.content === 'string') {
        try {
            const contentObj = JSON.parse(message.content);
            if (contentObj.type === 'image_url' || contentObj.type === 'file') {
                modifiedMessage.content = "";
            }
        } catch (e) {
            // Not JSON or couldn't be parsed, keep original
        }
    }
    // Handle object content
    else if (typeof message.content === 'object') {
        if (message.content.type === 'image_url' || message.content.type === 'file') {
            modifiedMessage.content = "";
        }
    }
    
    return modifiedMessage;
}

export { 
    getUniqueId,
    convertToSingleContentChatHistory,
    chatArgsHasImageUrl, 
    chatArgsHasType,
    deleteTempPath,
    downloadFile,
    convertSrtToText,
    alignSubtitles,
    getMediaChunks,
    markCompletedForCleanUp,
    removeOldImageAndFileContent
};