import subsrt from "subsrt";
import logger from "../lib/logger.js";
import pLimit from "p-limit";
import { callPathway } from "../lib/pathwayTools.js";

function preprocessStr(str) {
    try {
        if (!str) return '';
        return str
            .replace(/\r\n?/g, '\n')
            .replace(/\n+/g, '\n')
            .replace(/(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})/g, '\n\n$1\n$2')
            .trim() + '\n\n';
    } catch (e) {
        logger.error(`An error occurred in content text preprocessing: ${e}`);
        return '';
    }
}

function getContextLines(captions, startIndex, direction, wordLimit = 100) {
    let context = '';
    let wordCount = 0;
    let i = startIndex;

    while (i >= 0 && i < captions.length && wordCount < wordLimit) {
        const words = captions[i].content.split(/\s+/);
        if (wordCount + words.length <= wordLimit) {
            context = direction === 'prev' ? 
                captions[i].content + ' ' + context :
                context + ' ' + captions[i].content;
            wordCount += words.length;
        } else {
            const remainingWords = wordLimit - wordCount;
            const partialContent = direction === 'prev' ? 
                words.slice(-remainingWords).join(' ') :
                words.slice(0, remainingWords).join(' ');
            context = direction === 'prev' ? 
                partialContent + ' ' + context :
                context + ' ' + partialContent;
            break;
        }
        i += direction === 'prev' ? -1 : 1;
    }

    return context.trim();
}


async function myResolver(args) {
    try{
        const { text, format } = args;
        const captions = subsrt.parse(preprocessStr(text), { format: format, verbose: true, eol: '\n' });
        const limit = pLimit(10);
        const tasks = captions.map((caption, i) =>
        limit(() => {
            const prevLine = getContextLines(captions, i - 1, 'prev');
            const nextLine = getContextLines(captions, i + 1, 'next');
            if(!caption.content) return "";
            return callPathway('translate_subtitle_single', { ...args, text: caption.content, prevLine, nextLine, async: false });
        })
        );

        const translatedTexts = await Promise.all(tasks);
        const translatedCaptions = captions.map((caption, i) => ({
        ...caption,
        content: translatedTexts[i].replace(/\n/g, " ").trim(),
        text: translatedTexts[i].replace(/\n/g, " ").trim(),
        }));

        return subsrt.build(translatedCaptions, { 
            format: format === 'vtt' ? 'vtt' : 'srt',
            eol: '\n'
        }).trim() + '\n';
    }catch(e){
        logger.error(`An error occurred in subtitle translation, 'll try direct translation next: ${e}`);
        try{
            return await callPathway('translate_gpt4', args);
        }catch(e){
            logger.error(`An error occurred in subtitle translation: ${e}`);
            return "";
        }
    }
}

export default {
  inputParameters: {
    to: `Arabic`,
    tokenRatio: 0.2,
    // mode: `fast`,
    format: `srt`,
    prevLine: ``,
    nextLine: ``,
  },
  inputChunkSize: 500,
  model: "oai-gpt4o",
  enableDuplicateRequests: false,
  timeout: 3600,
  executePathway: async ({ args }) => {
    return await myResolver(args);
  }
};
