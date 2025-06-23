import { Prompt } from "../../../server/prompt.js" 
import { callPathway } from '../../../lib/pathwayTools.js';
import { config } from "../../../config.js";

export default {
    prompt: '',
    // [
    //     new Prompt({ messages: [
    //         "{{messages}}",
    //     ]}),
    // ],
    inputParameters: {
        prompt: "",
        text: "",
        systemPrompt: "",
        contextId: ``,
        files: [""],
        pathwayName: "", 
        userId: "",
    },
    timeout: 6000,
    executePathway: async ({args, resolver, runAllPrompts}) => {
        try{
            const { pathwayName, userId } = args;
            const { pathwayManager } = config;
            if(!pathwayManager) {
                throw new Error("Pathway manager not found");
            }
            const userPathway = await pathwayManager.getPathway(userId, pathwayName);
            if(!userPathway) {
                throw new Error("Pathway not found");
            }

            let result = "";

            for(const prompt of userPathway.prompt) {
                let promptText = prompt;
                let modelOverride = args.model || userPathway.model;
                //check if prompt is an stringified object
                try {
                    if(typeof prompt === 'string') {
                        const promptObj = JSON.parse(prompt);
                        promptText = promptObj.text || promptText;
                        modelOverride = promptObj.model || modelOverride;
                    }    
                } catch (error) {
                    // do nothing
                }
                
                result = await callPathway("run", {...userPathway,...args, 
                    text: args.text + '\n\n' + result, 
                    systemFiles: userPathway.files, 
                    model: modelOverride, 
                    prompt: promptText 
                });
            }

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