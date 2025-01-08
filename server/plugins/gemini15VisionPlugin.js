import Gemini15ChatPlugin from './gemini15ChatPlugin.js';
import mime from 'mime-types';

class Gemini15VisionPlugin extends Gemini15ChatPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.isMultiModal = true;
    }

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
                        const {type, text, image_url, gcs} = part;
                        let fileUrl = gcs || image_url?.url;

                        if (typeof part === 'string') {
                            return { text: text };
                        } else if (type === 'text') {
                            return { text: text };
                        } else if (type === 'image_url') {
                            if (!fileUrl) {
                                return null;
                            }
                            if (fileUrl.startsWith('gs://')) {
                                // Validate GCS URL has at least a bucket name after gs://
                                const gcsPath = fileUrl.slice(5); // Remove 'gs://'
                                if (!gcsPath || gcsPath.length < 1) {
                                    return null;
                                }
                                return {
                                    fileData: {
                                        mimeType: mime.lookup(fileUrl) || 'image/jpeg',
                                        fileUri: fileUrl
                                    }
                                };
                            } else if (fileUrl.includes('base64,')) {
                                const base64Data = fileUrl.split('base64,')[1];
                                if (!base64Data) {
                                    return null;
                                }
                                return {
                                    inlineData: {
                                        mimeType: 'image/jpeg',
                                        data: base64Data
                                    }
                                };
                            }
                            return null;
                        }
                    } catch (e) {
                        // this space intentionally left blank
                    }
                    return inputPart ? { text: inputPart } : null;
                };

                const addPartToMessages = (geminiPart) => {
                    if (!geminiPart) { return; }
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
    
        let system = null;

        if (systemParts.length > 0) {
            system = { role: 'user', parts: systemParts };
        }

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
