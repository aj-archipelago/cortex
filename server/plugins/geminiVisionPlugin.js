import GeminiChatPlugin from './geminiChatPlugin.js';
// eslint-disable-next-line import/no-extraneous-dependencies
import mime from 'mime-types';

class GeminiVisionPlugin extends GeminiChatPlugin {

    // Override the convertMessagesToGemini method to handle multimodal vision messages
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
                // but they work fine as parts of user messages
                if (role === 'system') {
                    modifiedMessages.push({
                        role: 'user',
                        parts: [{ text: content }],
                    });
                    lastAuthor = 'user';
                    return;
                }
    
                // Function to handle individual content parts and return the corresponding geminiPart
                const handleContentPart = (partString) => {
                    const part = JSON.parse(partString);
                    if (typeof part === 'string') {
                        return { text: part };
                    } else if (part.type === 'text') {
                        return { text: part.text };
                    } else if (part.type === 'image_url') {
                        if (part.image_url.url.startsWith('gs://')) {
                            return {
                                fileData: {
                                    mimeType: mime.lookup(part.image_url.url), // You may want to make this dynamic based on actual image type.
                                    fileUri: part.image_url.url
                                }
                            };
                        } else {
                            return {
                                inlineData: {
                                    mimeType: 'image/jpeg', // You may want to make this dynamic based on actual image type.
                                    data: part.image_url.url.split('base64,')[1]
                                }
                            };
                        }
                    }
                };
    
                // If content is an array, handle each part individually
                if (Array.isArray(content)) {
                    content.forEach(part => {
                        const geminiPart = handleContentPart(part);
                        
                        // Aggregate consecutive author messages, appending the content
                        if ((role === lastAuthor || author === lastAuthor) && modifiedMessages.length > 0) {
                            modifiedMessages[modifiedMessages.length - 1].parts.push(geminiPart);
                        }
                        // Push messages that are role: 'user' or 'assistant', changing 'assistant' to 'model'
                        else if (role === 'user' || role === 'assistant' || author) {
                            modifiedMessages.push({
                                role: author || role,
                                parts: [geminiPart],
                            });
                            lastAuthor = author || role;
                        }
                    });
                } 
                // If content is not an array, handle it directly
                else {
                    const geminiPart = handleContentPart(content);
                    
                    // Push messages that are role: 'user' or 'assistant', changing 'assistant' to 'model'
                    if (role === 'user' || role === 'assistant' || author) {
                        modifiedMessages.push({
                            role: author || role,
                            parts: [geminiPart],
                        });
                        lastAuthor = author || role;
                    }
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
