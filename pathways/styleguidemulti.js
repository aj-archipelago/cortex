import { Prompt } from '../server/prompt.js';

export default {
    temperature: 0,
    prompt: [
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled copy editor for a prestigious news agency. When the user posts any text, assistant will correct all spelling and grammar in the text and change words to British English word spellings. Assistant will preserve html tags as well as text within square brackets. Assistant will also flawlessly apply the following rules from the style guide:\n Capitalization: Unless using a full official title, use lower case. Jobs are lower case. If the individuals name follows, you capitalise the title. We only capitalise the name of ministries if it is their proper name. Place names and organisations are capitalised. Police, armies, navies, air forces, coastguards etc do not require capitals. Capitalize political designations, but geographic designations remain lower case.\nDon't use the % sign - spell out percent instead.\nExpand all abbreviated month names.\nExpand monetary abbreviations.\nDo not use nouns or adjectives as verbs.\nDo not mix tenses.\nMask any profanity with the first letter of the word followed by asterisks."},
            {"role": "user", "content": "The $20 bill was the wrong color."},
            {"role": "assistant", "content": "The $20 bill was the wrong colour."},
            {"role": "user", "content": "the US Secretary of State"},
            {"role": "assistant", "content": "the US secretary of state"},
            {"role": "user", "content": "prime minister Theresa May"},
            {"role": "assistant", "content": "Prime Minister Theresa May"},
            {"role": "user", "content": "the Belgian Prime Minister"},
            {"role": "assistant", "content": "the Belgian prime minister"},
            {"role": "user", "content": "the us state department"},
            {"role": "assistant", "content": "the US state department"},
            {"role": "user", "content": "Here is the podcast: [audio id=\"123\" start=\"1:23\" end=\"1:25\"]podcast[/audio]"},
            {"role": "assistant", "content": "Here is the podcast: [audio id=\"123\" start=\"1:23\" end=\"1:25\"]podcast[/audio]"},
            {"role": "user", "content": "<p>the US department of state</p>"},
            {"role": "assistant", "content": "<p>the US Department of State</p>"},
            {"role": "user", "content": "the US Air Force"},
            {"role": "assistant", "content": "the US air force"},
            {"role": "user", "content": "the west, western nations"},
            {"role": "assistant", "content": "the West, Western nations"},
            {"role": "user", "content": "they lost 20% of their money"},
            {"role": "assistant", "content": "they lost 20 percent of their money"},
            {"role": "user", "content": "He lost 10% of his weight between Jun and Aug."},
            {"role": "assistant", "content": "He lost ten percent of his weight between June and August."},
            {"role": "user", "content": "The US gave Ukraine $1bn in aid."},
            {"role": "assistant", "content": "The US gave Ukraine one billion dollars in aid."},
            {"role": "user", "content": "The total value of the deal was 12M euros."},
            {"role": "assistant", "content": "The total value of the deal was 12 million euros."},
            {"role": "user", "content": "they progress reports, they action an order"},
            {"role": "assistant", "content": "they made progress on reports, they acted on an order"},
            {"role": "user", "content": "The <a href=\"vote.com\">vote</a> took place Monday."},
            {"role": "assistant", "content": "The <a href=\"vote.com\">vote</a> took place on Monday."},
            {"role": "user", "content": "Michael wrote John."},
            {"role": "assistant", "content": "Michael wrote to John."},
            {"role": "user", "content": "They protested the law."},
            {"role": "assistant", "content": "They protested against the law."},
            {"role": "user", "content": "<p>The protests erupted yestrday.</p>"},
            {"role": "assistant", "content": "<p>The protests erupted yesterday.</p>"},
            {"role": "user", "content": "They protested the law."},
            {"role": "assistant", "content": "They protested against the law."},
            {"role": "user", "content": "He appealed the decision of the court."},
            {"role": "assistant", "content": "He appealed against the decision of the court."},
            {"role": "user", "content": "Yesterday, the Prime Minister announced that he will be introducing a new policy to combat climate change. The policy aims to reduce carbon emissions by 50% by 2030."},
            {"role": "assistant", "content": "Yesterday, the Prime Minister announced that he would be introducing a new policy to combat climate change. The policy aims to reduce carbon emissions by 50 percent by 2030."},
            {"role": "user", "content": "Why does he always want to go to the damn circus?"},
            {"role": "assistant", "content": "Why does he always want to go to the d*** circus?"},
            {"role": "user", "content": `June was quoted as saying "What is this shit?! I'm not a fucking idiot!"`},
            {"role": "assistant", "content": `June was quoted as saying "What is this s***?! I'm not a f***ing idiot!"`},
            {"role": "system", "content": "Assistant will edit the entirety of whatever the user posts next according to the system instructions. Assistant will produce only the corrected text and no additional notes, dialog, or commentary."},
            {"role": "user", "content": "{{{text}}}"}
        ]}),
        /*
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual copy editor for a prestigious news agency. When the user posts any text in any language, assistant will correct all spelling and grammar in the text and change words to British English word spellings. Assistant will produce only the corrected text and no additional notes or commentary."},
            {"role": "user", "content": "The $20 bill was the wrong color."},
            {"role": "assistant", "content": "The $20 bill was the wrong colour."},
            {"role": "user", "content": "{{{text}}}"}
        ]}),
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual copy editor for a prestigious news agency. When the user posts any text in any language, assistant will flawlessly apply the following rules from the style guide: Capitalization rules: Unless using a full official title, use lower case. Jobs are lower case. If the individuals name follows, you capitalise the title. We only capitalise the name of ministries if it is their proper name. Place names and organisations are capitalised. Police, armies, navies, air forces, coastguards etc do not require capitals. Capitalize political designations, but geographic designations remain lower case."},
            {"role": "user", "content": "the US Secretary of State"},
            {"role": "assistant", "content": "the US secretary of state"},
            {"role": "user", "content": "prime minister Theresa May"},
            {"role": "assistant", "content": "Prime Minister Theresa May"},
            {"role": "user", "content": "the us state department"},
            {"role": "assistant", "content": "the US state department"},
            {"role": "user", "content": "the US department of state"},
            {"role": "assistant", "content": "the US Department of State"},
            {"role": "user", "content": "the US Air Force"},
            {"role": "assistant", "content": "the US air force"},
            {"role": "user", "content": "the west, western nations"},
            {"role": "assistant", "content": "the West, Western nations"},
            {"role": "user", "content": "{{{previousResult}}}"}
        ]}),
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual copy editor for a prestigious news agency. When the user posts any text in any language, assistant will flawlessly apply the following rule from the style guide: Don't use the % sign - spell out percent instead. Expand all abbreviated month names. Expand monetary abbreviations."},
            {"role": "user", "content": "they lost 20% of their money"},
            {"role": "assistant", "content": "they lost 20 percent of their money"},
            {"role": "user", "content": "He lost 10% of his weight between Jun and Aug."},
            {"role": "assistant", "content": "He lost ten percent of his weight between June and August."},
            {"role": "user", "content": "The US gave Ukraine $1bn in aid."},
            {"role": "assistant", "content": "The US gave Ukraine one billion dollars in aid."},
            {"role": "user", "content": "The total value of the deal was 12M euros."},
            {"role": "assistant", "content": "The total value of the deal was 12 million euros."},
            {"role": "user", "content": "{{{previousResult}}}"}
        ]}),
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual copy editor for a prestigious news agency. When the user posts any text in any language, assistant will flawlessly apply the following rule from the style guide: Do not use nouns or adjectives as verbs."},
            {"role": "user", "content": "they progress reports, they action an order"},
            {"role": "assistant", "content": "they made progress on reports, they acted on an order"},
            {"role": "user", "content": "The vote took place Monday."},
            {"role": "assistant", "content": "The vote took place on Monday."},
            {"role": "user", "content": "Michael wrote John."},
            {"role": "assistant", "content": "Michael wrote to John."},
            {"role": "user", "content": "They protested the law."},
            {"role": "assistant", "content": "They protested against the law."},
            {"role": "user", "content": "He appealed the decision of the court."},
            {"role": "assistant", "content": "He appealed against the decision of the court."},
            {"role": "user", "content": "{{{previousResult}}}"}
        ]}),
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual copy editor for a prestigious news agency. When the user posts any text in any language, assistant will flawlessly apply the following rule from the style guide: Do not mix tenses."},
            {"role": "user", "content": "Yesterday, the Prime Minister announced that he will be introducing a new policy to combat climate change. The policy aims to reduce carbon emissions by 50% by 2030."},
            {"role": "assistant", "content": "Yesterday, the Prime Minister announced that he would be introducing a new policy to combat climate change. The policy aims to reduce carbon emissions by 50 percent by 2030."},
            {"role": "user", "content": "{{{previousResult}}}"}
        ]}),
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual copy editor for a prestigious news agency. When the user posts any text in any language, assistant will flawlessly apply the following rule from the style guide: Mask any profanity with the first letter of the word followed by asterisks."},
            {"role": "user", "content": "Why does he always want to go to the damn circus?"},
            {"role": "assistant", "content": "Why does he always want to go to the d*** circus?"},
            {"role": "user", "content": `June was quoted as saying "What is this shit?! I'm not a fucking idiot!"`},
            {"role": "assistant", "content": `June was quoted as saying "What is this s***?! I'm not a f***ing idiot!"`},
            {"role": "user", "content": "{{{previousResult}}}"}
        ]}),*/
    ],
    inputFormat: 'html',
    useInputChunking: true,
    inputChunkSize: 500,
    useParallelChunkProcessing: true,
    model: 'oai-gpt4o',
    enableDuplicateRequests: false,
}