import { fulfillWithTimeout } from '../lib/promiser.js';
import { PathwayResolver } from './pathwayResolver.js';
import CortexResponse from '../lib/cortexResponse.js';
import { withRequestLoggingDisabled } from '../lib/logger.js';

// This resolver uses standard parameters required by Apollo server:
// (parent, args, contextValue, info)
const rootResolver = async (parent, args, contextValue, info) => {
    const { config, pathway } = contextValue;
    const { temperature, enableGraphqlCache } = pathway;

    // Turn on graphql caching if enableGraphqlCache true and temperature is 0
    if (enableGraphqlCache && temperature == 0) { // || 
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const pathwayResolver = new PathwayResolver({ config, pathway, args });
    contextValue.pathwayResolver = pathwayResolver;

    // Execute the request with timeout
    let result = null;

    try {
        const execWithTimeout = () => fulfillWithTimeout(pathway.resolver(parent, args, contextValue, info), pathway.timeout);
        if (pathway.requestLoggingDisabled === true) {
            result = await withRequestLoggingDisabled(() => execWithTimeout());
        } else {
            result = await execWithTimeout();
        }
    } catch (error) {
        pathwayResolver.logError(error);
        result = error.message || error.toString();
    }

    if (result instanceof CortexResponse) {
        // Use the smart mergeResultData method that handles CortexResponse objects
        pathwayResolver.pathwayResultData = pathwayResolver.mergeResultData(result);
        result = result.output_text;
    }

    let resultData = pathwayResolver.pathwayResultData ? JSON.stringify(pathwayResolver.pathwayResultData) : null;
    
    const { warnings, errors, previousResult, savedContextId, tool } = pathwayResolver;    

    // Add request parameters back as debug
    const debug = pathwayResolver.prompts.map(prompt => prompt.debugInfo || '').join('\n').trim();
    
    return { 
        debug, 
        result, 
        resultData,
        warnings, 
        errors, 
        previousResult, 
        tool, 
        contextId: savedContextId 
    }
}

// This resolver is used by the root resolver to process the request
const resolver = async (parent, args, contextValue, _info) => {
    const { pathwayResolver } = contextValue;
    return await pathwayResolver.resolve(args);
}

const cancelRequestResolver = (parent, args, contextValue, _info) => {
    const { requestId } = args;
    const { requestState } = contextValue;
    requestState[requestId] = { canceled: true };
    return true
}

export {
    resolver, rootResolver, cancelRequestResolver
};
