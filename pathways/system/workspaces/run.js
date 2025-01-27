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
        systemPrompt: "Assistant is an expert assistant. When a user posts a request, Assistant will come up with the best response while upholding the highest standards.",
        model: 'gemini-flash-20-vision',
        contextId: ``,
        files: [""],
    },
    executePathway: async ({args, resolver, runAllPrompts}) => {
        try{
            const { model, text, prompt, systemPrompt } = args;

            const isGeminiModelSelected = model.startsWith("gemini");
            const isEntityModelSelected = model.startsWith("entity") || model.startsWith("sys_entity") || model.startsWith("labeeb");

        
            // Filter files to exclude those with the skip field set to true
            const files = (args?.files || []).map(f => JSON.parse(f)).filter((file) => !file.skip);
            const filesObj = files.map((file) => ({
                type: "image_url",
                image_url: {
                    url: isGeminiModelSelected ? file.gcs : file.url,
                    gcs: file.gcs,
                },
            }));
    
            if (isEntityModelSelected) {
                const messagesEntity = [
                    {
                        role: "user",
                        content: [
                            `${systemPrompt}`,
                            ...filesObj.map((f) =>
                                JSON.stringify({
                                    type: "image_url",
                                    url: f.image_url.url,
                                    gcs: f.image_url.gcs,
                                }),
                            ),
                            `${text}\n\n${prompt}`,
                        ],
                    },
                ];

                return await callPathway("sys_entity_start", { ...args, skipCallbackMessage: true, stream: false, chatHistory: messagesEntity });
            }
            
            const messages = [
                { role: "user", content: `${systemPrompt}` },
                ...filesObj.map((f) => ({
                    role: "user",
                    content: JSON.stringify(f),
                })),
                { role: "user", content: `${text}\n\n${prompt}` },
            ];

            const result = await runAllPrompts({...args, messages});



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