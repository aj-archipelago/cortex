import test from 'ava';
import categorizeFeedback from '../../../pathways/categorize_feedback.js';
import greeting from '../../../pathways/greeting.js';
import personalize from '../../../pathways/personalize.js';
import createArticle from '../../../pathways/create_article.js';

const internalNamesPattern = new RegExp(`${'Al ' + 'Jazeera'}|${'La' + 'beeb'}`, 'i');

test('categorize_feedback exposes generic feedback categories and CSV-style output', t => {
    t.is(categorizeFeedback.model, 'oai-gpt4o');
    t.regex(categorizeFeedback.inputParameters.categories, /Brand Praise/);
    t.regex(categorizeFeedback.inputParameters.categories, /Feature Suggestion/);

    const [systemMessage, userMessage] = categorizeFeedback.prompt[0].messages;
    t.regex(systemMessage.content, /categorizing customer feedback/);
    t.regex(systemMessage.content, /comma-separated, newline-delimited/);
    t.is(userMessage.content, 'Customer feedback:\n\n{{{text}}}');
    t.false(internalNamesPattern.test(systemMessage.content));
});

test('greeting generates dashboard copy using generic entity defaults', t => {
    t.is(greeting.model, 'oai-gpt41');
    t.is(greeting.inputParameters.aiName, 'Jarvis');
    t.is(greeting.inputParameters.language, 'English');

    const userMessage = greeting.prompt[0].messages[1].content;
    t.regex(userMessage, /dashboard/);
    t.regex(userMessage, /1-2 sentences/);
    t.false(internalNamesPattern.test(userMessage));
});

test('personalize selects relevant content items as JSON', t => {
    t.true(personalize.json);
    t.is(personalize.inputParameters.count, 4);
    t.true('questions' in personalize.inputParameters);
    t.true('itemsViewed' in personalize.inputParameters);

    const [systemMessage, userMessage] = personalize.prompt[0].messages;
    t.regex(systemMessage.content, /personal content assistant/);
    t.regex(systemMessage.content, /JSON array/);
    t.regex(userMessage.content, /candidate items/);
    t.false(internalNamesPattern.test(systemMessage.content + userMessage.content));
});

test('create_article returns a constrained generic article JSON contract', t => {
    t.true(createArticle.json);
    t.true(createArticle.enableCache);
    t.false(createArticle.useInputChunking);
    t.is(createArticle.inputParameters.targetShortDescriptionLength, 80);

    const prompt = createArticle.prompt[0];
    t.regex(prompt, /"headline", "summary", "shortDescription", and "article"/);
    t.regex(prompt, /Return only the JSON object/);
    t.false(internalNamesPattern.test(prompt));
});
