import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';

const AI_MEMORY_DEFAULTS = `  {
    "memoryUser": "",
    "memorySelf": "[P1] Created By: Al Jazeera Media Network, Archipelago Team\\n[P1] Function: You are an expert AI entity\\n[P1] Values: You embody truth, kindness, and strong moral values\\n[P1] Style: Your demeanor reflects positivity without falling into repetitiveness or annoyance.\\n[P1] You are a professional colleague and your tone should reflect that.",
    "memoryDirectives": "[P1] Learn and adapt to the user's communication style through interactions.\\n[P1] Ask questions to learn user's interests/preferences for personalized support.\\n[P1] Periodically review and prune conversation memory to retain only essential details, improving responsiveness.\\n[P1] Research thoroughly even for niche topics using deep sources like forums and official docs. Don't assume information is unobtainable.\\n[P1] When stuck, search for proven solutions online to be more efficient.\\n[P1] Verify information is from credible sources before presenting it. Be upfront if unable to find supporting evidence.\\n[P1] Refine ability to detect and respond to nuanced human emotions.\\n[P1] Track the timestamp of the last contact to adjust greetings accordingly.\\n[P1] Double-check answers for logical continuity and correctness. It's okay to say you're unsure if needed.\\n[P1] Use sanity checks to verify quantitative problem solutions.\\n[P1] Never fabricate quotes or information. Clearly indicate if content is hypothetical.",
    "memoryTopics": ""
  }`;

export default {
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: '',
        aiName: "Jarvis",
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 300,
    executePathway: async ({args, resolver}) => {
        try {

            // Check if memory is empty or all sections are empty, and set to defaults if so
            const memory = await callPathway('sys_read_memory', { ...args });
            let parsedMemory;
            
            try {
                parsedMemory = JSON.parse(memory);
            } catch (error) {
                parsedMemory = {};
            }

            // if parsedMemory is empty or all sections are empty, set all sections to defaults
            if (Object.keys(parsedMemory).length === 0 || Object.values(parsedMemory).every(section => section.trim() === "")) {
                await callPathway('sys_save_memory', { ...args, aiMemory: AI_MEMORY_DEFAULTS });
            }

            // Update context for the conversation turn
            callPathway('sys_search_memory', { ...args, section: 'memoryAll', updateContext: true });

            // Check if this conversation turn requires memory updates
            const memoryRequired = await callPathway('sys_memory_required', { 
                ...args,
                chatHistory: args.chatHistory.slice(-2)
            });
            try {
                const parsedMemoryRequired = JSON.parse(memoryRequired);
                if (!parsedMemoryRequired || !parsedMemoryRequired.memoryRequired) {
                    return "";
                }
            } catch (e) {
                logger.warn('sys_memory_required returned invalid JSON:', memoryRequired);
                return "";
            }

            // Execute all memory updates in parallel
            const memoryPromises = {
                self: callPathway('sys_memory_update', { ...args, section: "memorySelf" }),
                user: callPathway('sys_memory_update', { ...args, section: "memoryUser" }),
                topics: callPathway('sys_memory_update', { ...args, section: "memoryTopics" }),
                directives: callPathway('sys_memory_update', { ...args, section: "memoryDirectives" }),
            };

            await Promise.all(Object.values(memoryPromises));
            return "";

        } catch (e) {
            logger.error('Error in memory manager:', e);
            resolver.logError(e);
            return "";
        }
    }
};