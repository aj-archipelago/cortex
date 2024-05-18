import GeminiChatPlugin from './geminiChatPlugin.js';
import mime from 'mime-types';
import logger from '../../lib/logger.js';

class GeminiVisionPlugin extends GeminiChatPlugin {

    // Override the convertMessagesToGemini method to handle multimodal vision messages
    // This function can operate on messages in Gemini native format or in OpenAI's format
    // It will convert the messages to the Gemini format
    convertMessagesToGemini(messages) {
        let modifiedMessages = [];
        let lastAuthor = '';
    
        // Check if the messages are already in the Gemini format
        if (messages[0] && Object.prototype.hasOwnProperty.call(messages[0], 'parts')) {
            modifiedMessages = messages;
        } else {
            messages.forEach(message => {
                const { role, author, content } = message;
    
                // Right now Gemini API has no direct translation for system messages,
                // so we insert them as parts of the first user: role message
                if (role === 'system') {
                    modifiedMessages.push({
                        role: 'user',
                        parts: [{ text: content }],
                    });
                    lastAuthor = 'user';
                    return;
                }
    
                // Convert content to Gemini format, trying to maintain compatibility
                const convertPartToGemini = (partString) => {
                    try {
                        const part = JSON.parse(partString);
                        if (typeof part === 'string') {
                            return { text: part };
                        } else if (part.type === 'text') {
                            return { text: part.text };
                        } else if (part.type === 'image_url') {
                            if (part.image_url.url.startsWith('gs://')) {
                                return {
                                    fileData: {
                                        mimeType: mime.lookup(part.image_url.url),
                                        fileUri: part.image_url.url
                                    }
                                };
                            } else {
                                return {
                                    inlineData: {
                                        mimeType: 'image/jpeg', // fixed for now as there's no MIME type in the request
                                        data: part.image_url.url.split('base64,')[1]
                                    }
                                };
                            }
                        }
                    } catch (e) {
                        // this space intentionally left blank
                    }
                    return { text: partString };
                };
    
                const addPartToMessages = (geminiPart) => {
                    // Gemini requires alternating user: and model: messages
                    if ((role === lastAuthor || author === lastAuthor) && modifiedMessages.length > 0) {
                        modifiedMessages[modifiedMessages.length - 1].parts.push(geminiPart);
                    }
                    // Gemini only supports user: and model: roles
                    else if (role === 'user' || role === 'assistant' || author) {
                        modifiedMessages.push({
                            role: author || role,
                            parts: [geminiPart],
                        });
                        lastAuthor = author || role;
                    }
                };

                // Content can either be in the "vision" format (array) or in the "chat" format (string)
                if (Array.isArray(content)) {
                    content.forEach(part => {
                        addPartToMessages(convertPartToGemini(part));
                    });
                } 
                else {
                    addPartToMessages(convertPartToGemini(content));
                }
            });
        }
    
        // Gemini requires an even number of messages
        if (modifiedMessages.length % 2 === 0) {
            modifiedMessages = modifiedMessages.slice(1);
        }
    
        return {
            modifiedMessages,
        };
    }

}

export default GeminiVisionPlugin;
