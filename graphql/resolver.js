const { PathwayResolver } = require("./pathwayResolver");

// This resolver uses standard parameters required by Apollo server:
// (parent, args, contextValue, info)
const rootResolver = async (parent, args, contextValue, info) => {
    const { config, pathway } = contextValue;
    const { temperature } = pathway;

    // Turn off caching if temperature is 0
    if (temperature == 0) {
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const pathwayResolver = new PathwayResolver({ config, pathway });
    contextValue.pathwayResolver = pathwayResolver;

    // Add request parameters back as debug
    const requestParameters = pathwayResolver.prompts.map(prompt => pathwayResolver.pathwayPrompter.requestParameters(args.text, args, prompt))
    return { debug: JSON.stringify(requestParameters), result: await pathway.resolver(parent, args, contextValue, info) }
}

// This resolver is used by the root resolver to process the request
const resolver = async (parent, args, contextValue, info) => {
    const { requestState } = contextValue;
    const { pathwayResolver } = contextValue;

    return await pathwayResolver.resolve(args, requestState);
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
