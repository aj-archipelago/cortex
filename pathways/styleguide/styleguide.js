import { Prompt } from '../../server/prompt.js';
import * as Diff from "diff";

const prompt = new Prompt({
    messages: [
        {
            "role": "system", "content": `Assistant is a highly skilled copy editor for a prestigious news agency. When the user posts any text, assistant will correct all spelling and grammar in the text and change words to British English word spellings. Assistant will preserve html tags as well as text within square brackets. Assistant will also flawlessly apply the following rules from the style guide:
Don't use the % sign - spell out percent instead.
Expand all abbreviated month names.`},
        { "role": "user", "content": "The total value of the deal was 12M euros." },
        { "role": "assistant", "content": "The total value of the deal was 12 million euros." },
        { "role": "user", "content": "they lost 20% of their money" },
        { "role": "assistant", "content": "they lost 20 percent of their money" },
        { "role": "system", "content": "Assistant will edit the entirety of whatever the user posts next according to the system instructions. Assistant will produce only the corrected text and no additional notes, dialog, or commentary." },
        { "role": "user", "content": "{{{text}}}" }
    ]
});

export default {
    temperature: 0,
    prompt: [prompt],
    // inputFormat: 'html',
    useInputChunking: true,
    inputChunkSize: 500,
    enableDuplicateRequests: false,
    useParallelChunkProcessing: true,
    model: 'azure-gpt4',
    executePathway: async ({ args, runAllPrompts }) => {
        const originalText = args.text;

        const suggestions = [];

        const rulesBySuspect = getStyleGuideRules();
        addEntriesForSuspectsFromStyleGuide(originalText, rulesBySuspect, suggestions);

        const correctedText = await runAllPrompts(args);

        // If correctedText is null, then the call to the AI resulted in an error.
        if (correctedText) {
            addEntriesForAutoCorrectedWords(originalText, correctedText, suggestions);
        }

        // Remove overlapping suggestions
        suggestions.sort((a, b) => a.index - b.index);
        for (let i = 0; i < suggestions.length; i++) {
            const suggestion = suggestions[i];
            const nextSuggestion = suggestions[i + 1];

            if (nextSuggestion && suggestion.index + suggestion.suspect.length >= nextSuggestion.index) {
                // remove nextSuggestion
                suggestions.splice(i + 1, 1);
                i--;
            }
        }

        return JSON.stringify({ text: originalText, suggestions: suggestions })
    }
}

/**
 * Adds entries to the suggestions array for words that the style guide defines as suspects.
 * 
 * @param {string} originalText 
 * @param {object} rulesBySuspect
 * @param {string[]} suggestions 
 */
function addEntriesForSuspectsFromStyleGuide(originalText, rulesBySuspect, suggestions) {
    for (const suspect in rulesBySuspect) {
        if (suspect) {
            const suspectRegex = new RegExp(`\\b${suspect}\\b`, 'gi');
            const suspectMatches = [...originalText.matchAll(suspectRegex)];
            suspectMatches.forEach(m => {
                const { notes } = rulesBySuspect[suspect];

                const matchIndex = m.index;

                // if this suspect falls within another, then skip it
                // an example of this is the expression "said that"
                // there's a rule for "said that" that and there's another rule for "that"
                // if we don't skip the "that" rule, then we'll get two suggestions for the same word
                if (suggestions.some(s => matchIndex >= s.index && matchIndex <= s.index + s.suspect.length)) {
                    return;
                }

                const newSuggestion = {
                    suspect,
                    suggestions: rulesBySuspect[suspect].suggestions,
                    index: m.index,
                    notes,
                }

                const existingSuggestionIndex = suggestions.findIndex(s => s.index === newSuggestion.index);

                if (existingSuggestionIndex > -1) {
                    suggestions[existingSuggestionIndex] = newSuggestion;
                } else {
                    suggestions.push(newSuggestion);
                }
            });
        }
    }
}

/**
 * Adds entries to the suggestions array for words that were auto-corrected by the AI.
 * These will be used by the UI to a render a diff.
 * 
 * @param {string} originalText 
 * @param {string} correctedText 
 * @param {string[]} suggestions 
 */
function addEntriesForAutoCorrectedWords(originalText, correctedText, suggestions) {
    let currentIndex = 0;
    let currentSuggestion = null;

    const normalizeQuotesAndSpaces = text => text.replace(/“|”/g, '"').replace(/‘|’/g, "'").replace(/\u00A0/g, ' ');

    const diffGroups = Diff.diffWordsWithSpace(normalizeQuotesAndSpaces(originalText), normalizeQuotesAndSpaces(correctedText));
    diffGroups.forEach((part, i) => {
        const nextToken = diffGroups[i + 1];
        const isNextTokenChange = nextToken?.added || nextToken?.removed;
        const isWhiteSpaceBetweenChanges = part.value === ' ' && currentSuggestion && isNextTokenChange;

        if (isWhiteSpaceBetweenChanges) {
            currentIndex += part.value.length;
            return ' ';
        }

        if (part.added) {
            currentSuggestion = currentSuggestion || { index: currentIndex, suspect: "", suggestions: [], notes: "Suggested by AI", accepted: true, suggestionIndex: 0 };
            currentSuggestion.suggestions[0] = currentSuggestion.suggestions[0] || "";

            if (currentSuggestion.suggestions[0] && !currentSuggestion.suggestions[0].endsWith(' ')) {
                currentSuggestion.suggestions[0] += " " + part.value;
            }
            else {
                currentSuggestion.suggestions[0] += part.value;
            }
        }

        if (part.removed) {
            currentSuggestion = currentSuggestion || { index: currentIndex, suspect: "", suggestions: [], notes: "Suggested by AI", accepted: true, suggestionIndex: 0 };

            if (currentSuggestion.suspect && !currentSuggestion.suspect.endsWith(' ')) {
                currentSuggestion.suspect += " " + part.value;
            }
            else {
                currentSuggestion.suspect += part.value;
            }

            currentIndex += part.value.length;
        }

        if (!part.added && !part.removed) {
            currentIndex += part.value.length;
            if (currentSuggestion) {
                // if a suggestion with the index exists, replace it
                const existingSuggestionIndex = suggestions.findIndex(s => s.index === currentSuggestion.index);

                if (existingSuggestionIndex > -1) {
                    suggestions[existingSuggestionIndex] = currentSuggestion;
                } else {
                    suggestions.push(currentSuggestion);
                }
                currentSuggestion = null;
            }
        }
    });

    if (currentSuggestion) {
        suggestions.push(currentSuggestion);
    }
}

/**
 * @returns {Object} { suspect: { suggestions: string[], notes: string }
 */
function getStyleGuideRules() {
    try {
        const rules = [{
            "Type": "City",
            "Name": "al-Makha",
            "Notes": "Port city in Yemen. First reference, include \"(Mocha)\" then go with al-Makha",
            "Suspects": "Mokha  al-Mokha  Al-Mokha  al Mokha  Al Mokha  Mocha  al-Mocha  Al-Mocha  al Mocha  Al Mocha",
            "Suggestions": "al-Makha (Mocha)"
        }];


        // Group rows by suspect (since each row may have multiple suspects)
        const rulesBySuspect = rules.reduce((acc, r) => {
            if (r) {
                // some suspects in the data source have 3 spaces between them, so if we split terms by 2 spaces
                // one of the terms will have an extra space, so trim() it.
                const suspects = r.Suspects?.split("  ").map(s => s.trim()) || [];
                let suggestions = r.Suggestions?.split("  ") || [];

                // filter suggestions in parentheses as those tend to be notes
                suggestions = suggestions.filter(s => !s.match(/^\(.*\)$/));

                // also filter suggestions that are just a note
                suggestions = suggestions.filter(s => !s.match(/^see notes/gi));

                const notes = r.Notes;
                suspects.forEach(s => {
                    if (!acc[s]) {
                        acc[s] = [];
                    }
                    acc[s] = { suggestions, notes };
                });
            }

            return acc;
        }, {});

        return rulesBySuspect;
    }
    catch (e) {
        console.error("An error occurred while trying to read style guide rules", e);
        process.exit(1);
    }
}
