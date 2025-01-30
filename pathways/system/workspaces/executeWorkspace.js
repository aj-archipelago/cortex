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
        model: '',
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
                result = await callPathway("run", {...userPathway,...args, prompt, text: args.text + '\n\n' + result, systemFiles: userPathway.files });
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