// Azure Cognitive Services plugin for the server
import { callPathway } from '../../lib/pathwayTools.js';
import ModelPlugin from './modelPlugin.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { config } from '../../config.js';
import { axios } from '../../lib/requestExecutor.js';
import logger from '../../lib/logger.js';
import { getSemanticChunks } from '../chunker.js';

const API_URL = config.get('whisperMediaApiUrl');

const TOP = 1000;

let DIRECT_FILE_EXTENSIONS = [".txt", ".json", ".csv", ".md", ".xml", ".js", ".html", ".css"];

class AzureCognitivePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    async getInputVector (text) {
        try{
            if(!text || !text.trim()){
                return;
            }
            return JSON.parse(await callPathway('embeddings', { text }))[0];
        }catch(err){
            logger.error(`Error in calculating input vector for text: ${text}, error: ${err}`);
        }
    }

    // Set up parameters specific to the Azure Cognitive API
    async getRequestParameters(text, parameters, prompt, mode, indexName, savedContextId, cortexRequest) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, combinedParameters, prompt);
        const { inputVector, calculateInputVector, privateData, filter, docId } = combinedParameters;
        const data = {};

        if (mode == 'delete') {
            let searchUrl = this.ensureMode(this.requestUrl(text), 'search');
            searchUrl = this.ensureIndex(searchUrl, indexName);
            let searchQuery = `owner:${savedContextId}`;
            
            if (docId) {
                searchQuery += ` AND docId:'${docId}'`;
            }

            cortexRequest.url = searchUrl;
            cortexRequest.data =
            { search: searchQuery,  
                "searchMode": "all",
                "queryType": "full",
                select: 'id', top: TOP 
            };

            const docsToDelete = JSON.parse(await this.executeRequest(cortexRequest));
        
            const value = docsToDelete.value.map(({id}) => ({
                id,
                "@search.action": "delete"
            }));
        
            return {
                data: {
                    value
                }
            };
        }

        if (mode == 'index') {

            const doc = {
                id: uuidv4(),
                content: text,
                owner: savedContextId,
                docId: docId || uuidv4(),
                createdAt: new Date().toISOString()
            }

            if(inputVector || calculateInputVector){ //if input vector is provided or needs to be calculated
                doc.contentVector = inputVector ? inputVector : await this.getInputVector(text);
            }

            if(!privateData){ //if public, remove owner
                delete doc.owner;
            }
            
            data.value = [doc];
            return { data };
        }

        //default mode, 'search'
        if (inputVector) {
            data.vectors = [
                {
                    "value": typeof inputVector === 'string' ? JSON.parse(inputVector) : inputVector,
                    "fields": "contentVector",
                    "k": 20
                }
            ];
        } else {
            data.search = modelPromptText;
        }

        filter && (data.filter = filter);
        if (indexName == 'indexcortex') { //if private, filter by owner via contextId //privateData && 
            data.filter && (data.filter = data.filter + ' and ');
            data.filter = `owner eq '${savedContextId}'`;
        }

        return { data };
    }

    ensureMode(url, mode) {
        const pattern = new RegExp(`indexes\/.*\/docs\/${mode}`);
        if (pattern.test(url)) {
            // if the URL is already in the correct form, return it as is
            return url;
        } else {
            // otherwise, perform the replacement
            return url.replace(/(indexes\/.*\/docs\/)([^?]+)/, `$1${mode}`);
        }
    }

    ensureIndex(url, indexName) {
        const pattern = new RegExp(`indexes\/${indexName}\/docs\/search`);
        if (pattern.test(url)) {
            // if the URL is already in the correct form, return it as is
            return url;
        } else {
            // otherwise, perform the replacement
            return url.replace(/(indexes\/)([^\/]+)/, `$1${indexName}`);
        }
    }

    async markCompletedForCleanUp(requestId) {
        try {
            if (API_URL) {
                //call helper api to mark processing as completed
                const res = await axios.delete(API_URL, { params: { requestId } });
                logger.info(`Marked request ${requestId} as completed: ${res.data}`);
                return res.data;
            }
        } catch (err) {
            logger.error(`Error marking request ${requestId} as completed: ${err}`);
        }
    }

    // Execute the request to the Azure Cognitive API
    async execute(text, parameters, prompt, cortexRequest) {
        const { requestId, savedContextId, savedContext } = cortexRequest.pathwayResolver;
        const mode = this.promptParameters.mode || 'search';
        let url = this.ensureMode(this.requestUrl(text), mode == 'delete' ? 'index' : mode);
        const indexName = parameters.indexName || 'indexcortex';
        url = this.ensureIndex(url, indexName);
        const headers = cortexRequest.headers;

        const { file } = parameters;
        const fileData = { value: [] };
        if(file){ 
            let url = file;
            //if not txt file, use helper app to convert to txt
            const extension = path.extname(file).toLowerCase();
            if (!DIRECT_FILE_EXTENSIONS.includes(extension)) {
                try {
                    const { data }  = await axios.get(API_URL, { params: { uri: file, requestId, save: true } });
                    url = data[0];
                } catch (error) {
                    logger.error(`Error converting file ${file} to txt: ${error}`);
                    await this.markCompletedForCleanUp(requestId);
                    throw Error(error?.response?.data || error?.message || error);
                }
            }
 
            const { data } = await axios.get(url);
            await this.markCompletedForCleanUp(requestId);

            if(!data){
                throw Error(`No data can be extracted out of file!`);
            }

            const chunkTokenLength = this.promptParameters.inputChunkSize || 1000;
            const chunks = getSemanticChunks(data, chunkTokenLength);

            for (const text of chunks) {
                const { data: singleData } = await this.getRequestParameters(text, parameters, prompt, mode, indexName, savedContextId, cortexRequest) 
                fileData.value.push(singleData.value[0]);
            }
        }

        const { data, params } = await this.getRequestParameters(text, parameters, prompt, mode, indexName, savedContextId, cortexRequest);

        // update contextid last used
        savedContext["lastUsed"] = new Date().toISOString();

        if (mode === 'delete' && data.value.length == 0){
            return; // nothing to delete
        }

        // execute the request
        cortexRequest.url = url;
        cortexRequest.data = (mode === 'index' && fileData.value.length>0) ? fileData : data;
        cortexRequest.params = params;
        cortexRequest.headers = headers;
        const result = await this.executeRequest(cortexRequest);

        // if still has more to delete
        if (mode === 'delete' && data?.value?.length == TOP) { 
            return await this.execute(text, parameters, prompt, cortexRequest);
        }
        
        return result;
    }

    parseResponse(data) {
        return JSON.stringify(data || {});
    }

}

export default AzureCognitivePlugin;
