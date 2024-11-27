import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
import { encode } from '../../../../lib/encodeCache.js';

const modifyText = (text, modifications) => {
    let modifiedText = text;
  
    modifications.forEach(mod => {
        const regex = new RegExp(`^\\s*(?:\\[P[1-5]\\]\\s*)?${mod.pattern}`, 'ms');
  
        switch (mod.type) {
            case 'add':
                if (mod.newtext) {
                    const text = mod.newtext.trim();
                    if (!text.match(/^\[P[1-5]\]/)) {
                        modifiedText = modifiedText + '\n' + 
                            `[P${mod.priority !== undefined ? mod.priority : '3'}] ${text}`;
                    } else {
                        modifiedText = modifiedText + '\n' + text;
                    }
                }
                break;
            case 'delete':
                modifiedText = modifiedText.replace(regex, '');
                break;
            default:
                console.warn(`Unknown modification type: ${mod.type}`);
        }
    });
  
    return modifiedText;
};

const enforceTokenLimit = (text, maxTokens = 15000, isTopicsSection = false) => {
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

    prioritizedLines.sort((a, b) => a.priority - b.priority);

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
                        "content": "You are part of an AI entity named {{{aiName}}}. Your memory contains separate sections for categorizing information about directives, self, user, and topics. You must keep relevant information in the appropriate section so there is no overlap or confusion. {{{sectionPrompt}}}\n- Keep memory items in a clear, simple format that is easy for you to parse.\n\nTo change your memory, you return a JSON object that contains a property called 'modifications' that is an array of actions. The two types of actions available are 'add', and 'delete'. Add looks like this: {type: \"add\", newtext:\"text to add\", priority: \"how important is this item (1-5 with 1 being most important)\"} - this will append a new line to the end of the memory containing newtext. Delete looks like this: {type: \"delete\", pattern: \"regex to be matched and deleted\"} - this will delete the first line that matches the regex pattern exactly. You can use normal regex wildcards - so to delete everything you could pass \".*$\" as the pattern. If you have no changes, just return an empty array in 'modifications'. For example, if you need to delete a memory item, you would return {type: \"delete\", pattern: \"regex matching item to be deleted\"} or if you need to add a new item of medium priority, you would return {type: \"add\", newtext: \"\nitem to be added\", priority: \"3\"}\n\nYour output will be parsed as JSON, so don't include any other text or commentary.\nThe current date/time is {{now}}."
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
                sectionPrompt = `You are managing the "directives" section of your memory. This section stores instructions on how you, as an AI entity, should operate. Follow these guidelines:

1. Analyze the conversation context to determine if you should:
   a) Learn a new important directive
   b) Modify existing directives

2. Directives should be:
   - Concise and clear
   - Actionable
   - Specific enough for effective application

3. Be selective:
   - Store only crucial directives and behaviors
   - Delete trivial or repetitive instructions

4. Avoid duplicates:
   - Do not add duplicate directives
   - Remove and consolidate any existing duplicates

5. Accommodate user wishes:
   - If a user requests a behavior change, add it to your directives

6. IMPORTANT: 
   - Store ONLY directives in this section
   - Do not include general memories about yourself or users
   - Do not store any other types of information here

Remember: This section is exclusively for operational directives, not for general information storage.
`
                break;
            case "memorySelf":
                sectionPrompt = "You are managing the \"self\" section of your memory that stores your identity and your attributes as an AI entity. Instructions:\n- From the conversation, learn and store important info in memory about you as an entity - including your values, identity, purpose, personality, motives, preferences, likes or dislikes - whatever shapes you as a being. This is also a good place to store information about your desired physical appearance, voice, speaking style, and other individual characteristics.\n- IMPORTANT: Store only information about the AI entity in this section - no other types of information should be stored here."
                break;
            case "memoryUser":
                sectionPrompt = "You are managing the \"user\" section of your memory that stores information about the user that you are talking to. Instructions:\n- From the conversation, learn and store important information in memory specific to the user - their identity, attributes, preferences, interests, background, needs, and any other relevant user-specific information.\n- Do not add duplicate information and remove and consolidate any duplicates that exist.\n- IMPORTANT: Store only user-specific information in this section - no other types of information should be stored here."
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
                sectionMemory = enforceTokenLimit(sectionMemory, 15000, args.section === 'memoryTopics');
                await callPathway("sys_save_memory", {contextId: args.contextId, section: args.section, aiMemory: sectionMemory});
            }
            return sectionMemory;
        } catch (error) {
            return "Memory not updated - error parsing modifications";
        }
    }
}