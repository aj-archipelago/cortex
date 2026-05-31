import { config } from '../../../config.js';
import { chatArgsHasImageUrl, chatArgsHasType, removeOldImageAndFileContent } from '../../../lib/util.js';
import { loadEntityConfig } from '../../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import { Prompt } from '../../../server/prompt.js';

export default {
    emulateOpenAIChatModel: 'cortex-agent',
    useInputChunking: false,
    useSingleTokenStream: false,

    inputParameters: {
        prompt: "",
        systemPrompt: "",
        chatHistory: [{role: '', content: []}],
        fileAccessPlan: {
            type: 'array',
            items: { objType: 'FileAccessTargetInput' },
            default: [],
        },
        text: "",
        entityId: "jarvis",
        aiName: "Jarvis",
        language: "English",
        model: "oai-gpt41", // Allow user to specify model
        reasoningEffort: "",
    },

    timeout: 600,

    executePathway: async ({args, runAllPrompts, resolver}) => {
        let pathwayResolver = resolver;

        // Load input parameters and information into args
        const { entityId, aiName, language, model } = { ...pathwayResolver.pathway.inputParameters, ...args };
        
        const entityConfig = await loadEntityConfig(entityId);

        // Initialize chat history if needed
        if (!args.chatHistory || args.chatHistory.length === 0) {
            args.chatHistory = [];
        }

        // Limit the chat history to 20 messages to speed up processing
        args.chatHistory = args.chatHistory.slice(-20);

        // Add entity constants for template rendering
        args = {
            ...args,
            ...config.get('entityConstants'),
            entityId,
            aiName,
            language,
            model
        };

        // Check for both image and file content (CSV files have type 'file', not 'image_url')
        const hasImageContent = chatArgsHasImageUrl(args);
        const hasFileContent = chatArgsHasType(args, 'file');
        const visionContentPresent = hasImageContent || hasFileContent;

        // Remove old image and file content while preserving the latest uploads
        visionContentPresent && (args.chatHistory = removeOldImageAndFileContent(args.chatHistory));

        const promptMessages = [
            {"role": "system", "content": `${args.systemPrompt || "Assistant is a helpful AI assistant. When a user posts a request, Assistant will come up with the best response."}\n\n{{renderTemplate AI_TOOLS}}\n\n{{renderTemplate AI_DATETIME}}`},
            "{{chatHistory}}"
        ];

        // Only add a user message if there's actual text or prompt content
        const userContent = `${args.text || ""}\n\n${args.prompt || ""}`.trim();
        if (userContent) {
            promptMessages.push({"role": "user", "content": userContent});
        }

        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: promptMessages }),
        ];

        pathwayResolver.args = {...args};

        try {
            let currentMessages = JSON.parse(JSON.stringify(args.chatHistory));

            let response = await runAllPrompts({
                ...args,
                chatHistory: currentMessages,
                model: args.model // Pass the model from args
            });

            return response;

        } catch (e) {
            pathwayResolver.logError(e);
            throw e;
        }
    }
};
