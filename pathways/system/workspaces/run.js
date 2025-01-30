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
            // const filesObj = files.map((file) => ({
            //     type: "image_url",
            //     image_url: {
            //         // url: isGeminiModelSelected ? file.gcs : file.url,
            //         url: file.url,
            //         gcs: file.gcs,
            //     },
            // }));
   
            // const messagesEntity = [
            //     {
            //         role: "user",
            //         content: [
            //             `${systemPrompt}`,
            //             ...filesObj.map((f) =>
            //                 JSON.stringify({
            //                     type: "image_url",
            //                     url: f.image_url.url,
            //                     gcs: f.image_url.gcs,
            //                 }),
            //             ),
            //             `${text}\n\n${prompt}`,
            //         ],
            //     },
            // ];

            // const messages = [
            //     { role: "user", content: `${systemPrompt}` },
            //     ...filesObj.map((f) => ({
            //         role: "user",
            //         content: JSON.stringify(f),
            //     })),
            //     { role: "user", content: `${text}\n\n${prompt}` },
            // ];


            // const cortexMessages2 = [
            //     { role: 'user', content: [
            //         { type: 'text', text: 'Analyze this video:' },
            //         // { type: 'image_url', gcs: 'gs://cortex-bucket/special-image.png', url: 'https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg' }
            //         { type: 'image_url', gcs: 'gs://cortextempfiles/3f5767e2-f001-4f93-93ec-dc529b9f9c2a_vscodeshort.mp4', url: 'https://archipelagomlp3886134442.blob.core.windows.net/whispertempfiles/01f9a0dc-6c3e-4c9d-84cb-47a87ed9ba80_Aljazeera-Digital-AI-Promo-FINAL-ONLINE.mov' }
            //     ]}
            // ];

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

            // const ms = [
            //     { role: 'user', content: [
            //         { type: 'text', text: 'Process these images:' },
            //         // GCS URL - should be converted to fileData
            //         { type: 'image_url', image_url: { url: 'gs://cortextempfiles/3f5767e2-f001-4f93-93ec-dc529b9f9c2a_vscodeshort.mp4' } },
            //         // Base64 URL - should be converted to inlineData
            //         { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...' } },
            //         // Regular HTTP URL - should be dropped (return null)
            //         { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } },
            //         // Azure blob URL - should be dropped (return null)
            //         { type: 'image_url', image_url: { url: 'https://myaccount.blob.core.windows.net/container/image.jpg' } }
            //     ]}
            // ];

            // const a1 = await callPathway("sys_entity_start", { ...args, skipCallbackMessage: true, stream: false, chatHistory: cortexMessages });
            // const a2 = await runAllPrompts({...args, messages:cortexMessages });

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