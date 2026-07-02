// GoogleTranslatePlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { decodeHTML } from 'entities';

const TRANSLATE_LLM_MODEL = 'general/translation-llm';

const LANGUAGE_CODE_MAP = {
    zh: 'zh-CN',
};

function getServiceAccountProjectId(serviceAccountKey) {
    if (!serviceAccountKey) {
        return null;
    }
    try {
        return JSON.parse(serviceAccountKey).project_id || null;
    } catch {
        return null;
    }
}

class GoogleTranslatePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);

        this.translationModel = model.translationModel || model.params?.translationModel;
        this.isTranslateLlm = this.translationModel === TRANSLATE_LLM_MODEL;
        const serviceAccountProjectId = getServiceAccountProjectId(this.config.get('gcpServiceAccountKey'));
        this.projectId = serviceAccountProjectId || this.environmentVariables.GOOGLE_CLOUD_PROJECT_ID;
        this.location = this.isTranslateLlm
            ? model.location || model.params?.location || 'global'
            : this.environmentVariables.GOOGLE_CLOUD_LOCATION || 'global';
        this.apiKey = this.isTranslateLlm
            ? ''
            : this.environmentVariables.GOOGLE_CLOUD_API_KEY;

        if (this.isTranslateLlm && !this.projectId) {
            throw new Error('Google TranslateLLM requires a project_id in the configured GCP service account.');
        }
        if (!this.isTranslateLlm && !this.projectId && !this.apiKey) {
            throw new Error('Google Cloud Translation requires GOOGLE_CLOUD_API_KEY, GOOGLE_CLOUD_PROJECT_ID, or a project_id in GCP_SERVICE_ACCOUNT_KEY.');
        }

        this.mimeType = model.mimeType || model.params?.mimeType || 'text/plain';
        this.gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
    }

    normalizeLanguageCode(languageCode) {
        if (!languageCode || typeof languageCode !== 'string') {
            return languageCode;
        }
        return LANGUAGE_CODE_MAP[languageCode] || languageCode;
    }

    getTranslationModelPath(modelName = this.translationModel) {
        if (!modelName) {
            return null;
        }
        if (modelName.startsWith('projects/')) {
            return modelName;
        }
        return `projects/${this.projectId}/locations/${this.location}/models/${modelName}`;
    }

    getVertexHost() {
        return this.location === 'global'
            ? 'aiplatform.googleapis.com'
            : `${this.location}-aiplatform.googleapis.com`;
    }

    validateTranslateRequest(text, parameters) {
        if (!text || typeof text !== 'string' || text.trim().length === 0) {
            throw new Error('Google Translate requires non-empty text.');
        }
        if (!parameters.to || typeof parameters.to !== 'string') {
            throw new Error('Google Translate requires a target language code.');
        }
        if (this.isTranslateLlm && !this.projectId) {
            throw new Error('Google TranslateLLM requires a project_id in the configured GCP service account.');
        }
    }

    // Set up parameters specific to the Google Translate API
    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);
        const targetLanguageCode = this.normalizeLanguageCode(combinedParameters.to);
        const sourceLanguageCode = this.normalizeLanguageCode(combinedParameters.from);

        this.validateTranslateRequest(modelPromptText, {
            ...combinedParameters,
            to: targetLanguageCode,
        });


        const requestParameters = {
            data: {
                q: [modelPromptText],
                target: targetLanguageCode
            },
            params: {}
        };

        // Add source language if provided and not 'auto'
        if (sourceLanguageCode && sourceLanguageCode !== 'auto') {
            requestParameters.data.source = sourceLanguageCode;
        }

        if (this.apiKey) {
            requestParameters.params.key = this.apiKey;
            if (this.translationModel) {
                requestParameters.data.model = this.translationModel;
            }
        } else if (this.isTranslateLlm) {
            requestParameters.data.mimeType = this.mimeType;
            requestParameters.data.model = this.getTranslationModelPath();
        } else {
            requestParameters.data.parent = `projects/${this.projectId}/locations/${this.location}`;
            requestParameters.data.mimeType = this.mimeType;
        }

        return requestParameters;
    }

    // Execute the request to the Google Translate API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        if (this.apiKey) {
            cortexRequest.url = 'https://translation.googleapis.com/language/translate/v2';
            cortexRequest.method = 'POST';
            cortexRequest.data = requestParameters.data;
            cortexRequest.params = requestParameters.params;
            cortexRequest.headers = {
                'Content-Type': 'application/json'
            };
        } else if (this.isTranslateLlm) {
            const instance = {
                contents: requestParameters.data.q,
                target_language_code: requestParameters.data.target,
                mimeType: requestParameters.data.mimeType,
                model: requestParameters.data.model,
            };
            if (requestParameters.data.source) {
                instance.source_language_code = requestParameters.data.source;
            }

            cortexRequest.method = 'POST';
            cortexRequest.headers = {
                'Content-Type': 'application/json'
            };
            cortexRequest.auth = cortexRequest.auth || {};
            cortexRequest.auth.Authorization = `Bearer ${await this.getAccessToken()}`;

            cortexRequest.url = `https://${this.getVertexHost()}/v1/projects/${this.projectId}/locations/${this.location}/publishers/google/models/cloud-translate-text:predict`;
            cortexRequest.data = {
                instances: [instance]
            };
            logger.info(
                `[Google TranslateLLM] endpoint=cloud-translate-text:predict host=${this.getVertexHost()} location=${this.location} target=${instance.target_language_code} source=${instance.source_language_code || 'auto'} mimeType=${instance.mimeType} model=${this.translationModel}`,
            );
        } else {
            const data = {
                contents: requestParameters.data.q,
                targetLanguageCode: requestParameters.data.target,
                mimeType: requestParameters.data.mimeType,
            };
            if (requestParameters.data.source) {
                data.sourceLanguageCode = requestParameters.data.source;
            }

            cortexRequest.url = `https://translation.googleapis.com/v3/projects/${this.projectId}/locations/${this.location}:translateText`;
            cortexRequest.method = 'POST';
            cortexRequest.data = data;
            cortexRequest.headers = {
                'Content-Type': 'application/json'
            };
            cortexRequest.auth = cortexRequest.auth || {};
            cortexRequest.auth.Authorization = `Bearer ${await this.getAccessToken()}`;
        }

        return this.executeRequest(cortexRequest);
    }

    // Get access token for OAuth authentication
    async getAccessToken() {
        if (!this.gcpAuthTokenHelper) {
            throw new Error('Google Cloud OAuth requires GCP_SERVICE_ACCOUNT_KEY.');
        }
        return this.gcpAuthTokenHelper.getAccessToken();
    }

    // Parse the response from the Google Translate API
    parseResponse(data) {
        const parseTranslation = (translation) => decodeHTML(translation.trim());
        // Handle v2 API response
        if (data && data.data && data.data.translations) {
            return parseTranslation(data.data.translations[0].translatedText);
        }
        // Handle v3 API response
        else if (data && data.translations) {
            return parseTranslation(data.translations[0].translatedText);
        } else if (data && data.predictions && data.predictions[0]?.translations) {
            return parseTranslation(data.predictions[0].translations[0].translatedText);
        } else {
            return data;
        }
    }

    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        const modelInput = data.q
            ? data.q[0]
            : (data.contents ? data.contents[0] : data.instances?.[0]?.contents?.[0] || '');
        const translatedText = this.parseResponse(responseData);

        const requestLength = this.getLength(modelInput || '');
        logger.info(`[Google Translate request sent containing ${requestLength.length} ${requestLength.units}]`);
        const responseLength = this.getLength(translatedText || '');
        logger.info(`[Google Translate response received containing ${responseLength.length} ${responseLength.units}]`);

        if (prompt?.debugInfo) {
            prompt.debugInfo += `\nInput: ${modelInput}\nOutput: ${translatedText}`;
        }
    }
}

export default GoogleTranslatePlugin;
