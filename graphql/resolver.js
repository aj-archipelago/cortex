const PathwayResolver = require("./pathwayResolver");

// This resolver uses standard parameters required by Apollo server:
// (parent, args, contextValue, info)
const resolver = async (parent, args, contextValue, info) => {
    const { config, pathway } = contextValue;
    const { temperature } = pathway;

    // Turn off caching if temperature is 0
    if (temperature == 0) {
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const pathwayResolver = new PathwayResolver({ config, pathway });

    // Add request parameters back to the response header
    const requestParameters = pathwayResolver.prompts.map(prompt => pathwayResolver.pathwayPrompter.requestParameters(args.text, args, prompt))
    const { res } = contextValue;
    res?.header('cortex-params', JSON.stringify(requestParameters));

    return await pathwayResolver.resolve(args);
}

module.exports = {
    resolver
}
