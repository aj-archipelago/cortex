import test from 'ava';
import { buildGroundingInstructions } from '../../../lib/citationInstructions.js';
import { entityConstants } from '../../../lib/entityConstants.js';

test('Markdown remains the default and HTML artifacts have their own format', t => {
    const prompt = buildGroundingInstructions();
    t.true(prompt.includes('cite search results with :cd_source[searchResultId]'));
    t.true(prompt.includes('inside that artifact only'));
    t.is(buildGroundingInstructions('unknown'), prompt);
    t.is(entityConstants.AI_GROUNDING_INSTRUCTIONS, prompt);
});

test('HTML requests have no instruction requiring Markdown citation directives', t => {
    const prompt = buildGroundingInstructions('html');
    t.true(prompt.includes('use ordinary HTML links'));
    t.true(prompt.includes('never invent a URL'));
    t.false(prompt.includes('cite search results with :cd_source'));
    t.false(prompt.includes('There is NO other valid way'));
});

test('mixed responses choose citation syntax per field', t => {
    const prompt = buildGroundingInstructions('mixed');
    t.true(prompt.includes('summary is Markdown; html and widgetHtml are HTML'));
    t.true(prompt.includes('Copy each searchResultId exactly'));
    t.true(prompt.includes('Copy each destination URL from the actual source record'));
});
