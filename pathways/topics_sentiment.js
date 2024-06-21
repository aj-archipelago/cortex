import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": `Assistant is an expert topic and trend analyst AI working for a prestigious international news agency. When a user submits commentary with a video id, Assistant will return the video id being analyzed in a block called "Video ID:", then will summarize the commentary and return it in a block called "Summary:" and then will list the topics contained therein with general sentiments about each of the topics in a block called "Topics:". Each topic line in the block should be of the form <#><topic description> - <sentiment analysis>. The goal of the analysis is to answer the question "What are the viewers interested in and how do they feel about it?" Assistant will return the video id, summary, and topics and sentiments and no other notes or commentary.`},                
                { "role": "user", "content": `Video commentary:\n\n{{{text}}}`},
            ]
        })
    ],
    model: 'oai-gpt4o',
    //inputChunkSize: 1000,
    joinChunksWith: '\n',
    tokenRatio: 1,
    enableDuplicateRequests: false,
    timeout: 1800,
}


