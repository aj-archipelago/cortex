import test from 'ava';
import serverFactory from '../../../../index.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import path from 'path';
import { SubtitleUtils, parse } from '@aj-archipelago/subvibe';
import { selectBestTranslation, splitIntoOverlappingChunks } from '../../../../pathways/translate_subtitle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testServer;

test.before(async () => {
    const { server, startServer } = await serverFactory();
    startServer && await startServer();
    testServer = server;
});

test.after.always('cleanup', async () => {
    if (testServer) {
        await testServer.stop();
    }
});

// Improved mock implementation of translateChunk that preserves identifiers
async function mockTranslateChunk(chunk, args) {
  try {
    // Instead of building and parsing which might lose identifiers,
    // directly map each caption to a translated version
    return chunk.captions.map(caption => ({
      ...caption, // Preserve all properties including identifier
      text: `Translated: ${caption.text}`, // Just modify the text
    }));
  } catch (e) {
    console.error(`Error in mock translate chunk: ${e.message}`);
    throw e;
  }
}

async function testSubtitleTranslation(t, text, language = 'English', format = 'srt') {
    const response = await testServer.executeOperation({
        query: 'query translate_subtitle($text: String!, $to: String, $format: String) { translate_subtitle(text: $text, to: $to, format: $format) { result } }',
        variables: {
            to: language,
            text,
            format
        },
    });

    t.falsy(response.body?.singleResult?.errors);

    const result = response.body?.singleResult?.data?.translate_subtitle?.result;
    t.true(result?.length > text.length * 0.5);

    // Check format-specific header
    if (format === 'vtt') {
        t.true(result.startsWith('WEBVTT\n\n'), 'VTT output should start with WEBVTT header');
    }

    // Check timestamps based on format
    const timestampPattern = format === 'srt' 
        ? /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g
        : /(?:\d{2}:)?\d{2}:\d{2}\.\d{3} --> (?:\d{2}:)?\d{2}:\d{2}\.\d{3}/g;

    const originalTimestamps = text.match(timestampPattern);
    const translatedTimestamps = result.match(timestampPattern);

    // Compare timestamps using SubtitleUtils.parseLooseTime
    const areTimestampsEquivalent = originalTimestamps?.every((timestamp, index) => {
        const [origStart, origEnd] = timestamp.split(' --> ');
        const [transStart, transEnd] = translatedTimestamps[index].split(' --> ');
        
        const origStartTime = SubtitleUtils.parseLooseTime(origStart);
        const origEndTime = SubtitleUtils.parseLooseTime(origEnd);
        const transStartTime = SubtitleUtils.parseLooseTime(transStart);
        const transEndTime = SubtitleUtils.parseLooseTime(transEnd);
        
        return origStartTime === transStartTime && origEndTime === transEndTime;
    });

    if (!areTimestampsEquivalent) {
        const differences = originalTimestamps?.map((timestamp, index) => {
            const [origStart, origEnd] = timestamp.split(' --> ');
            const [transStart, transEnd] = translatedTimestamps[index].split(' --> ');
            
            const origStartTime = SubtitleUtils.parseLooseTime(origStart);
            const origEndTime = SubtitleUtils.parseLooseTime(origEnd);
            const transStartTime = SubtitleUtils.parseLooseTime(transStart);
            const transEndTime = SubtitleUtils.parseLooseTime(transEnd);
            
            if (origStartTime !== transStartTime || origEndTime !== transEndTime) {
                return {
                    index,
                    original: timestamp,
                    translated: translatedTimestamps[index],
                    parsedOriginal: { start: origStartTime, end: origEndTime },
                    parsedTranslated: { start: transStartTime, end: transEndTime }
                };
            }
            return null;
        }).filter(Boolean);

        console.log('Timestamp differences found:', differences);
    }
    
    t.true(areTimestampsEquivalent, 'All timestamps should be equivalent when parsed');

    // Check line count (accounting for WEBVTT header in VTT)
    const originalLineCount = text.split('\n').length;
    const translatedLineCount = result.split('\n').length;
    
    t.is(originalLineCount, translatedLineCount, 'Total number of lines should be the same');

    // For VTT, verify any custom identifiers are preserved
    if (format === 'vtt') {
        const originalBlocks = text.split(/\n\s*\n/).filter(block => block.trim());
        const translatedBlocks = result.split(/\n\s*\n/).filter(block => block.trim());
        
        // Skip WEBVTT header block
        const startIndex = originalBlocks[0].trim() === 'WEBVTT' ? 1 : 0;
        
        for (let i = startIndex; i < originalBlocks.length; i++) {
            const origLines = originalBlocks[i].split('\n');
            const transLines = translatedBlocks[i].split('\n');
            
            // If first line isn't a timestamp, it's an identifier and should be preserved
            if (!/^\d{2}:\d{2}/.test(origLines[0])) {
                t.is(transLines[0], origLines[0], 'VTT identifiers should be preserved');
            }
        }
    }
}

test('test subtitle translation with SRT format', async t => {
    const text = `1
00:00:03,069 --> 00:00:04,771
Who's that?

2
00:00:04,771 --> 00:00:06,039
Aseel.

3
00:00:06,039 --> 00:00:07,474
Who is Aseel a mom to?

4
00:00:07,474 --> 00:00:09,376
Aseel is mommy
`;

    await testSubtitleTranslation(t, text, 'Spanish', 'srt');
});

test('test subtitle translation with VTT format', async t => {
    const text = `WEBVTT

1
00:00:00.000 --> 00:00:07.000
It's here to change the game.

intro
00:00:07.000 --> 00:00:11.360
With the power of AI transforming the future.

question
00:00:11.360 --> 00:00:14.160
The possibilities endless.

00:00:14.160 --> 00:00:17.240
It's not just about the generative AI itself.
`;

    await testSubtitleTranslation(t, text, 'Spanish', 'vtt');
});

test('test subtitle translation with long SRT file', async t => {
    t.timeout(400000);
    const text = fs.readFileSync(path.join(__dirname, 'sublong.srt'), 'utf8');
    await testSubtitleTranslation(t, text, 'English', 'srt');
});

test('test subtitle translation with horizontal SRT file', async t => {
    t.timeout(400000);
    const text = fs.readFileSync(path.join(__dirname, 'subhorizontal.srt'), 'utf8');
    await testSubtitleTranslation(t, text, 'Turkish', 'srt');
});

/**
 * Mock implementation of callPathway that handles translate_subtitle_helper
 */
const mockCallPathway = async (pathwayName, params) => {
    if (pathwayName === "translate_subtitle_helper") {
      // Create a mock translation by adding "Translated: " prefix to each line
      const mockCaptions = params.text
        .split("\n")
        .map((line) => `Translated: ${line}`)
        .join("\n");
      return `<SUBTITLES>${mockCaptions}</SUBTITLES>`;
    }
  
    throw new Error(`Mock callPathway: Unhandled pathway ${pathwayName}`);
};


test("translationMap is built correctly with multiple chunks", async (t) => {
    // Create a sample of 50 captions
    const sampleCaptions = Array.from({ length: 50 }, (_, i) => ({
      identifier: i.toString(),
      text: `Caption ${i}`,
      index: i,
    }));
  
    // Use the actual function from the module to create chunks
    const chunks = splitIntoOverlappingChunks(sampleCaptions);
    t.true(chunks.length > 1, "Should create multiple chunks");
  
    // Mock args parameter required by translateChunk
    const mockArgs = {
      format: "srt",
      to: "Spanish",
    };
  
    // Use our simplified mock translateChunk function
    const chunkPromises = chunks.map((chunk) => mockTranslateChunk(chunk, mockArgs));
    const translatedChunks = await Promise.all(chunkPromises);
  
    // Build translation map
    const translationMap = new Map();
    translatedChunks.flat().forEach((caption) => {
      if (!translationMap.has(caption.identifier)) {
        translationMap.set(caption.identifier, []);
      }
      translationMap.get(caption.identifier).push(caption);
    });
  
    // Debug output
    console.log(`Translation map size: ${translationMap.size}`);
    
    // Check a few sample entries
    if (translationMap.size === 0) {
      console.log("Sample of translated chunks:", translatedChunks[0].slice(0, 3));
      console.log("First few captions from sample:", sampleCaptions.slice(0, 3));
    }
  
    // Verify the translation map
    t.truthy(translationMap, "Translation map should be created");
  
    // Check if all captions have entries
    sampleCaptions.forEach((caption) => {
      const hasEntry = translationMap.has(caption.identifier);
      if (!hasEntry) {
        console.log(`Missing entry for caption: ${caption.identifier}`);
      }
      t.true(
        hasEntry,
        `Translation map should have entry for caption ${caption.identifier}`
      );
    });
  
    // Check for overlapping translations (captions appearing in multiple chunks)
    let overlappingCaptions = 0;
    translationMap.forEach((translations) => {
      if (translations.length > 1) {
        overlappingCaptions++;
      }
    });
  
    // Due to the chunk overlap, some captions should have multiple translations
    t.true(
      overlappingCaptions > 0,
      "Some captions should have multiple translations due to chunk overlap"
    );
});
  
test("selectBestTranslation picks the best translation based on proximity to target", (t) => {
    // Sample translations for the same caption with different identifiers/positions
    const translations = [
      { identifier: "10", text: "Translation 1", index: 10 },
      { identifier: "15", text: "Translation 2", index: 15 },
      { identifier: "20", text: "Translation 3", index: 20 },
      { identifier: "25", text: "Translation 4", index: 25 },
    ];
  
    // Now we can use the actual function from the module
  
    // Case 1: Target closer to first translation
    const best1 = selectBestTranslation(translations, 10, 14);
    t.is(
      best1.text,
      "Translation 1",
      "Should select translation closest to target position 10-14"
    );
  
    // Case 2: Target closer to second translation
    const best2 = selectBestTranslation(translations, 15, 19);
    t.is(
      best2.text,
      "Translation 2",
      "Should select translation closest to target position 15-19"
    );
  
    // Case 3: Target closer to third translation
    const best3 = selectBestTranslation(translations, 20, 24);
    t.is(
      best3.text,
      "Translation 3",
      "Should select translation closest to target position 20-24"
    );
  
    // Case 4: Target exactly at one of the positions
    const best4 = selectBestTranslation(translations, 15, 15);
    t.is(best4.text, "Translation 2", "Should select exact matching translation");
  
    // Case 5: Target between two positions
    const best5 = selectBestTranslation(translations, 17, 23);
    t.is(
      best5.text,
      "Translation 3",
      "Should select translation closest to midpoint of target 17-23"
    );
  
    // Case 6: Single translation available
    const singleTranslation = [
      { identifier: "10", text: "Only translation", index: 10 },
    ];
    const best6 = selectBestTranslation(singleTranslation, 30, 30);
    t.is(
      best6.text,
      "Only translation",
      "With single translation, should select it regardless of target"
    );
  
    // Case 7: Handle missing identifier (use index instead)
    const mixedTranslations = [
      { text: "No identifier", index: 5 },
      { identifier: "10", text: "With identifier", index: 10 },
    ];
    const best7 = selectBestTranslation(mixedTranslations, 4, 6);
    t.is(
      best7.text,
      "No identifier",
      "Should use index when identifier is missing"
    );
  
    // Case 8: Empty translations array
    const emptyArray = [];
    const best8 = selectBestTranslation(emptyArray, 10, 10);
    t.is(best8, null, "Should return null for empty translations array");
  
    // Case 9: Invalid input handling
    t.is(
      selectBestTranslation(null, 10, 10),
      null,
      "Should handle null input gracefully"
    );
    t.is(
      selectBestTranslation(undefined, 10, 10),
      null,
      "Should handle undefined input gracefully"
    );
});


test("subtitle translation with translation coverage verification", async (t) => {
    t.timeout(400000); // Long timeout for potentially large file
    const text = fs.readFileSync(path.join(__dirname, "subchunk.srt"), "utf8");
  
    const response = await testServer.executeOperation({
      query:
        "query translate_subtitle($text: String!, $to: String, $format: String) { translate_subtitle(text: $text, to: $to, format: $format) { result } }",
      variables: {
        to: "Arabic",
        text,
        format: "srt",
      },
    });
  
    t.falsy(response.body?.singleResult?.errors);
  
    const result = response.body?.singleResult?.data?.translate_subtitle?.result;

    t.log(`Result: ${result}`);

    t.true(result?.length > text.length * 0.5);
  
    // Parse both original and translated subtitles
    const originalSubs = parse(text, { format: "srt" });
    const translatedSubs = parse(result, { format: "srt" });
  
    // Ensure we have the same number of cues/captions
    t.is(
      originalSubs.cues.length,
      translatedSubs.cues.length,
      "Should have same number of captions"
    );
  
    // Check that all lines have been translated to Arabic
    let untranslatedCount = 0;
    let translatedCount = 0;
    let nonArabicCount = 0;
    let exactMatchCount = 0;

    // Store all original texts to check for duplicates
    const allOriginalTexts = originalSubs.cues.map(cue => cue.text.toLowerCase().trim());
    
    // Track translated texts to check for duplicates within translations
    const translatedTextsSet = new Set();
    const duplicateTranslations = new Map(); // Map to store duplicate counts
  
    // Regular expression to match Arabic characters (Unicode range for Arabic script)
    const arabicRegex = /[\u0600-\u06FF]/;
  
    translatedSubs.cues.forEach((cue, index) => {
      const originalText = originalSubs.cues[index].text;
      const translatedText = cue.text;
  
      // Skip empty lines
      if (!originalText.trim()) return;
  
      // Check if the text has been translated (different from original)
      const isDifferent =
        translatedText.toLowerCase().trim() !== originalText.toLowerCase().trim();
      
      // Check if it's an exact match with ANY original line (not just its own line)
      const normalizedTranslated = translatedText.toLowerCase().trim();
      const isExactMatchWithAny = allOriginalTexts.includes(normalizedTranslated);
      
      // Track duplicate translations
      if (translatedTextsSet.has(normalizedTranslated)) {
        if (duplicateTranslations.has(normalizedTranslated)) {
          duplicateTranslations.set(
            normalizedTranslated, 
            duplicateTranslations.get(normalizedTranslated) + 1
          );
        } else {
          duplicateTranslations.set(normalizedTranslated, 2); // 2 occurrences total
        }
      } else {
        translatedTextsSet.add(normalizedTranslated);
      }
      
      if (isExactMatchWithAny) {
        exactMatchCount++;
        console.log(
          `Line ${index + 1} matches an original line: "${originalText}" => "${translatedText}"`
        );
      }
  
      // Check if it contains Arabic characters
      const containsArabic = arabicRegex.test(translatedText);
  
      if (isDifferent && containsArabic) {
        translatedCount++;
      } else if (isDifferent && !containsArabic) {
        nonArabicCount++;
        console.log(
          `Line ${
            index + 1
          } translated but not to Arabic: "${originalText}" => "${translatedText}"`
        );
      } else {
        untranslatedCount++;
        console.log(
          `Line ${
            index + 1
          } not translated: "${originalText}" => "${translatedText}"`
        );
      }
    });
  
    // Log translation statistics
    const totalCaptions = originalSubs.cues.length;
    console.log(
      `Translation coverage: ${translatedCount}/${totalCaptions} (${(
        (translatedCount / totalCaptions) *
        100
      ).toFixed(2)}%)`
    );
  
    console.log(
      `Lines with non-Arabic translation: ${nonArabicCount}/${totalCaptions} (${(
        (nonArabicCount / totalCaptions) *
        100
      ).toFixed(2)}%)`
    );
    
    console.log(
      `Lines that exactly match some original line: ${exactMatchCount}/${totalCaptions} (${(
        (exactMatchCount / totalCaptions) *
        100
      ).toFixed(2)}%)`
    );
    
    // Log duplicate translation statistics
    const duplicateCount = [...duplicateTranslations.values()].reduce((a, b) => a + b, 0) - duplicateTranslations.size;
    console.log(
      `Duplicate translations: ${duplicateCount}/${totalCaptions} (${(
        (duplicateCount / totalCaptions) *
        100
      ).toFixed(2)}%)`
    );
    
    // If there are many duplicates, log the most common ones for debugging
    if (duplicateCount > totalCaptions * 0.05) { // More than 5% are duplicates
      console.log("Most common duplicate translations:");
      [...duplicateTranslations.entries()]
        .sort((a, b) => b[1] - a[1]) // Sort by frequency, highest first
        .slice(0, 5) // Top 5 duplicates
        .forEach(([text, count]) => {
          console.log(`"${text}" appears ${count} times`);
        });
    }
  
    // Ensure at least 95% of lines are translated to Arabic
    const arabicTranslationCoverage = translatedCount / totalCaptions;
    t.true(
      arabicTranslationCoverage > 0.95,
      `At least 95% of lines should be translated to Arabic (actual: ${(
        arabicTranslationCoverage * 100
      ).toFixed(2)}%)`
    );
    
    // Ensure that no more than 5% of lines exactly match any original line
    const exactMatchPercentage = exactMatchCount / totalCaptions;
    t.true(
      exactMatchPercentage < 0.05,
      `No more than 5% of lines should match original text (actual: ${(
        exactMatchPercentage * 100
      ).toFixed(2)}%)`
    );
    
    // Ensure that duplicate translations are limited
    // For a file with distinct English inputs, we'd expect distinct Arabic outputs
    // Allow some duplication for very simple phrases like "Yes" or "Thank you"
    const duplicatePercentage = duplicateCount / totalCaptions;
    t.true(
      duplicatePercentage < 0.15, // Allow up to 15% duplicate translations
      `No more than 15% of lines should be duplicate translations (actual: ${(
        duplicatePercentage * 100
      ).toFixed(2)}%)`
    );
  
    // Check timestamps are preserved
    const timestampPattern =
      /\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}/g;
    const originalTimestamps = text.match(timestampPattern);
    const translatedTimestamps = result.match(timestampPattern);
  
    t.deepEqual(
      originalTimestamps,
      translatedTimestamps,
      "Timestamps should be preserved exactly"
    );
  });
