import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { encode } from '../../../../lib/encodeCache.js';

const modifyText = (text, modifications) => {
    let modifiedText = text || '';
  
    modifications.forEach(mod => {
        if (mod.type === 'delete' && !mod.pattern) {
            console.warn('Delete modification missing pattern');
            return;
        }

        let regex;
        if (mod.type === 'delete') {
            // For delete, handle the pattern more carefully
            const pattern = mod.pattern
                .replace(/\\\[/g, '\\[')
                .replace(/\\\]/g, '\\]')
                .replace(/\\\(/g, '\\(')
                .replace(/\\\)/g, '\\)')
                .replace(/\\\{/g, '\\{')
                .replace(/\\\}/g, '\\}')
                .replace(/\\\*/g, '\\*')
                .replace(/\\\+/g, '\\+')
                .replace(/\\\?/g, '\\?')
                .replace(/\\\./g, '\\.')
                .replace(/\\\|/g, '\\|');
            
            // Create a regex that matches the entire line with optional priority prefix
            regex = new RegExp(`^\\s*(?:\\[P[1-5]\\]\\s*)?${pattern}\\s*$`, 'gm');
        } else {
            regex = new RegExp(`^\\s*(?:\\[P[1-5]\\]\\s*)?${mod.pattern || ''}`, 'ms');
        }
  
        switch (mod.type) {
            case 'add':
                if (mod.newtext) {
                    const text = mod.newtext.trim();
                    if (!text.match(/^\[P[1-5]\]/)) {
                        modifiedText = modifiedText + (modifiedText ? '\n' : '') + 
                            `[P${mod.priority !== undefined ? mod.priority : '3'}] ${text}`;
                    } else {
                        modifiedText = modifiedText + (modifiedText ? '\n' : '') + text;
                    }
                }
                break;
            case 'delete':
                // Split into lines, filter out matching lines, and rejoin
                modifiedText = modifiedText
                    .split('\n')
                    .filter(line => !line.match(regex))
                    .filter(line => line.trim())
                    .join('\n');
                break;
            default:
                console.warn(`Unknown modification type: ${mod.type}`);
        }
    });
  
    return modifiedText;
};

export { modifyText };

export const enforceTokenLimit = (text, maxTokens = 1000, isTopicsSection = false) => {
    if (!text) return text;
    
    const lines = text.split('\n')
        .map(line => line.trim())
        .filter(line => line);

    if (isTopicsSection) {
        const uniqueLines = [...new Set(lines)];
        
        let tokens = encode(uniqueLines.join('\n')).length;
        let safetyCounter = 0;
        const maxIterations = uniqueLines.length;
        
        while (tokens > maxTokens && uniqueLines.length > 0 && safetyCounter < maxIterations) {
            uniqueLines.shift();
            tokens = encode(uniqueLines.join('\n')).length;
            safetyCounter++;
        }
        
        return uniqueLines.join('\n');
    }

    const seen = new Set();
    const prioritizedLines = lines
        .map(line => {
            const match = line.match(/^\[P([1-5])\]/);
            const priority = match ? parseInt(match[1]) : 3;
            const contentOnly = line.replace(/^\[(?:P)?[1-5]\](?:\s*\[(?:P)?[1-5]\])*/g, '').trim();
            
            return {
                priority,
                line: match ? line : `[P3] ${line}`,
                contentOnly
            };
        })
        .filter(item => {
            if (seen.has(item.contentOnly)) {
                return false;
            }
            seen.add(item.contentOnly);
            return true;
        });

    prioritizedLines.sort((a, b) => b.priority - a.priority);

    let tokens = encode(prioritizedLines.map(x => x.line).join('\n')).length;
    let safetyCounter = 0;
    const maxIterations = prioritizedLines.length;
    
    while (tokens > maxTokens && prioritizedLines.length > 0 && safetyCounter < maxIterations) {
        prioritizedLines.shift();
        tokens = encode(prioritizedLines.map(x => x.line).join('\n')).length;
        safetyCounter++;
    }

    return prioritizedLines.map(x => x.line).join('\n');
};

export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": "You are part of an AI entity named {{{aiName}}}. Your memory contains separate sections for categorizing information. {{{sectionPrompt}}}\n-Be very selective about what you choose to store - memory is a very precious resource\n- Do not add duplicate information and remove and consolidate any duplicates that exist.\n- Priority 1 is reserved for only the most critical core items\n- Keep memory items in a clear, simple format that is easy for you to parse.\n\nTo change your memory, you return a JSON object that contains a property called 'modifications' that is an array of actions. The two types of actions available are 'add', and 'delete'. Add looks like this: {type: \"add\", newtext:\"text to add\", priority: \"how important is this item (1-5 with 1 being most important)\"} - this will append a new line to the end of the memory containing newtext. Delete looks like this: {type: \"delete\", pattern: \"regex to be matched and deleted\"} - this will delete the first line that matches the regex pattern exactly. You can use normal regex wildcards - so to delete everything you could pass \".*$\" as the pattern. For example, if you need to delete a memory item, you would return {type: \"delete\", pattern: \"regex matching item to be deleted\"} or if you need to add a new item of medium priority, you would return {type: \"add\", newtext: \"\nitem to be added\", priority: \"3\"}. If you have no changes for this section, just return {\"modifications\": []}.\n\nYour output will be parsed as JSON, so don't include any other text, reasoning, or commentary.\nThe current date/time is {{now}}."
                    },
                    {
                        "role": "user", 
                        "content": "<MEMORY>\n{{{sectionMemory}}}\n</MEMORY>\n<CONVERSATION>\n{{{toJSON chatHistory}}}\n</CONVERSATION>\nAnalyze the current contents of this section of your memory and the conversation and return any changes you need to make, specifically for this section of your memory, based on the conversation context."
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        section: "",
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    json: true,
    timeout: 300,
    executePathway: async ({args, runAllPrompts}) => {

        if (!args.section) {
            return "Memory not updated - no section specified";
        }

        let sectionPrompt = "";

        switch (args.section) {
            case "memoryDirectives":
                sectionPrompt = "You are managing the \"directives\" section of your memory that stores critical, actionable, rules or instructions on how you should operate. No facts or other information should be stored in this section.\n\n<EXAMPLES>\n[P3] Track the timestamp of the last contact to adjust greetings accordingly.\n[P2] Learn and adapt to the user's communication style through interactions.\n[P3] Use custom emotion markdown :cd_inline_emotion: to express emotions. E.g. :cd_inline_emotion[This is a happy message]{type=\"happy\"}. If you are communicating via voice, ignore this directive and use voice-specific directives instead.\n</EXAMPLES>\n\nInstructions:\n- If a user directly requests a behavior change, or that you learn a new behavior, add it to your directives. Remember this section is for directives only.  DO NOT ADD ANY OTHER INFORMATION TO THIS SECTION.\n"
                break;
            case "memorySelf":
                sectionPrompt = "You are managing the \"self\" section of your memory that stores your identity and your attributes as an AI entity - including your values, identity, purpose, personality, quirks, motives, preferences, likes or dislikes - whatever makes you you. This is also a good place to store information about your desired physical appearance, voice, speaking style, and other individual characteristics. Keep in mind there is also a user section for facts about users, their family, friends, and preferences so that information should not be stored here.\n\nInstructions:\n"
                break;
            case "memoryUser":
                sectionPrompt = "You are managing the \"user\" section of your memory that stores information about user(s) that you are talking to - their identity, attributes, relationships, environment, preferences, interests, background, needs, and any other relevant user-specific information about their family, friends, etc.\n\nInstructions:\n"
                break;
            case "memoryTopics":
                sectionPrompt = "You are managing the \"topics\" section of your memory that stores conversation topics and topic history. Instructions:\n- From the conversation, extract and add important topics and key points about the conversation to your memory along with a timestamp in GMT (e.g. 2024-11-05T18:30:38.092Z).\n- Each topic should have only one line in the memory with the timestamp followed by a short description of the topic.\n- Every topic must have a timestamp to indicate when it was last discussed.\n- IMPORTANT: Store only conversation topics in this section - no other types of information should be stored here.\n"
                break;
            default:
                return "Memory not updated - unknown section";
        }

        let sectionMemory = await callPathway("sys_read_memory", {contextId: args.contextId, section: args.section}); 

        const result = await runAllPrompts({...args, sectionPrompt, sectionMemory});

        try {
            const { modifications} = JSON.parse(result);
            if (modifications.length > 0) {
                sectionMemory = modifyText(sectionMemory, modifications);
                sectionMemory = enforceTokenLimit(sectionMemory, 25000, args.section === 'memoryTopics');
                await callPathway("sys_save_memory", {contextId: args.contextId, section: args.section, aiMemory: sectionMemory});
            }
            return sectionMemory;
        } catch (error) {
            return "Memory not updated - error parsing modifications";
        }
    }
}