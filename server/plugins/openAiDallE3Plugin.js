import RequestMonitor from '../../lib/requestMonitor.js';
import ModelPlugin from './modelPlugin.js';
import { publishRequestProgress } from '../../lib/redisSubscription.js';
import FormData from 'form-data';
import axios from 'axios';
import logger from '../../lib/logger.js';

const requestDurationEstimator = new RequestMonitor(10);

// Azure /images/generations + /images/edits scalar body params we forward
// when set. Single source of truth so the JSON and multipart paths stay aligned.
const AZURE_IMAGE_BODY_PARAMS = [
    'n', 'size', 'quality', 'output_format', 'output_compression',
    'background', 'moderation', 'style', 'response_format', 'stream',
    'partial_images',
];

// Field name for the Nth input image (i is 0-based). Matches the convention
// the cortex media pathways use elsewhere (image_gemini_31, image_qwen, …).
const inputImageKey = (i) => i === 0 ? 'input_image' : `input_image_${i + 1}`;

// Collect non-empty input_image[, input_image_2, …, input_image_10] into an
// ordered URL/data: URI list.
function collectInputImages(parameters) {
    return Array.from({ length: 10 }, (_, i) => parameters?.[inputImageKey(i)])
        .filter(Boolean);
}

// Append every set scalar body param onto a target { append(k, v) } sink.
// Works for both a plain object (JSON body) and a FormData instance.
function appendScalarBodyParams(target, parameters) {
    for (const key of AZURE_IMAGE_BODY_PARAMS) {
        const v = parameters?.[key];
        if (v === undefined || v === null || v === '') continue;
        target.append
            ? target.append(key, String(v))
            : (target[key] = v);
    }
}

// Fetch a URL or decode a data: URI into a { buffer, contentType, filename }.
async function fetchImageAsPart(src, index) {
    if (typeof src !== 'string' || !src) {
        throw new Error('input image must be a non-empty string');
    }
    if (src.startsWith('data:')) {
        // data:<mime>(;<param>=<value>)*;base64,<payload>
        // — accept zero or more optional ;param= segments between mime and ;base64,
        const m = src.match(/^data:([^;,]+)[^,]*;base64,(.*)$/);
        if (!m) throw new Error('malformed data: URI for input image');
        const contentType = m[1] || 'image/png';
        return {
            buffer: Buffer.from(m[2], 'base64'),
            contentType,
            filename: `input_${index}.${contentType.split('/')[1] || 'png'}`,
        };
    }
    const resp = await axios.get(src, {
        responseType: 'arraybuffer',
        maxContentLength: 50 * 1024 * 1024, // Azure caps each input image at 50 MB
        timeout: 30000,
    });
    const contentType = (resp.headers['content-type'] || 'image/png').split(';')[0];
    const ext = contentType.split('/')[1] || 'png';
    return {
        buffer: Buffer.from(resp.data),
        contentType,
        filename: `input_${index}.${ext}`,
    };
}

/**
 * @description This plugin is for the OpenAI DALL-E 3 model.
 */
class OpenAIDallE3Plugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    /**
     * @description At the time of writing, the DALL-E 3 API on Azure is sync-only, so to support async
     * we keep the request open and send progress updates to the client 
     * over a websocket.
     */

    async execute(text, parameters, _, cortexRequest) {
        const inputImages = collectInputImages(parameters);
        const isEdit = inputImages.length > 0;

        // /images/generations JSON body. For the edit path the multipart
        // body is built inside #executeEditRequest; we still set this for
        // consistent request logging.
        const body = { prompt: text };
        if (!isEdit) appendScalarBodyParams(body, parameters);
        cortexRequest.data = JSON.stringify(body);

        const makeRequest = () => isEdit
            ? this.#executeEditRequest(text, parameters, cortexRequest, inputImages)
            : this.executeRequest(cortexRequest);

        if (!parameters.async) return await makeRequest();
        // async — keep the request open and stream progress updates over the websocket
        const callid = requestDurationEstimator.startCall();
        this.#sendRequestUpdates(cortexRequest.pathwayResolver.requestId, makeRequest(), callid);
    }

    /**
     * Issues a multipart/form-data POST to the Azure /images/edits endpoint.
     * Bypasses the standard executeRequest pipeline because the framework's
     * cortexRequest path locks Content-Type to application/json from the
     * model config — multipart needs axios to set the boundary itself.
     */
    async #executeEditRequest(text, parameters, cortexRequest, inputImages) {
        const generationsUrl = cortexRequest.url;
        // The /images/edits endpoint requires api-version >= 2025-04-01-preview
        // for the gpt-image-1 series (gpt-image-2 included). The /images/generations
        // path can stay on the older 2024-02-01 (DALL-E 3 era) value.
        const editsUrl = generationsUrl
            .replace('/images/generations', '/images/edits')
            .replace(/api-version=[^&]+/, 'api-version=2025-04-01-preview');

        const headers = { ...cortexRequest.headers };
        delete headers['Content-Type'];
        delete headers['content-type'];

        const form = new FormData();
        form.append('prompt', text);

        const appendImagePart = (field, src, idx) =>
            fetchImageAsPart(src, idx).then((p) =>
                form.append(field, p.buffer, { filename: p.filename, contentType: p.contentType }),
            );

        await Promise.all([
            ...inputImages.map((src, i) => appendImagePart('image[]', src, i + 1)),
            parameters?.mask ? appendImagePart('mask', parameters.mask, 'mask') : null,
        ].filter(Boolean));

        appendScalarBodyParams(form, parameters);

        logger.info(`[${cortexRequest.requestId}: ${cortexRequest.pathway?.name}] image edit request to ${editsUrl} (${inputImages.length} input image(s))`);

        try {
            const response = await axios.post(editsUrl, form, {
                headers: { ...headers, ...form.getHeaders() },
                timeout: ((cortexRequest.pathway?.timeout) || 600) * 1000,
                maxBodyLength: Infinity,
                maxContentLength: Infinity,
            });
            return response.data;
        } catch (error) {
            const status = error?.response?.status;
            const data = error?.response?.data;
            const message = data?.error?.message || error.message;
            logger.error(`Image edit request failed (${status || 'no status'}): ${message}`);
            throw new Error(`Execution failed for ${cortexRequest.pathway?.name}: ${message}`);
        }
    }

    /**
     * Send progress updates to the client.
     * 
     * @param {*} requestId 
     * @param {*} requestPromise 
     * @returns 
     */
    async #sendRequestUpdates(requestId, requestPromise, callid) {
        let state = { status: "pending" };
        let attemptCount = 0;
        let data = null;

        requestPromise
        .then((response) => handleResponse(response))
        .catch((error) => handleResponse(error, true));

        function handleResponse(response, isError = false) {
            let status = "succeeded";
            let data;

            if (isError) {
                status = "failed";
                data = JSON.stringify({ error: response.message || response });
            } else if (response.data?.error) {
                status = "failed";
                data = JSON.stringify(response.data);
            } else {
                data = JSON.stringify(response);
            }

            const requestProgress = {
                requestId,
                status,
                progress: 1,
                data,
            };

            state.status = status;
            requestDurationEstimator.endCall(callid);
            publishRequestProgress(requestProgress);
        }

        // publish an update every 2 seconds, using the request duration estimator to calculate
        // the percent complete
        do {
            let progress =
                requestDurationEstimator.calculatePercentComplete(callid);

            if (typeof progress === 'number' && !isNaN(progress) && progress >= 0 && progress <= 1) {
                await publishRequestProgress({
                    requestId,
                    status: "pending",
                    progress,
                    data,
                });
            }

            if (state.status !== "pending") {
                break;
            }

            // sleep for 2 seconds
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        while (state.status !== "succeeded" && attemptCount++ < 30);
        
        return data;
    }
}

export default OpenAIDallE3Plugin;
