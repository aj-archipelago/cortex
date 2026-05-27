import { Prompt } from '../../server/prompt.js';
import * as cheerio from 'cheerio';

const styleGuidePrompt = new Prompt({
    messages: [
        {
            role: "system",
            content: `Assistant is a highly skilled copy editor for a prestigious news agency. When the user posts any text, assistant will correct all spelling and grammar in the text and change words to British English word spellings. Assistant will preserve html tags as well as text within square brackets. Assistant will also flawlessly apply the following rules from the style guide:
Don't use the % sign - spell out percent instead.
Expand all abbreviated month names.`,
        },
        { role: "user", content: "The total value of the deal was 12M euros." },
        { role: "assistant", content: "The total value of the deal was 12 million euros." },
        { role: "user", content: "they lost 20% of their money" },
        { role: "assistant", content: "they lost 20 percent of their money" },
        {
            role: "system",
            content: "Assistant will edit the entirety of whatever the user posts next according to the system instructions. Assistant will produce only the corrected text and no additional notes, dialog, or commentary.",
        },
        { role: "user", content: "{{{plainText}}}" },
    ],
});

const applyToHtmlPrompt = new Prompt({
    messages: [
        {
            role: "system",
            content: `You are a skilled HTML editor. Your task is to apply text corrections to HTML while preserving all HTML structure, tags, attributes, and formatting.

You will be given:
1. The original HTML document
2. The corrected plain text version (with all style guide corrections applied)

Your job is to apply the text changes from the corrected plain text to the original HTML, ensuring that:
- All HTML tags, attributes, and structure are preserved exactly
- Only the text content within HTML elements is updated
- The corrected text replaces the original text in the appropriate locations
- All formatting, links, images, and other HTML elements remain unchanged
- The output is valid, well-formed HTML

IMPORTANT: Return ONLY the corrected HTML code itself. Do NOT wrap it in markdown code blocks (no \`\`\`html or \`\`\`), do NOT add any explanations, comments, or formatting. Return the raw HTML directly.`,
        },
        {
            role: "user",
            content: `Original HTML:
{{{originalHtml}}}

Corrected Plain Text:
{{#if correctedText}}{{{correctedText}}}{{else}}{{{previousResult}}}{{/if}}

Apply the text corrections from the corrected plain text to the original HTML. Return ONLY the raw HTML code itself - do not wrap it in markdown code blocks or add any formatting.`,
        },
    ],
});

function extractPlainText(html) {
    if (!html || typeof html !== 'string') {
        return '';
    }

    try {
        const $ = cheerio.load(html);

        $('script, style').remove();

        $('p, div, br, h1, h2, h3, h4, h5, h6, li').each(function () {
            if ($(this).is('br')) {
                $(this).replaceWith('\n');
            } else if ($(this).prop('tagName') && ['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li'].includes($(this).prop('tagName').toLowerCase())) {
                const text = $(this).text();
                if (text.trim()) {
                    $(this).replaceWith(`${text}\n`);
                }
            }
        });

        return $.text()
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+/g, ' ')
            .trim();
    } catch {
        return html
            .replace(/<\/?(p|div|h[1-6]|li|br|tr)[^>]*>/gi, '\n')
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&[a-z]+;/gi, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]+/g, ' ')
            .trim();
    }
}

export default {
    temperature: 0,
    prompt: [styleGuidePrompt, applyToHtmlPrompt],
    inputFormat: 'html',
    useInputChunking: true,
    inputChunkSize: 500,
    enableDuplicateRequests: false,
    useParallelChunkProcessing: false,
    model: 'oai-gpt4o',
    inputParameters: {
        text: '',
        correctedText: undefined,
    },
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const originalHtml = args.text;
        const correctedText = args.correctedText;

        if (correctedText && correctedText.trim().length > 0) {
            const originalPrompts = resolver.pathwayPrompt;
            resolver.pathwayPrompt = [applyToHtmlPrompt];

            try {
                const result = await runAllPrompts({
                    originalHtml,
                    correctedText,
                });

                resolver.pathwayPrompt = originalPrompts;

                if (!result) {
                    throw new Error('Failed to apply corrected text to HTML');
                }

                return result;
            } catch (error) {
                resolver.pathwayPrompt = originalPrompts;
                throw error;
            }
        }

        const plainText = extractPlainText(originalHtml);

        if (!plainText || plainText.trim().length === 0) {
            return originalHtml;
        }

        const result = await runAllPrompts({
            plainText,
            originalHtml,
        });

        if (!result) {
            throw new Error('Failed to process HTML with style guide corrections');
        }

        return result;
    },
};
