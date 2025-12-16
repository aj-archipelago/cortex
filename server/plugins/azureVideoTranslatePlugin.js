// AzureVideoTranslatePlugin.js
import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";
import { publishRequestProgress } from "../../lib/redisSubscription.js";
import { fetchFileFromUrl } from "../../lib/fileUtils.js";
import crypto from 'crypto';
import axios from 'axios';
import {config} from "../../config.js";

// turn off any caching because we're polling the operation status
axios.defaults.cache = false;

class AzureVideoTranslatePlugin extends ModelPlugin {
    static lastProcessingRate = null; // bytes per second
    static processingRates = []; // Array to store historical processing rates
    static maxHistorySize = 10; // Maximum number of rates to store
    
    constructor(pathway, model) {
        super(pathway, model);
        this.subscriptionKey = config.get("azureVideoTranslationApiKey");
        this.apiVersion = "2024-05-20-preview";
        this.baseUrl = "";
        this.startTime = null;
        this.videoContentLength = null;
    }

    async verifyVideoAccess(videoUrl) {
        try {
            const response = await axios.head(videoUrl);
            
            const contentType = response.headers['content-type'];
            const contentLength = parseInt(response.headers['content-length'], 10);

            if (contentType && !contentType.includes('video/mp4')) {
                logger.warn(`Warning: Video might not be in MP4 format. Content-Type: ${contentType}`);
            }

            const TYPICAL_BITRATE = 2.5 * 1024 * 1024; // 2.5 Mbps
            const durationSeconds = Math.round((contentLength * 8) / TYPICAL_BITRATE);
            
            return {
                isAccessible: true,
                contentLength,
                durationSeconds: durationSeconds || 60,
                isAzureUrl: videoUrl.includes('.blob.core.windows.net')
            };
        } catch (error) {
            throw new Error(`Failed to access video: ${error.message}`);
        }
    }

    async uploadToFileHandler(videoUrl, contextId = null) {
        try {
            // Get the file handler URL from config
            const fileHandlerUrl = config.get("whisperMediaApiUrl");
            if (!fileHandlerUrl) {
                throw new Error("File handler URL is not configured");
            }

            // Start heartbeat progress updates
            const heartbeat = setInterval(() => {
                publishRequestProgress({
                    requestId: this.requestId,
                    progress: 0,
                    info: 'Uploading and processing video...'
                });
            }, 5000);

            try {
                // Use encapsulated file handler function
                const response = await fetchFileFromUrl(videoUrl, this.requestId, contextId, false);
                
                // Response can be an array (for chunked files) or an object with url
                const resultUrl = Array.isArray(response) ? response[0] : response.url;
                
                if (!resultUrl) {
                    throw new Error("File handler did not return a valid URL");
                }

                return resultUrl;
            } finally {
                // Always clear the heartbeat interval
                clearInterval(heartbeat);
            }
        } catch (error) {
            logger.error(`Failed to upload video to file handler: ${error.message}`);
            if (error.response?.data) {
                logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
            }
            throw new Error(`Failed to upload video to file handler: ${error.message}`);
        }
    }

    async createTranslation(params) {
        const { videoUrl, sourceLanguage, targetLanguage, voiceKind, translationId } = params;
        
        const translation = {
            id: translationId,
            displayName: `${translationId}.mp4`,
            description: `Translate video from ${sourceLanguage} to ${targetLanguage}`,
            input: {
                sourceLocale: sourceLanguage,
                targetLocale: targetLanguage,
                voiceKind: voiceKind,
                videoFileUrl: videoUrl
            }
        };

        const url = `${this.baseUrl}/translations/${translationId}?api-version=${this.apiVersion}`;
        logger.debug(`Creating translation: ${url}`);

        try {
            const response = await axios.put(url, translation, {
                headers: {
                    'Content-Type': 'application/json',
                    'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                }
            });

            const operationUrl = response.headers['operation-location'];
            return { translation: response.data, operationUrl };
        } catch (error) {
            const errorText = error.response?.data?.error?.innererror?.message || error.message;
            throw new Error(`Failed to create translation: ${errorText}`);
        }
    }

    async getTranslationStatus(translationId) {
        const url = `${this.baseUrl}/translations/${translationId}?api-version=${this.apiVersion}`;
        try {
            const response = await axios.get(url, {
                headers: {
                    'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                }
            });
            return response.data;
        } catch (error) {
            throw new Error(`Failed to get translation status: ${error.message}`);
        }
    }

    async getIterationStatus(translationId, iterationId) {
        const url = `${this.baseUrl}/translations/${translationId}/iterations/${iterationId}?api-version=${this.apiVersion}`;
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                }
            });
            return response.data;
        } catch (error) {
            const errorText = error.response?.data?.error?.innererror?.message || error.message;
            throw new Error(`Failed to get iteration status: ${errorText}`);
        }
    }

    async pollOperation(operationUrl) {
        try {
            const response = await axios.get(operationUrl, {
                headers: {
                    'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                }
            });
            return response.data;
        } catch (error) {
            const errorText = error.response?.data?.error?.innererror?.message || error.message;
            throw new Error(`Failed to poll operation: ${errorText}`);
        }
    }

    async monitorOperation(operationUrlOrConfig, entityType = 'operation') {

        let estimatedTotalTime = 0;
        if (AzureVideoTranslatePlugin.lastProcessingRate && this.videoContentLength) {
            estimatedTotalTime = this.videoContentLength / AzureVideoTranslatePlugin.lastProcessingRate;
        } else {
            // First run: estimate based on 2x calculated video duration
            estimatedTotalTime = 2 * (this.videoContentLength * 8) / (2.5 * 1024 * 1024);
        }

        // eslint-disable-next-line no-constant-condition
        while (true) {
            let status;
            if (typeof operationUrlOrConfig === 'string') {
                const operation = await this.pollOperation(operationUrlOrConfig);
                status = operation;
            } else {
                const { translationId, iterationId } = operationUrlOrConfig;
                const iteration = await this.getIterationStatus(translationId, iterationId);
                status = iteration;
            }

            logger.debug(`${entityType} status: ${JSON.stringify(status, null, 2)}`);

            let progress = 0;
            let estimatedProgress = 0;
            let progressMessage = '';
            switch (entityType) {
                case 'translation':
                    progressMessage = 'Getting ready to translate video...';
                    break;
                case 'iteration':
                    if (status.status === 'NotStarted') {
                        progressMessage = 'Waiting for translation to start...';
                    } else if (status.status === 'Running') {
                        progressMessage = 'Translating video...';
                        if (this.startTime) {
                            // Calculate progress based on elapsed time
                            const elapsedSeconds = (Date.now() - this.startTime) / 1000;
                            estimatedProgress = Math.min(0.95, elapsedSeconds / estimatedTotalTime);
                            const remainingSeconds = Math.max(0, estimatedTotalTime - elapsedSeconds);
                            if (remainingSeconds > 0) {
                                if (remainingSeconds < 60) {
                                    const roundedSeconds = Math.ceil(remainingSeconds);
                                    progressMessage = `Translating video... ${roundedSeconds} second${roundedSeconds !== 1 ? 's' : ''} remaining`;
                                } else {
                                    const remainingMinutes = Math.ceil(remainingSeconds / 60);
                                    progressMessage = `Translating video... ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''} remaining`;
                                }
                            }
                            progress = status.percentComplete ? status.percentComplete / 100 : estimatedProgress;
                        } else {
                            this.startTime = Date.now();
                            estimatedProgress = 0;
                        }
                    } else if (status.status === 'Succeeded') {
                        progressMessage = 'Video translation complete.';
                    } else if (status.status === 'Failed') {
                        progressMessage = 'Video translation failed.';
                    }
                    break;
            }

            // Publish progress updates
            publishRequestProgress({
                requestId: this.requestId,
                progress,
                info: progressMessage
            });

            if (status.status === 'Succeeded') {
                return status;
            } else if (status.status === 'Failed') {
                throw new Error(`${entityType} failed: ${status.error?.message || 'Unknown error'}`);
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    async getTranslationOutput(translationId, iterationId) {
        const iteration = await this.getIterationStatus(translationId, iterationId);
        const translation = await this.getTranslationStatus(translationId);
        if (iteration.result) {
            const targetLocale = translation.input.targetLocale;
            return {
                outputVideoSubtitleWebVttFileUrl: iteration.result.sourceLocaleSubtitleWebvttFileUrl,
                targetLocales: {
                    [targetLocale]: {
                        outputVideoFileUrl: iteration.result.translatedVideoFileUrl,
                        outputVideoSubtitleWebVttFileUrl: iteration.result.targetLocaleSubtitleWebvttFileUrl
                    }
                }
            };
        }
        return null;
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

    async execute(text, parameters, prompt, cortexRequest) {
        if (!this.subscriptionKey) {
            throw new Error("Azure Video Translation subscription key is not set");
        }

        this.requestId = cortexRequest.requestId;
        this.baseUrl = cortexRequest.url;
        
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        
        try {
            const translationId = `cortex-translation-${this.requestId}`;
            let videoUrl = requestParameters.sourcevideooraudiofilepath;
            const sourceLanguage = requestParameters.sourcelocale;
            const targetLanguage = requestParameters.targetlocale;
            const voiceKind = requestParameters.voicekind || 'PlatformVoice';
            const embedSubtitles = requestParameters.withoutsubtitleintranslatedvideofile === "false" ? true : false;
            const speakerCount = parseInt(requestParameters.speakercount) || 0;

            // Verify video access and get duration
            const videoInfo = await this.verifyVideoAccess(videoUrl);
            this.videoContentLength = videoInfo.contentLength;
            logger.debug(`Video info: ${JSON.stringify(videoInfo, null, 2)}`);

            // If the video is not from Azure storage, upload it to file handler
            if (!videoInfo.isAzureUrl) {
                logger.debug('Video is not from Azure storage, uploading to file handler...');
                // Use savedContextId as contextId for scoped file storage (fallback to requestId if not available)
                const contextId = cortexRequest.pathwayResolver?.savedContextId || this.requestId;
                videoUrl = await this.uploadToFileHandler(videoUrl, contextId);
                logger.debug(`Video uploaded to file handler: ${videoUrl}`);
            }

            // Create translation
            const { operationUrl } = await this.createTranslation({
                videoUrl, sourceLanguage, targetLanguage, voiceKind, translationId
            });

            logger.debug(`Starting translation monitoring with operation URL: ${operationUrl}`);
            // Monitor translation creation
            const operationStatus = await this.monitorOperation(operationUrl, 'translation');
            logger.debug(`Translation operation completed with status: ${JSON.stringify(operationStatus, null, 2)}`);
            
            const updatedTranslation = await this.getTranslationStatus(translationId);
            logger.debug(`Translation status after operation: ${JSON.stringify(updatedTranslation, null, 2)}`);

            // Create iteration
            const iteration = {
                id: crypto.randomUUID(),
                displayName: translationId,
                input: {
                    subtitleMaxCharCountPerSegment: 42,
                    exportSubtitleInVideo: embedSubtitles,
                    ...(speakerCount > 0 && { speakerCount })
                }
            };

            logger.debug(`Creating iteration: ${JSON.stringify(iteration, null, 2)}`);
            const iterationUrl = `${this.baseUrl}/translations/${translationId}/iterations/${iteration.id}?api-version=${this.apiVersion}`;
            try {
                const iterationResponse = await axios.put(iterationUrl, iteration, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Ocp-Apim-Subscription-Key': this.subscriptionKey,
                        'Cache-Control': 'no-cache',
                        'Pragma': 'no-cache'
                    }
                });

                const iterationOperationUrl = iterationResponse.headers['operation-location'];
                await this.monitorOperation(iterationOperationUrl, 'iteration');

                // Update processing rate for future estimates
                const totalSeconds = (Date.now() - this.startTime) / 1000;
                const newRate = this.videoContentLength / totalSeconds;
                AzureVideoTranslatePlugin.updateProcessingRate(newRate);
                logger.debug(`Updated processing rate: ${AzureVideoTranslatePlugin.lastProcessingRate} bytes/second (from ${newRate} bytes/second)`);

                const output = await this.getTranslationOutput(translationId, iteration.id);
                return JSON.stringify(output);
            } catch (error) {
                const errorText = error.response?.data?.error?.innererror?.message || error.message;
                throw new Error(`Failed to create iteration: ${errorText}`);
            }
        } catch (error) {
            logger.error(`Error in video translation: ${error.message}`);
            throw error;
        }
    }

    static updateProcessingRate(newRate) {
        // Add new rate to history
        AzureVideoTranslatePlugin.processingRates.push(newRate);
        
        // Keep only the last maxHistorySize entries
        if (AzureVideoTranslatePlugin.processingRates.length > AzureVideoTranslatePlugin.maxHistorySize) {
            AzureVideoTranslatePlugin.processingRates.shift();
        }
        
        // Calculate weighted average - more recent measurements have higher weight
        const sum = AzureVideoTranslatePlugin.processingRates.reduce((acc, rate, index) => {
            const weight = index + 1; // Weight increases with recency
            return acc + (rate * weight);
        }, 0);
        
        const weightSum = AzureVideoTranslatePlugin.processingRates.reduce((acc, _, index) => acc + (index + 1), 0);
        AzureVideoTranslatePlugin.lastProcessingRate = sum / weightSum;
    }
}

export default AzureVideoTranslatePlugin;