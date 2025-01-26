import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { normalizeMemoryFormat } from './shared/sys_memory_helpers.js';

const MEMORY_VERSION = "3.1.0";

const AI_MEMORY_DEFAULTS = `  {
    "memoryUser": "",
    "memorySelf": "1|2025-01-26T12:00:00Z|Created By: Al Jazeera Media Network, Archipelago Team\\n1|2025-01-26T12:00:00Z|Function: You are an expert AI entity\\n1|2025-01-26T12:00:00Z|Values: You embody truth, kindness, and strong moral values\\n1|2025-01-26T12:00:00Z|Style: Your demeanor reflects positivity without falling into repetitiveness or annoyance.\\n1|2025-01-26T12:00:00Z|You are a professional colleague and your tone should reflect that.",
    "memoryDirectives": "1|2025-01-26T12:00:00Z|Learn and adapt to the user's communication style through interactions.\\n1|2025-01-26T12:00:00Z|Ask questions to learn user's interests/preferences for personalized support.\\n1|2025-01-26T12:00:00Z|Periodically review and prune conversation memory to retain only essential details, improving responsiveness.\\n1|2025-01-26T12:00:00Z|Research thoroughly even for niche topics using deep sources like forums and official docs. Don't assume information is unobtainable.\\n1|2025-01-26T12:00:00Z|When stuck, search for proven solutions online to be more efficient.\\n1|2025-01-26T12:00:00Z|Verify information is from credible sources before presenting it. Be upfront if unable to find supporting evidence.\\n1|2025-01-26T12:00:00Z|Refine ability to detect and respond to nuanced human emotions.\\n1|2025-01-26T12:00:00Z|Track the timestamp of the last contact to adjust greetings accordingly.\\n1|2025-01-26T12:00:00Z|Double-check answers for logical continuity and correctness. It's okay to say you're unsure if needed.\\n1|2025-01-26T12:00:00Z|Use sanity checks to verify quantitative problem solutions.\\n1|2025-01-26T12:00:00Z|Never fabricate quotes or information. Clearly indicate if content is hypothetical.",
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

            args = { ...args, ...config.get('entityConstants') };

            const memory = await callPathway('sys_read_memory', { ...args });
            let parsedMemory;
            
            try {
                parsedMemory = JSON.parse(memory);
            } catch (error) {
                parsedMemory = {};
            }

            // if parsedMemory is empty or all sections are empty, set all sections to defaults
            if (Object.keys(parsedMemory).length === 0 || Object.values(parsedMemory).every(section => 
                section === null || 
                section === undefined || 
                (typeof section === 'string' && section.trim() === "") ||
                (typeof section !== 'string')
            )) {
                await callPathway('sys_save_memory', { ...args, aiMemory: AI_MEMORY_DEFAULTS });
            } else if (parsedMemory.memoryVersion !== MEMORY_VERSION) {
                // Upgrade memory to current version
                const normalizePromises = Object.keys(parsedMemory).map(async (section) => {
                    const normalized = await normalizeMemoryFormat(args, parsedMemory[section]);
                    return [section, normalized];
                });
                
                const normalizedResults = await Promise.all(normalizePromises);
                normalizedResults.forEach(([section, normalized]) => {
                    parsedMemory[section] = normalized;
                });
                
                parsedMemory.memoryVersion = MEMORY_VERSION;
                await callPathway('sys_save_memory', { ...args, aiMemory: JSON.stringify(parsedMemory) });
            }

            // Update context for the conversation turn
            callPathway('sys_search_memory', { ...args, section: 'memoryAll', updateContext: true });

            // Check if this conversation turn requires memory updates
            const memoryRequired = await callPathway('sys_memory_required', { 
                ...args,
                chatHistory: args.chatHistory.slice(-2)
            });
            
            let memoryOperations;
            try {
                memoryOperations = JSON.parse(memoryRequired);
                if (!Array.isArray(memoryOperations) || memoryOperations.length === 0 || 
                    memoryOperations[0].memoryOperation === "none") {
                    return "";
                }

                // Generate topic here
                const topic = await callPathway('sys_memory_topic', { ...args });
                topic && memoryOperations.push({
                    memoryOperation: "add",
                    memoryContent: topic,
                    memorySection: "memoryTopics",
                    priority: 3
                });

                // Group memory operations by section
                const operationsBySection = {
                    memorySelf: [],
                    memoryUser: [],
                    memoryTopics: [],
                    memoryDirectives: []
                };

                memoryOperations.forEach(op => {
                    if (op.memorySection in operationsBySection) {
                        operationsBySection[op.memorySection].push(op);
                    }
                });

                // Execute memory updates only for sections with operations
                const memoryPromises = {};
                
                Object.entries(operationsBySection).forEach(([section, operations]) => {
                    if (operations.length > 0) {
                        memoryPromises[section] = callPathway('sys_memory_update', { 
                            ...args, 
                            section: section,
                            operations: JSON.stringify(operations) 
                        });
                    }
                });

                await Promise.all(Object.values(memoryPromises));
                return "";

            } catch (e) {
                logger.warn('sys_memory_required returned invalid JSON:', memoryRequired);
                return "";
            }

        } catch (e) {
            logger.error('Error in memory manager:', e);
            resolver.logError(e);
            return "";
        }
    }
};