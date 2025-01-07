// AzureVideoTranslatePlugin.js
import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";
import axios from "axios";
import { publishRequestProgress } from "../../lib/redisSubscription.js";
import { config } from "../../config.js";

function isValidJSON(str) {
    try {
        JSON.parse(str);
        return true;
    } catch (e) {
        return false;
    }
}

class AzureVideoTranslatePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
        this.apiUrl = config.get("azureVideoTranslationApiUrl");
        this.eventSource = null;
        this.jsonBuffer = '';
        this.jsonDepth = 0;
    }

    getRequestParameters(_, parameters, __) {
        const excludedParameters = [
            'text', 'parameters', 'prompt', 'promptParameters', 'previousResult', 'stream', 'memoryContext'
        ];
        
        return Object.fromEntries(
            Object.entries(parameters).filter(([key, value]) => 
                !excludedParameters.includes(key) && 
                value !== '' && 
                typeof value !== 'undefined'
            )
        );
    }

    handleStream(stream, onData, onEnd, onError) {
        const timeout = setTimeout(() => {
            onError(new Error('Stream timeout'));
        }, 300000); // timeout

        stream.on('data', (chunk) => {
            clearTimeout(timeout);
            const lines = chunk.toString().split('\n\n');
            lines.forEach(line => {
                if (line.startsWith('data: ')) {
                    const eventData = line.slice(6);
                    try {
                        this.handleEvent({ data: eventData }, onData);
                    } catch (error) {
                        onError(error);
                    }
                }
            });
        });
        stream.on('end', () => {
            clearTimeout(timeout);
            this.cleanup();
            onEnd();
        });
        stream.on('error', (error) => {
            clearTimeout(timeout);
            console.error('Stream error:', error);
            this.cleanup();
            onError(error);
        });
    }

    handleEvent(event, onData) {
        const data = event.data;
        this.jsonBuffer += data;
        this.jsonDepth += (data.match(/{/g) || []).length - (data.match(/}/g) || []).length;

        if (this.jsonDepth === 0 && this.jsonBuffer.trim()) {
            logger.debug(this.jsonBuffer);
            if (this.jsonBuffer.includes('Failed to run with exception')) {
                this.cleanup();
                throw new Error(this.jsonBuffer);
            }

            onData(this.jsonBuffer);
            this.jsonBuffer = '';
            this.jsonDepth = 0;
        }
    }

    async execute(text, parameters, prompt, cortexRequest) {
        if (!this.apiUrl) {
            throw new Error("API URL is not set");
        }
        this.requestId = cortexRequest.requestId;
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        try {
            const response = await axios.post(this.apiUrl, requestParameters, {
                responseType: 'stream',
                headers: {
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                }
            });

            return new Promise((resolve, reject) => {
                let finalJson = '';
                this.handleStream(response.data,
                    (data) => {
                        let sent = false;
                        if (isValidJSON(data)) {
                            const parsedData = JSON.parse(data);
                            if (parsedData.progress !== undefined) {
                                let timeInfo = '';
                                if (parsedData.estimated_time_remaining && parsedData.elapsed_time) {
                                    const minutes = Math.ceil(parsedData.estimated_time_remaining / 60);
                                    timeInfo = minutes <= 2 
                                        ? `Should be done soon (${parsedData.elapsed_time} elapsed)`
                                        : `Estimated ${minutes} minutes remaining`;
                                }

                                publishRequestProgress({
                                    requestId: this.requestId,
                                    progress: parsedData.progress,
                                    info: timeInfo
                                });
                                sent = true;
                            }
                        }
                        if (!sent) {
                            publishRequestProgress({
                                requestId: this.requestId,
                                info: data
                            });
                        }
                        logger.debug('Data:', data);
                        
                        // Extract JSON content if message contains targetLocales
                        const jsonMatch = data.match(/{[\s\S]*"targetLocales"[\s\S]*}/);
                        if (jsonMatch) {
                            const extractedJson = jsonMatch[0];
                            if (isValidJSON(extractedJson)) {
                                finalJson = extractedJson;
                            }
                        } 
                    },
                    () => {
                        resolve(finalJson)
                    },
                    (error) => reject(error)
                );
            }).finally(() => this.cleanup());

        } catch (error) {
            this.cleanup();
            return error;
        }
    }

    parseResponse(data) {
        const response = typeof data === 'object' ? JSON.stringify(data) : data;
        publishRequestProgress({
            requestId: this.requestId,
            progress: 1,
            data: response,
        });
        return response;
    }

    logRequestData(data, responseData, prompt) {
        logger.verbose(`Request: ${JSON.stringify(data)}`);
        logger.verbose(`Response: ${this.parseResponse(responseData)}`);
        if (prompt?.debugInfo) {
            prompt.debugInfo += `\nRequest: ${JSON.stringify(data)}`;
            prompt.debugInfo += `\nResponse: ${this.parseResponse(responseData)}`;
        }
    }

    cleanup() {
        if (this.eventSource) {
            this.eventSource.close();
            this.eventSource = null;
        }
    }
}

export default AzureVideoTranslatePlugin;