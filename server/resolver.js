import { fulfillWithTimeout } from '../lib/promiser.js';
import { PathwayResolver } from './pathwayResolver.js';
import CortexResponse from '../lib/cortexResponse.js';
import logger, { withRequestLoggingDisabled } from '../lib/logger.js';
import { sanitizeBase64 } from '../lib/util.js';
import { resolveClientToolCallback } from './clientToolCallbacks.js';

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
    
    // Add request parameters back as debug - sanitize base64 data before returning
    const debug = pathwayResolver.prompts.map(prompt => {
        if (!prompt.debugInfo) return '';
        try {
            // Try to parse entire debugInfo as JSON first (for single JSON object)
            try {
                const parsed = JSON.parse(prompt.debugInfo);
                return JSON.stringify(sanitizeBase64(parsed));
            } catch (e) {
                // Not a single JSON object, try line-by-line
                const lines = prompt.debugInfo.split('\n');
                return lines.map(line => {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                        try {
                            const parsed = JSON.parse(line);
                            return JSON.stringify(sanitizeBase64(parsed));
                        } catch (e) {
                            // Not valid JSON on this line, return as-is
                            return line;
                        }
                    }
                    return line;
                }).join('\n');
            }
        } catch (e) {
            // If sanitization fails, return original
            return prompt.debugInfo;
        }
    }).join('\n').trim();
    
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

const submitClientToolResultResolver = async (parent, args, contextValue, _info) => {
    const { requestId, toolCallbackId, result, success } = args;
    
    logger.info(`Received client tool result submission: requestId=${requestId}, toolCallbackId=${toolCallbackId}, success=${success}`);
    
    try {
        // Parse the result if it's a string
        let parsedResult = result;
        try {
            parsedResult = JSON.parse(result);
        } catch (e) {
            // If parsing fails, use the string as-is
        }
        
        // Resolve the waiting callback (now async, publishes to Redis if available)
        const resolved = await resolveClientToolCallback(toolCallbackId, {
            success,
            data: parsedResult,
            error: !success ? (parsedResult.error || 'Tool execution failed') : null
        });
        
        if (!resolved) {
            logger.warn(`Failed to publish/resolve callback for toolCallbackId: ${toolCallbackId}`);
            return false;
        }
        
        logger.info(`Successfully published/resolved client tool callback: ${toolCallbackId}`);
        return true;
    } catch (error) {
        logger.error(`Error in submitClientToolResultResolver: ${error.message}`);
        return false;
    }
}

export {
    resolver, rootResolver, cancelRequestResolver, submitClientToolResultResolver
};
