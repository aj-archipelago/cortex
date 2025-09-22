// handleBars.test.js

import test from 'ava';
import HandleBars from '../../../lib/handleBars.js';

test('stripHTML', (t) => {
    const stringWithHTML = '<h1>Hello, World!</h1>';
    const expectedResult = 'Hello, World!';

    const result = HandleBars.helpers.stripHTML(stringWithHTML);
    t.is(result, expectedResult);
});

test('now', (t) => {
    const expectedResult = new Date().toISOString();

    const result = HandleBars.helpers.now();
    t.is(result.slice(0, 10), expectedResult.slice(0, 10)); // Comparing only the date part
});

test('toJSON', (t) => {
    const object = { key: 'value' };
    const expectedResult = '{"key":"value"}';

    const result = HandleBars.helpers.toJSON(object);
    t.is(result, expectedResult);
});

test('ctoW', (t) => {
    const value = 66;
    const expectedResult = 10;

    const result = HandleBars.helpers.ctoW(value);
    t.is(result, expectedResult);
});

test('ctoW non-numeric', (t) => {
    const value = 'Hello, World!';
    const expectedResult = 'Hello, World!';

    const result = HandleBars.helpers.ctoW(value);
    t.is(result, expectedResult);
});