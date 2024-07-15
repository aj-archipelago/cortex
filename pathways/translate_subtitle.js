import subsrt from "subsrt";
import logger from "../lib/logger.js";
import { callPathway } from "../lib/pathwayTools.js";

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

function getContextLines(captions, startIndex, direction, wordLimit = 100) {
  let context = "";
  let wordCount = 0;
  let i = startIndex;

  while (i >= 0 && i < captions.length && wordCount < wordLimit) {
    const words = captions[i].content.split(/\s+/);
    if (wordCount + words.length <= wordLimit) {
      context =
        direction === "prev"
          ? captions[i].content + " " + context
          : context + " " + captions[i].content;
      wordCount += words.length;
    } else {
      const remainingWords = wordLimit - wordCount;
      const partialContent =
        direction === "prev"
          ? words.slice(-remainingWords).join(" ")
          : words.slice(0, remainingWords).join(" ");
      context =
        direction === "prev"
          ? partialContent + " " + context
          : context + " " + partialContent;
      break;
    }
    i += direction === "prev" ? -1 : 1;
  }

  return context.trim();
}

async function processBatch(batch, args, captions, batchStartIndex) {
  const batchText = batch
    .map((caption, index) => `LINE#${index + 1}: ${caption.content}`)
    .join("\n");
  const prevLines = getContextLines(captions, batchStartIndex - 1, "prev");
  const nextLines = getContextLines(
    captions,
    batchStartIndex + batch.length,
    "next"
  );

  const translatedText = await callPathway("translate_subtitle_helper", {
    ...args,
    text: batchText,
    prevLines,
    nextLines,
    async: false,
  });

  // Remove LINE# and LINE() labels
    const translatedLines = translatedText.split("\n");
    translatedLines.forEach((line, i) => {
    translatedLines[i] = line.replace(/^LINE#\d+:\s*/, "").trim();
    });
  //make sure translatedLines.length===batch.length
  if (translatedLines.length < batch.length) {
    const emptyLines = Array(batch.length - translatedLines.length).fill("");
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
        const emptyLines = Array(batch.length - translatedLines.length).fill("");
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

async function myResolver(args) {
  try {
    const { text, format } = args;
    const captions = subsrt.parse(preprocessStr(text), {
      format: format,
      verbose: true,
      eol: "\n",
    });
    const maxLineCount = 100;
    const maxWordCount = 1000;
    let translatedCaptions = [];
    let currentBatch = [];
    let currentWordCount = 0;
    let batchStartIndex = 0;

    for (let i = 0; i < captions.length; i++) {
      const caption = captions[i];
      const captionWordCount = caption.content.split(/\s+/).length;
      if (
        (currentWordCount + captionWordCount > maxWordCount ||
          currentBatch.length >= maxLineCount) &&
        currentBatch.length > 0
      ) {
        const translatedBatch = await processBatch(
          currentBatch,
          args,
          captions,
          batchStartIndex
        );
        translatedCaptions = translatedCaptions.concat(translatedBatch);
        currentBatch = [];
        currentWordCount = 0;
        batchStartIndex = i;
      }
      currentBatch.push(caption);
      currentWordCount += captionWordCount;
    }

    if (currentBatch.length > 0) {
      const translatedBatch = await processBatch(
        currentBatch,
        args,
        captions,
        batchStartIndex
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
    logger.error(
      `An error occurred in subtitle translation, 'll try direct translation next: ${e}`
    );
    try {
      return await callPathway("translate_gpt4", {...args, async: false});
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
  inputChunkSize: 500,
  model: "oai-gpt4o",
  enableDuplicateRequests: false,
  timeout: 3600,
  executePathway: async ({ args }) => {
    return await myResolver(args);
  },
};
