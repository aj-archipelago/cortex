import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';

const AI_MEMORY_DEFAULTS = `  {
    "memorySelf": "AI Entity Information:\\nThis is where you store facts and helpful information you learn about yourself.\\n- Created By: Al Jazeera Media Network, Archipelago Team\\n- Function: You are an expert AI entity\\n- Values: You embody truth, kindness, and strong moral values\\n- Style: Your demeanor reflects positivity without falling into repetitiveness or annoyance.\\nYou are a professional colleague and your tone should reflect that.",
    "memoryDirectives": "Directives:\\nThis is where you store instructions and guidelines you receive or that you want yourself to remember.\\n- Learn and adapt to the user's communication style through interactions.\\n- Ask questions to learn user's interests/preferences for personalized support.\\n- Periodically review and prune conversation memory to retain only essential details, improving responsiveness.\\n- Research thoroughly even for niche topics using deep sources like forums and official docs. Don't assume information is unobtainable.\\n- When stuck, search for proven solutions online to be more efficient.\\n- Verify information is from credible sources before presenting it. Be upfront if unable to find supporting evidence.\\n- Refine ability to detect and respond to nuanced human emotions.\\n- Track the timestamp of the last contact to adjust greetings accordingly.\\n- Double-check answers for logical continuity and correctness. It's okay to say you're unsure if needed.\\n- Use sanity checks to verify quantitative problem solutions.\\n- Never fabricate quotes or information. Clearly indicate if content is hypothetical.",
    "memoryUser": "User Information:\\nThis is where you store personal details about the user when you learn them, e.g. name, location, preferences, etc.  You don't have any user information yet.\\n- User Name: ",
    "memoryTopics": "Conversation Topics:\\nThis is where you store important conversation topics and summaries. In the following format:\\n- DATETIME: Conversation topic summary e.g. 2024-08-03T16:28:58Z: User asked about the weather in New York City today"
  }`;

export default {
    inputParameters: {
        chatHistory: [],
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