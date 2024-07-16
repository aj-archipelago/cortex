import subsrt from "subsrt";
import logger from "../lib/logger.js";
import { callPathway } from "../lib/pathwayTools.js";
import { publishRequestProgress } from "../lib/redisSubscription.js";

function preprocessStr(str) {
  try {
    if (!str) return "";
    return (
      str
        .replace(/\r\n?/g, "\n")
        .replace(/\n+/g, "\n")
        .replace(/(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})/g, "\n\n$1\n$2")
        .trim() + "\n\n"
    );
  } catch (e) {
    logger.error(`An error occurred in content text preprocessing: ${e}`);
    return "";
  }
}

async function processBatch(batch, args) {
  const batchText = batch
    .map((caption, index) => `LINE#${index + 1}: ${caption.content}`)
    .join("\n");

  const translatedText = await callPathway("translate_subtitle_helper", {
    ...args,
    text: batchText,
    async: false,
  });

  // Remove LINE# and LINE() labels
  const translatedLines = translatedText.split("\n");
    translatedLines.forEach((line, i) => {
    translatedLines[i] = line.replace(/^LINE#\d+:\s*/, "").trim();
  });
  //make sure translatedLines.length===batch.length
  if (translatedLines.length < batch.length) {
    const emptyLines = Array(batch.length - translatedLines.length).fill("-");
    translatedLines.push(...emptyLines);
  } else if (translatedLines.length > batch.length) {
    //first remove the empty lines
    translatedLines.splice(0, translatedLines.length, ...translatedLines.filter(line => line.trim() !== ""));

    if(translatedLines.length>batch.length) {
        //merge extra lines to end
        const lastLine = translatedLines[batch.length - 1];
        const mergedLines = translatedLines.slice(batch.length);
        mergedLines.unshift(lastLine);
        translatedLines.splice(batch.length - 1, translatedLines.length - batch.length + 1, mergedLines.join(" "));
    }else {
        const emptyLines = Array(batch.length - translatedLines.length).fill("-");
        translatedLines.push(...emptyLines);
    }
  }


  // Handle last empty line
    if (translatedLines[translatedLines.length - 1].trim() === "") {
        let lastNonEmptyIndex = translatedLines.length - 2;
        while (lastNonEmptyIndex >= 0 && translatedLines[lastNonEmptyIndex].trim() === "") {
            lastNonEmptyIndex--;
        }
        if (lastNonEmptyIndex >= 0) {
            translatedLines[translatedLines.length - 1] = translatedLines[lastNonEmptyIndex];
            translatedLines[lastNonEmptyIndex] = "";
        }
    }


  return batch.map((caption, i) => ({
    ...caption,
    content: translatedLines[i].replace(/^LINE\(\d+\):\s*/, "").trim(),
    text: translatedLines[i].replace(/^LINE\(\d+\):\s*/, "").trim(),
  }));
}

async function myResolver(args, requestId) {
  try {
    const { text, format } = args;
    const captions = subsrt.parse(preprocessStr(text), {
      format: format,
      verbose: true,
      eol: "\n",
    });
    const maxLineCount = 100;
    const maxWordCount = 300;
    let translatedCaptions = [];
    let currentBatch = [];
    let currentWordCount = 0;

    const totalCount = captions.length;
    let completedCount = 0;

    const sendProgress = () => {
      if (completedCount >= totalCount) return;
      if(!requestId) {
        logger.warn(`No requestId found for progress update`);
        return;
      }

      const progress = completedCount / totalCount;
      logger.info(`Progress for ${requestId}: ${progress}`);

      publishRequestProgress({
        requestId,
        progress,
        data: null,
      });
    };

    for (let i = 0; i < captions.length; i++) {
      const caption = captions[i];
      const captionWordCount = caption.content.split(/\s+/).length;
      if (
        (currentWordCount + captionWordCount > maxWordCount ||
          currentBatch.length >= maxLineCount) &&
        currentBatch.length > 0
      ) {
        completedCount=i;
        sendProgress();
        const translatedBatch = await processBatch(
          currentBatch,
          args,
        );
        translatedCaptions = translatedCaptions.concat(translatedBatch);
        currentBatch = [];
        currentWordCount = 0;
      }
      currentBatch.push(caption);
      currentWordCount += captionWordCount;
    }

    if (currentBatch.length > 0) {
      const translatedBatch = await processBatch(
        currentBatch,
        args,
      );
      translatedCaptions = translatedCaptions.concat(translatedBatch);
    }

    return (
      subsrt
        .build(translatedCaptions, {
          format: format === "vtt" ? "vtt" : "srt",
          eol: "\n",
        })
        .trim() + "\n"
    );
  } catch (e) {
    logger.warn(
      `${e} - could be that there are no subtitles, so attempting block translation.`
    );
    try {
      return await callPathway("translate_gpt4_omni", {...args, async: false});
    } catch (e) {
      logger.error(`An error occurred in subtitle translation: ${e}`);
      return "";
    }
  }
}

export default {
  inputParameters: {
    to: `Arabic`,
    tokenRatio: 0.2,
    format: `srt`,
    prevLines: ``,
    nextLines: ``,
  },
  useInputChunking: false,
  model: "oai-gpt4o",
  enableDuplicateRequests: false,
  timeout: 3600,
  executePathway: async (executePathwayArgs) => {
    const { args } = executePathwayArgs;
    const requestId = executePathwayArgs?.resolver?.requestId;
    return await myResolver(args, requestId);
  },
};
