import logger from "./logger.js";
import subvibe from '@aj-archipelago/subvibe';
import { URL } from 'url';
import { v4 as uuidv4 } from 'uuid';


function getUniqueId(){
    return uuidv4();
}

function getSearchResultId() {
    const timestamp = Date.now().toString(36); // Base36 timestamp
    const random = Math.random().toString(36).substring(2, 5); // 3 random chars
    return `${timestamp}-${random}`;
}

// Helper function to extract citation title from URL
function extractCitationTitle(url) {
    let title = 'Citation';
    if (!url || typeof url !== 'string') return title;
    
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname.replace(/^www\./, '');
        const pathname = urlObj.pathname;
        
        // Check if it's an X/Twitter URL first
        if (url.includes('x.com/') || url.includes('twitter.com/')) {
            // Extract handle and status ID from X/Twitter URL
            const handleMatch = url.match(/(?:x\.com|twitter\.com)\/([^\/\?]+)/);
            const statusMatch = url.match(/status\/(\d+)/);
            
            if (handleMatch && statusMatch) {
                const handle = handleMatch[1];
                const statusId = statusMatch[1];
                
                // Handle the /i/ internal redirect format - just show as "X Post" with ID
                // The /i/ path is X's internal redirect and doesn't indicate the real author
                if (handle === 'i') {
                    title = `X Post ${statusId}`;
                } else {
                    // Format as "X Post <number> from <username>"
                    const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
                    title = `X Post ${statusId} from @${cleanHandle}`;
                }
            } else if (handleMatch) {
                const handle = handleMatch[1];
                if (handle === 'i') {
                    title = 'X Post';
                } else {
                    const cleanHandle = handle.startsWith('@') ? handle.substring(1) : handle;
                    title = `X Post from @${cleanHandle}`;
                }
            } else {
                title = 'X Post';
            }
        } else {
            // Try to create a meaningful title from the URL
            if (pathname && pathname !== '/') {
                const lastPart = pathname.split('/').pop();
                if (lastPart && lastPart.length > 3) {
                    title = lastPart.replace(/[-_]/g, ' ').replace(/\.[^/.]+$/, '');
                } else {
                    title = hostname;
                }
            } else {
                title = hostname;
            }
        }
    } catch (error) {
        // If URL parsing fails, use the URL itself as title
        title = url;
    }
    
    return title;
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

// convert srt format to text
function convertSrtToText(str) {
    return str
      .split('\n')
      .filter(line => !line.match(/^\d+$/) && !line.match(/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/) && line !== '')
      .join(' ');
}

function alignSubtitles(subtitles, format, offsets) {
    // Basic input validation
    if (!Array.isArray(subtitles) || !Array.isArray(offsets) || subtitles.length !== offsets.length) {
        throw new Error('Invalid input: subtitles and offsets must be arrays of equal length');
    }
    
    if (subtitles.length === 0) {
        return '';
    }

    const result = [];

    function shiftSubtitles(subtitle, shiftOffset) {
        // Skip non-string or empty subtitles
        if (typeof subtitle !== 'string' || subtitle.trim() === '') {
            return [];
        }
        
        try {
            const captions = subvibe.parse(subtitle);
            if (!captions?.cues) {
                return [];
            }
            return subvibe.resync(captions.cues, { offset: shiftOffset });
        } catch (error) {
            logger.warn(`Failed to parse subtitle: ${error.message}`);
            return [];
        }
    }

    for (let i = 0; i < subtitles.length; i++) {
        const shiftedSubtitles = shiftSubtitles(subtitles[i], offsets[i] * 1000);
        if (shiftedSubtitles.length > 0) {
            result.push(...shiftedSubtitles);
        }
    }
    
    try {
        return subvibe.build(result, format || 'srt');
    } catch (error) {
        throw new Error(`Failed to build subtitles: ${error.message}`);
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
    getSearchResultId,
    extractCitationTitle,
    convertToSingleContentChatHistory,
    chatArgsHasImageUrl, 
    chatArgsHasType,
    convertSrtToText,
    alignSubtitles,
    removeOldImageAndFileContent
};
