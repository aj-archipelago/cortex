const { fulfillWithTimeout } = require("../lib/promiser");
const { PathwayResolver } = require("./pathwayResolver");

// This resolver uses standard parameters required by Apollo server:
// (parent, args, contextValue, info)
const rootResolver = async (parent, args, contextValue, info) => {
    const { config, pathway, requestState } = contextValue;
    const { temperature, enableGraphqlCache } = pathway;

    // Turn on graphql caching if enableGraphqlCache true and temperature is 0
    if (enableGraphqlCache && temperature == 0) { // || 
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const pathwayResolver = new PathwayResolver({ config, pathway, requestState });
    contextValue.pathwayResolver = pathwayResolver;

    // Add request parameters back as debug
    const requestParameters = pathwayResolver.prompts.map((prompt) => pathwayResolver.pathwayPrompter.requestParameters(args.text, args, prompt));
    const debug = JSON.stringify(requestParameters);

    // Execute the request with timeout
    const result = await fulfillWithTimeout(pathway.resolver(parent, args, contextValue, info), pathway.timeout);
    const { warnings, previousResult, savedContextId } = pathwayResolver;
    return { debug, result, warnings, previousResult, contextId: savedContextId }
}

// This resolver is used by the root resolver to process the request
const resolver = async (parent, args, contextValue, info) => {
    const { pathwayResolver } = contextValue;
    return await pathwayResolver.resolve(args);
}

const cancelRequestResolver = (parent, args, contextValue, info) => {
    const { requestId } = args;
    const { requestState } = contextValue;
    requestState[requestId] = { canceled: true };
    return true
}

module.exports = {
    resolver, rootResolver, cancelRequestResolver
}
