import { Prompt } from "../../../server/prompt.js" 
import { callPathway } from '../../../lib/pathwayTools.js';

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    inputParameters: {
        prompt: "",
        text: "",
        systemPrompt: "",
        model: '',
        contextId: ``,
        files: [""],
        systemFiles: [""],
    },
    timeout: 3000,
    executePathway: async ({args, resolver, runAllPrompts}) => {
        try{
            // args.model = 'gemini-flash-20-vision';
            const { model="gpt-4o", text, prompt, systemPrompt="Assistant is an expert assistant. When a user posts a request, Assistant will come up with the best response while upholding the highest standards." } = args;

            // const isGeminiModelSelected = model.startsWith("gemini");
            const isEntityModelSelected = model.startsWith("entity") || model.startsWith("sys_entity") || model.startsWith("labeeb");

        
            // Filter files to exclude those with the skip field set to true
            const systemFiles = (args?.systemFiles || []).map(f => JSON.parse(f)).filter((file) => !file.skip);
            const files = (args?.files || []).map(f => JSON.parse(f)).filter((file) => !file.skip);

            const cortexMessages = [
                {
                    role: 'system',
                    content: systemPrompt
                },
                { 
                    role: 'user', 
                    content: [
                        { type: 'text', text: `${text}\n\n${prompt}` },
                        ...[...systemFiles,...files].map(file => ({
                            type: 'image_url',
                            url: file.url,
                            gcs: file.gcs
                        }))
                    ]
                }
            ];

            if (isEntityModelSelected) {
                return await callPathway("sys_entity_start", { ...args, skipCallbackMessage: true, stream: false, chatHistory: cortexMessages });
            }
            
            const result = await runAllPrompts({...args, messages:cortexMessages });
            return result;
        } catch (error) {
            return JSON.stringify({
                status: "error",
                message: "Failed to run the pathway",
                error: error.message
            }, null, 2);
        }
    }
}