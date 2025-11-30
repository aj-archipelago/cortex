// sys_tool_store_memory.js
// Entity tool that allows the agent to store information to memory
import { callPathway } from '../../../../lib/pathwayTools.js';

export default {
    prompt:
        [],
    model: 'oai-gpt41-mini',

    toolDefinition: [{
        type: "function",
        icon: "💾",
        function: {
            name: "StoreMemory",
            description: "Use this tool to store information to your memory. Use this when the user asks you to remember something, or when you want to save important information from the conversation for future reference.",
            parameters: {
                type: "object",
                properties: {
                    memories: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                content: {
                                    type: "string",
                                    description: "The content of the memory to store. Be specific about the information to remember."
                                },
                                section: {
                                    type: "string",
                                    enum: ["memoryUser", "memorySelf", "memoryDirectives", "memoryTopics"],
                                    description: "Optional: Which memory section to store this in. Use 'memoryUser' for information about the user, 'memorySelf' for information about yourself, 'memoryDirectives' for instructions/directives, or 'memoryTopics' for conversation topics. Defaults to 'memoryUser' if not specified."
                                },
                                priority: {
                                    type: "number",
                                    enum: [1, 2, 3],
                                    description: "Optional: Priority level for this specific memory (1=highest, 2=medium, 3=lowest). Defaults to 3 if not specified."
                                }
                            },
                            required: ["content"]
                        },
                        description: "Array of memories to store. Each memory should have a 'content' field with the information to remember, and optionally 'section' and 'priority' fields. You can store multiple memories in different sections in a single call."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["memories", "userMessage"]
            }
        }
    }],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        // Check if memory is enabled for this entity
        const useMemory = args.entityUseMemory !== undefined ? args.entityUseMemory : args.useMemory;
        if (useMemory === false) {
            return JSON.stringify({ 
                error: 'Memory storage is disabled for this entity. Cannot store memories when useMemory is false.' 
            });
        }

        // Validate memories array
        if (!args.memories || !Array.isArray(args.memories) || args.memories.length === 0) {
            return JSON.stringify({ error: 'memories must be a non-empty array' });
        }

        const validSections = ['memoryUser', 'memorySelf', 'memoryDirectives', 'memoryTopics'];
        const defaultPriority = 3;
        const timestamp = new Date().toISOString();
        
        // Group memories by section
        const memoriesBySection = {};
        
        // Validate and group memories
        for (const memory of args.memories) {
            if (!memory.content || typeof memory.content !== 'string') {
                return JSON.stringify({ error: 'Each memory must have a content field that is a string' });
            }
            
            const section = memory.section || 'memoryUser';
            if (!validSections.includes(section)) {
                return JSON.stringify({ error: `Invalid section: ${section}. Must be one of: ${validSections.join(', ')}` });
            }
            
            // Use memory-specific priority if it's a valid number (1, 2, or 3), otherwise use default
            const priority = (typeof memory.priority === 'number' && [1, 2, 3].includes(memory.priority))
                ? memory.priority
                : defaultPriority;
            
            // Format as: priority|timestamp|content
            const memoryLine = `${priority}|${timestamp}|${memory.content}`;
            
            if (!memoriesBySection[section]) {
                memoriesBySection[section] = [];
            }
            memoriesBySection[section].push(memoryLine);
        }

        // Store memories in each section
        const results = {};
        const sectionCounts = {};
        
        for (const [section, memoryLines] of Object.entries(memoriesBySection)) {
            // Read current memory for the section
            let currentMemory = await callPathway('sys_read_memory', {
                contextId: args.contextId,
                section: section,
                contextKey: args.contextKey
            });

            // Combine existing memory with new memories
            const updatedMemory = currentMemory 
                ? (currentMemory.trim() ? currentMemory + '\n' : '') + memoryLines.join('\n')
                : memoryLines.join('\n');

            // Save directly to memory
            const result = await callPathway('sys_save_memory', {
                contextId: args.contextId,
                section: section,
                aiMemory: updatedMemory,
                contextKey: args.contextKey
            });
            
            results[section] = result;
            sectionCounts[section] = memoryLines.length;
        }

        const totalCount = args.memories.length;
        const sectionsList = Object.keys(sectionCounts).join(', ');
        
        resolver.tool = JSON.stringify({ 
            toolUsed: "memory", 
            action: "store", 
            sections: Object.keys(sectionCounts),
            count: totalCount 
        });

        return JSON.stringify({ 
            success: true, 
            message: `Successfully stored ${totalCount} memory item(s) across ${Object.keys(sectionCounts).length} section(s): ${sectionsList}`,
            count: totalCount,
            sections: sectionCounts,
            results: results
        });
    }
}
