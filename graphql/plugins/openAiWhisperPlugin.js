// OpenAICompletionPlugin.js
import ModelPlugin from './modelPlugin.js';

import FormData from 'form-data';
import fs from 'fs';
import { splitMediaFile, isValidYoutubeUrl, processYoutubeUrl, deleteTempPath } from '../../lib/fileChunker.js';
import pubsub from '../pubsub.js';

class OpenAIWhisperPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Execute the request to the OpenAI Whisper API
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl(text);
        const params = {};
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

        const processChunk = async (chunk) => {
            try {
                const formData = new FormData();
                formData.append('file', fs.createReadStream(chunk));
                formData.append('model', this.model.params.model);
                formData.append('response_format', 'text');
                // formData.append('language', 'tr');
                modelPromptText && formData.append('prompt', modelPromptText);

                return this.executeRequest(url, formData, params, { ...this.model.headers, ...formData.getHeaders() });
            } catch (err) {
                console.log(err);
            }
        }

        let result = ``;
        let { file } = parameters;
        let folder;
        const isYoutubeUrl = isValidYoutubeUrl(file);
        let totalCount = 0;
        let completedCount = 0;
        const { requestId } = pathwayResolver;

        const sendProgress = () => {
            completedCount++;
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    progress: completedCount / totalCount,
                    data: null,
                }
            });
        }

        try {
            if (isYoutubeUrl) {
                // totalCount += 1; // extra 1 step for youtube download
                file = await processYoutubeUrl(file);
            }

            const { chunkPromises, uniqueOutputPath } = await splitMediaFile(file);
            folder = uniqueOutputPath;
            totalCount += chunkPromises.length * 2; // 2 steps for each chunk (download and upload)
            // isYoutubeUrl && sendProgress(); // send progress for youtube download after total count is calculated

            // sequential download of chunks
            const chunks = [];
            for (const chunkPromise of chunkPromises) {
                sendProgress();
                chunks.push(await chunkPromise);
            }

            // sequential processing of chunks
            for (const chunk of chunks) {
                result += await processChunk(chunk);
                sendProgress();
            }

            // parallel processing, dropped 
            // result = await Promise.all(mediaSplit.chunks.map(processChunk));

        } catch (error) {
            console.error("An error occurred:", error);
        } finally {
            isYoutubeUrl && (await deleteTempPath(file));
            folder && (await deleteTempPath(folder));
        }
        return result;
    }
}

export default OpenAIWhisperPlugin;

