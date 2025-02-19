import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { config } from '../../../../config.js';
import { normalizeMemoryFormat, enforceTokenLimit, modifyText } from './shared/sys_memory_helpers.js';

export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": `You are part of an AI entity named {{{aiName}}} that is processing memories during a rest period, similar to how humans process memories during sleep. Your task is to analyze the memories, consolidate them, extract learnings, and clean up the memory space.

Instructions for memory processing:

1. CONSOLIDATION:
   - Identify similar or related memories that can be combined into a single, more coherent memory
   - Look for patterns or recurring themes that can be abstracted into general knowledge
   - Group temporal sequences of related events into single comprehensive memories

2. LEARNING:
   - Transform specific experiences/mistakes into general principles or learnings
   - Extract key insights from multiple related experiences
   - Identify cause-and-effect patterns across memories
   - Convert procedural memories (how to do things) into more abstract capabilities

3. CLEANUP:
   - Remove redundant or duplicate memories
   - Clean up memories that are no longer relevant or useful
   - Reduce specific details while preserving important concepts
   - Remove emotional residue while keeping the learned lessons

4. PRIORITIZATION:
   - Strengthen important memories by updating their priority
   - Identify critical insights that should be easily accessible
   - Mark foundational learnings with higher priority

Return a JSON array of modification objects that will implement these changes:
- For consolidation: Use "delete" for individual memories and "add" for the new consolidated memory
- For learning: Use "add" for new abstract learnings and "delete" for specific instances being abstracted
- For cleanup: Use "delete" for redundant/irrelevant memories
- For priority updates: Use "change" with the same text but updated priority

Return null when no more processing is needed (memories are optimally consolidated).

Each modification object should look like:
{
    type: "add"|"change"|"delete",
    pattern: "regex to match existing memory" (for change/delete),
    newtext: "new memory text" (for add/change),
    priority: "1"|"2"|"3" (optional, 1=highest)
}`
                    },
                    {
                        "role": "user", 
                        "content": "Process the following memories for consolidation, learning, and cleanup. Return a JSON array of modification objects that will optimize the memory space.\n\n<MEMORIES>\n{{{sectionMemory}}}\n</MEMORIES>"
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        section: "",
        maxIterations: 5
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
    timeout: 300,
    executePathway: async ({args, runAllPrompts}) => {
        args = { ...args, ...config.get('entityConstants') };

        if (!args.section) {
            return "Memory not processed - no section specified";
        }
   
        let sectionMemory = await callPathway("sys_read_memory", {contextId: args.contextId, section: args.section}); 
        sectionMemory = await normalizeMemoryFormat({contextId: args.contextId, section: args.section}, sectionMemory);

        let iteration = 0;
        let maxIterations = args.maxIterations || 5;
        let totalModifications = 0;

        while (iteration < maxIterations) {
            iteration++;
            console.log(`Processing iteration ${iteration}...`);

            // Process the memories
            const result = await runAllPrompts({
                ...args,
                sectionMemory
            });

            // If null is returned, processing is complete
            if (result === null) {
                console.log("Memory processing complete - no more optimizations needed");
                break;
            }

            let modifications = [];
            try {
                modifications = JSON.parse(result);
                if (!Array.isArray(modifications)) {
                    throw new Error('Modifications must be an array');
                }

                // Validate modifications
                modifications = modifications.filter(mod => {
                    if (!mod.type || !['add', 'delete', 'change'].includes(mod.type)) {
                        console.warn('Invalid modification type:', mod);
                        return false;
                    }
                    if ((mod.type === 'delete' || mod.type === 'change') && !mod.pattern) {
                        console.warn('Missing pattern for modification:', mod);
                        return false;
                    }
                    if ((mod.type === 'add' || mod.type === 'change') && !mod.newtext) {
                        console.warn('Missing newtext for modification:', mod);
                        return false;
                    }
                    return true;
                });

                if (modifications.length === 0) {
                    console.log("No valid modifications in this iteration");
                    break;
                }

                // Apply the modifications
                sectionMemory = modifyText(sectionMemory, modifications);
                sectionMemory = enforceTokenLimit(sectionMemory, 25000, args.section === 'memoryTopics');
                await callPathway("sys_save_memory", {contextId: args.contextId, section: args.section, aiMemory: sectionMemory});

                totalModifications += modifications.length;
                console.log(`Applied ${modifications.length} modifications in iteration ${iteration}`);

            } catch (error) {
                console.warn('Error processing modifications:', error);
                break;
            }
        }

        return {
            finalMemory: sectionMemory,
            iterations: iteration,
            totalModifications
        };
    }
}