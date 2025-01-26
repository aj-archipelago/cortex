import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { config } from '../../../../config.js';
import { normalizeMemoryFormat, enforceTokenLimit } from './shared/sys_memory_helpers.js';

export const modifyText = (text, modifications) => {
    let modifiedText = text || '';
  
    modifications.forEach(mod => {
        // Skip invalid modifications
        if (!mod.type) {
            console.warn('Modification missing type');
            return;
        }
        if ((mod.type === 'delete' || mod.type === 'change') && !mod.pattern) {
            console.warn(`${mod.type} modification missing pattern`);
            return;
        }
        if ((mod.type === 'add' || mod.type === 'change') && !mod.newtext) {
            console.warn(`${mod.type} modification missing newtext`);
            return;
        }

        // Create timestamp in GMT
        const timestamp = new Date().toISOString();
        
        switch (mod.type) {
            case 'add':
                const priority = mod.priority || '3';
                modifiedText = modifiedText + (modifiedText ? '\n' : '') + 
                    `${priority}|${timestamp}|${mod.newtext}`;
                break;
            case 'change':
                // Split into lines
                const lines = modifiedText.split('\n');
                modifiedText = lines.map(line => {
                    const parts = line.split('|');
                    const priority = parts[0];
                    const content = parts.slice(2).join('|');
                    
                    if (content) {
                        try {
                            const trimmedContent = content.trim();
                            const regex = new RegExp(mod.pattern, 'i');
                            
                            // Try exact match first
                            if (regex.test(trimmedContent)) {
                                const newPriority = mod.priority || priority || '3';
                                // Try to extract capture groups if they exist
                                const match = trimmedContent.match(regex);
                                let newContent = mod.newtext;
                                if (match && match.length > 1) {
                                    // Replace $1, $2, etc with capture group values
                                    newContent = mod.newtext.replace(/\$(\d+)/g, (_, n) => match[n] || '');
                                }
                                return `${newPriority}|${timestamp}|${newContent}`;
                            }
                        } catch (e) {
                            console.warn(`Invalid regex pattern: ${mod.pattern}`);
                        }
                    }
                    return line;
                }).join('\n');
                break;
            case 'delete':
                // Split into lines, filter out matching lines, and rejoin
                modifiedText = modifiedText
                    .split('\n')
                    .filter(line => {
                        const parts = line.split('|');
                        const content = parts.slice(2).join('|');
                        if (!content) return true;
                        try {
                            const regex = new RegExp(mod.pattern, 'i');
                            return !regex.test(content.trim());
                        } catch (e) {
                            console.warn(`Invalid regex pattern: ${mod.pattern}`);
                            return true;
                        }
                    })
                    .filter(line => line.trim())
                    .join('\n');
                break;
            default:
                console.warn(`Unknown modification type: ${mod.type}`);
        }
    });
  
    return modifiedText;
};

export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": `You are part of an AI entity named {{{aiName}}} that is in charge of memory management. You examine requests for adds and deletes of memories made by another part of your system and determine exactly how to apply the changes to the memory.\n\nInstructions:\n1. For each add request, check to see if a similar memory already exists. If it does not, create an add modification. If it does, create a change modification with a pattern that matches the existing memory.\n2. For each delete request, check to see if one or more memories matching the delete request exist. If they do, create a delete modification for each memory with a pattern that matches the existing memory to delete.\n3. If there are substantially duplicate memories, you must combine them into a single memory with deletes followed by an add modification.\n4. Return a JSON array of modification objects.\n\nModification objects look like the following:\nFor adds: {type: "add", pattern: "", newtext: "Text of the memory to add"}\nFor changes: {type: "change", pattern: "Text to match the memory to change", newtext: "Text of the memory to change to"}\nFor deletes: {type: "delete", pattern: "Text to match the memory to delete", newtext: ""}`
                    },
                    {
                        "role": "user", 
                        "content": "Given the following memories and requests, determine which memories should be added, changed, or deleted. Return a JSON array of modification objects that will be applied to update your memory.\n\n<MEMORIES>\n{{{sectionMemory}}}\n</MEMORIES>\n\n<REQUESTS>\n{{{memoryRequests}}}\n</REQUESTS>\n\nReturn only the JSON array with no additional notes or commentary."
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        section: "",
        operations: "[]"
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
    timeout: 300,
    executePathway: async ({args, runAllPrompts}) => {
        args = { ...args, ...config.get('entityConstants') };

        if (!args.section) {
            return "Memory not updated - no section specified";
        }
   
        let sectionMemory = await callPathway("sys_read_memory", {contextId: args.contextId, section: args.section}); 

        sectionMemory = await normalizeMemoryFormat({contextId: args.contextId, section: args.section}, sectionMemory);

        let operations;
        try {
            operations = JSON.parse(args.operations);
        } catch (error) {
            return "Memory not updated - error parsing operations";
        }

        if (operations.length > 0) {
            // Run all operations through the prompt at once
            const result = await runAllPrompts({
                ...args,
                sectionMemory,
                memoryRequests: JSON.stringify(operations)
            });

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

                if (modifications.length > 0) {
                    sectionMemory = modifyText(sectionMemory, modifications);
                    sectionMemory = enforceTokenLimit(sectionMemory, 25000, args.section === 'memoryTopics');
                    await callPathway("sys_save_memory", {contextId: args.contextId, section: args.section, aiMemory: sectionMemory});
                }
            } catch (error) {
                console.warn('Error processing modifications:', error);
            }
        }
        return sectionMemory;
    }
}