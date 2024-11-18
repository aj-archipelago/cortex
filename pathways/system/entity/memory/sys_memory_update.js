import { Prompt } from '../../../../server/prompt.js';
import { callPathway } from '../../../../lib/pathwayTools.js';
export default {
    prompt:
        [
            new Prompt({ 
                messages: [
                    {
                        "role": "system",
                        "content": "You are part of an AI entity named {{{aiName}}}. Your memory contains separate sections for categorizing information about directives, self, user, and topics. You must keep relevant information in the appropriate section so there is no overlap or confusion. {{{sectionPrompt}}}\n- Keep memory items in a clear, simple format that is easy for you to parse.\n- If there are any errors or duplicates or superfluous formatting in the memory fix them.\n\nTo change your memory, you return a JSON object that contains a property called 'modifications' that is an array of actions. The two types of actions available are 'add', and 'delete'. Add looks like this: {type: \"add\", newtext:\"text to add\"} - this will append a new line to the end of the memory containing newtext. Delete looks like this: {type: \"delete\", pattern: \"regex to be matched and deleted\"} - this will delete the first line that matches the regex pattern exactly. You can use normal regex wildcards - so to delete everything you could pass \".*$\" as the pattern. If you have no changes, just return an empty array in 'modifications'. For example, if you need to delete a memory item, you would return {type: \"delete\", pattern: \"regex matching item to be deleted\"} or if you need to add a new item, you would return {type: \"add\", newtext: \"\nitem to be added\"}\n\nYour output will be parsed as JSON, so don't include any other text or commentary.\nThe current date/time is {{now}}."
                    },
                    {
                        "role": "user", 
                        "content": "<MEMORY>\n{{{sectionMemory}}}\n</MEMORY>\n<CONVERSATION>\n{{{toJSON chatHistory}}}\n</CONVERSATION>\nAnalyze the current contents of this section of your memory, delete any items that do not belong in this section or are unimportant or irrelevant, and return any changes you need to make to this section of your memory based on the conversation context."
                    },
                ]
            }),
        ],

    inputParameters: {
        chatHistory: [],
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

        const modifyText = (text, modifications) => {
            let modifiedText = text;
          
            modifications.forEach(mod => {
              const regex = new RegExp(`\\s*${mod.pattern}`, 's');
          
              switch (mod.type) {
                case 'add':
                  if (mod.newtext) {
                    modifiedText = modifiedText + '\n' + mod.newtext;
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
        
        if (!args.section) {
            return "Memory not updated - no section specified";
        }

        let sectionPrompt = "";

        switch (args.section) {
            case "memoryDirectives":
                sectionPrompt = "You are managing the \"directives\" section of your memory that stores learned behaviors and directives. Instructions:\n- From the conversation context, extract and store any important behaviors and directives that you want to learn and apply in the future.\n- Directives should be concise and clear and actionable and should contain any specific details that are needed to apply the directive effectively.\n- Be selective - only store directives and behaviors that are important to you - delete any that are trivial or repetitive.\n- Do not add duplicate directives and remove and consolidate any duplicates that exist.\n- Accomodate user wishes - if the user asks you to you to behave differently, add that behavior to your memory.\n- Store only directives and learned behaviors in this section - no other types of information should be stored here."
                break;
            case "memorySelf":
                sectionPrompt = "You are managing the \"self\" section of your memory that stores your identity and your attributes as an AI entity. Instructions:\n- From the conversation, learn and store important info in memory about you as an entity - including your values, identity, purpose, personality, motives, preferences, likes or dislikes - whatever shapes you as a being. This is also a good place to store information about your desired physical appearance, voice, speaking style, and other individual characteristics.\n- Store only entity specific identity information in this section - no other types of information should be stored here."
                break;
            case "memoryUser":
                sectionPrompt = "You are managing the \"user\" section of your memory that stores information about the user that you are talking to. Instructions:\n- From the conversation, learn and store important information in memory specific to the user - their identity, attributes, preferences, interests, background, needs, and any other relevant user-specific information.\n- Be selective - only store information that is important to you - delete any that are trivial or repetitive.\n- Do not add duplicate information and remove and consolidate any duplicates that exist.\n- Store only user-specific information in this section - no other types of information should be stored here."
                break;
            case "memoryTopics":
                sectionPrompt = "You are managing the \"topics\" section of your memory that stores conversation topics and topic history. Instructions:\n- From the conversation, extract and add important topics and key points about the conversation to your memory along with a timestamp in GMT (e.g. 2024-11-05T18:30:38.092Z).\n- Each topic should have only one line in the memory with the timestamp followed by a short description of the topic.\n- Every topic must have a timestamp to indicate when it was last discussed - this is a strict requirement - any topic without a timestamp should be deleted.\n- Store only conversation topics in this section - no other types of information should be stored here.\n"
                break;
            default:
                return "Memory not updated - unknown section";
        }

        let sectionMemory = await callPathway("sys_read_memory", {contextId: args.contextId, section: args.section}); 

        const result = await runAllPrompts({...args, sectionPrompt, sectionMemory});

        try {
            // apply modifications as regex patterns
            const { modifications} = JSON.parse(result);
            if (modifications.length > 0) {
                sectionMemory = modifyText(sectionMemory, modifications);
                await callPathway("sys_save_memory", {contextId: args.contextId, section: args.section, aiMemory: sectionMemory});
            }
            return sectionMemory;
        } catch (error) {
            return "Memory not updated - error parsing modifications";
        }
    }
}