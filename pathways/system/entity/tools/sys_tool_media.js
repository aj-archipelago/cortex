import { mediaAgentToolDefinition } from '../../../../lib/mediaAgentTools.js';
import { executeAgentTool } from './sys_tool_colleague_management.js';

export default {
    prompt: [],
    model: 'oai-gpt41-mini',
    manageTokenLength: false,
    toolDefinition: mediaAgentToolDefinition,
    executePathway: ({ args }) => executeAgentTool(args, [mediaAgentToolDefinition]),
};
