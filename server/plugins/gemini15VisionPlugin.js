import Gemini15ChatPlugin from './gemini15ChatPlugin.js';
import mime from 'mime-types';

class Gemini15VisionPlugin extends Gemini15ChatPlugin {

    // Override the convertMessagesToGemini method to handle multimodal vision messages
    // This function can operate on messages in Gemini native format or in OpenAI's format
    // It will convert the messages to the Gemini format
    convertMessagesToGemini(messages) {
        let modifiedMessages = [];
        let lastAuthor = '';
        let systemParts = [];
    
        // Check if the messages are already in the Gemini format
        if (messages[0] && Object.prototype.hasOwnProperty.call(messages[0], 'parts')) {
            modifiedMessages = messages;
        } else {
            messages.forEach(message => {
                const { role, author, content } = message;
    
                if (role === 'system') {
                    systemParts.push({ text: content });
                    return;
                }
    
                // Convert content to Gemini format, trying to maintain compatibility
                const convertPartToGemini = (inputPart) => {
                    try {
                        const part = typeof inputPart === 'string' ? JSON.parse(inputPart) : inputPart;

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

                    return { text: inputPart };
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
    
        // Gemini requires an odd number of messages
        if (modifiedMessages.length % 2 === 0) {
            modifiedMessages = modifiedMessages.slice(1);
        }
    
        const system = { role: 'user', parts: systemParts };

        return {
            modifiedMessages,
            system,
        };
    }

    async execute(text, parameters, prompt, cortexRequest) {
        let result = null;
        try {
            result = await super.execute(text, parameters, prompt, cortexRequest);
        } catch (e) {
            const { data } = e;
            if (data && data.error) {
                if (data.error.code === 400 && data.error.message === 'Precondition check failed.') {
                    throw new Error('One or more of the included files is too large to process. Please try again with a smaller file.');
                }
            throw e;
            }
        }
        return result; 
    }

}

export default Gemini15VisionPlugin;
