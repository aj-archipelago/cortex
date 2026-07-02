// rest/processRestRequest.js
// Core GraphQL executor for REST pathway requests

import logger from '../../lib/logger.js';

const processRestRequest = async (server, req, pathway, name, parameterMap = {}) => {
    const fieldVariableDefs = pathway.typeDef(pathway).restDefinition || [];

    const convertType = (value, type) => {
        if (type === 'Boolean') {
            return Boolean(value);
        } else if (type === 'Int') {
            return parseInt(value, 10);
        } else if (type === 'Float') {
            return parseFloat(value);
        } else if (type === '[MultiMessage]' && Array.isArray(value)) {
            return value.map(msg => ({
                ...msg,
                // These conversions are intended to pass-through already stringified objects or stringify objects as necessary
                // In some cases this can result in invalid content blocks (e.g. arrays of strings) - but that is handled in the plugins
                content: Array.isArray(msg.content) ?
                    msg.content.map(item => typeof item === 'string' ? item : JSON.stringify(item)) :
                    msg.content,
                tool_calls: Array.isArray(msg.tool_calls) ?
                    msg.tool_calls.map(tc => typeof tc === 'string' ? tc : JSON.stringify(tc)) :
                    msg.tool_calls
            }));
        } else if (type === '[String]' && Array.isArray(value)) {
            return value;
        } else {
            return value;
        }
    };

    const variables = fieldVariableDefs.reduce((acc, variableDef) => {
        const requestBodyParamName = Object.keys(parameterMap).includes(variableDef.name)
            ? parameterMap[variableDef.name]
            : variableDef.name;

        if (Object.prototype.hasOwnProperty.call(req.body, requestBodyParamName)) {
            acc[variableDef.name] = convertType(req.body[requestBodyParamName], variableDef.type);
        }
        return acc;
    }, {});

    // Add tools to variables if they exist in the request
    if (req.body.tools && Array.isArray(req.body.tools) && req.body.tools.length > 0) {
        variables.tools = JSON.stringify(req.body.tools);
    }

    if (req.body.tool_choice) {
        variables.tool_choice = typeof req.body.tool_choice === 'string' ? req.body.tool_choice : JSON.stringify(req.body.tool_choice);
    }

    // Add functions to variables if they exist in the request (legacy function calling)
    if (req.body.functions) {
        variables.functions = JSON.stringify(req.body.functions);
    }

    if (req.body.function_call) {
        variables.function_call = typeof req.body.function_call === 'string' ? req.body.function_call : JSON.stringify(req.body.function_call);
    }

    // Map reasoning_effort to reasoningEffort (OpenAI uses snake_case, we use camelCase)
    if (req.body.reasoning_effort) {
        variables.reasoningEffort = req.body.reasoning_effort;
    }

    // Map Anthropic thinking controls
    if (req.body.thinking) {
        if (req.body.thinking.type) {
            variables.thinkingType = req.body.thinking.type;
        }
        if (req.body.thinking.budget_tokens) {
            variables.thinkingBudgetTokens = req.body.thinking.budget_tokens;
            // Also infer reasoningEffort from budget_tokens if not already set
            if (!variables.reasoningEffort) {
                // Map budget_tokens to effort level: low < 5000, medium < 8000, high >= 8000
                const budget = req.body.thinking.budget_tokens;
                if (budget >= 8000) {
                    variables.reasoningEffort = 'high';
                } else if (budget >= 5000) {
                    variables.reasoningEffort = 'medium';
                } else {
                    variables.reasoningEffort = 'low';
                }
            }
        }
    }

    // Map Anthropic output_config.effort to reasoningEffort
    if (req.body.output_config?.effort && !variables.reasoningEffort) {
        variables.reasoningEffort = req.body.output_config.effort;
    }

    const variableParams = fieldVariableDefs.map(({ name, type }) => `$${name}: ${type}`).join(', ');
    const queryArgs = fieldVariableDefs.map(({ name }) => `${name}: $${name}`).join(', ');

    const query = `
            query ${name}(${variableParams}) {
                    ${name}(${queryArgs}) {
                        contextId
                        previousResult
                        result
                        resultData
                        tool
                        warnings
                        errors
                        debug
                    }
                }
            `;

    // Debug: Log the variables being passed
    logger.debug(`REST endpoint variables: ${JSON.stringify(variables, null, 2)}`);
    logger.debug(`REST endpoint query: ${query}`);

    const result = await server.executeOperation({ query, variables });

    // if we're streaming and there are errors, we return a standard error code
    if (Boolean(req.body.stream)) {
        if (result?.body?.singleResult?.errors) {
            return `[ERROR] ${result.body.singleResult.errors[0].message.split(';')[0]}`;
        }
    }

    // For non-streaming, return both result and tool fields
    const pathwayData = result?.body?.singleResult?.data?.[name];
    if (pathwayData) {
        return {
            result: pathwayData.result || "",
            resultData: pathwayData.resultData || null,
            tool: pathwayData.tool || null,
            errors: pathwayData.errors || null,
            warnings: pathwayData.warnings || null
        };
    }

    // If no pathway data, return error message
    const errorMessage = result?.body?.singleResult?.errors?.[0]?.message || "";
    return {
        result: errorMessage,
        resultData: null,
        tool: null,
        errors: errorMessage ? [errorMessage] : null,
        warnings: null
    };
};

export { processRestRequest };
