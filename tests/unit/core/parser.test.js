import test from 'ava';
import * as parser from '../../../server/parser.js';

test('regexParser should split text correctly', t => {
    const text = 'Hello  world\nHow are  you';
    const regex = /\s+/;
    const result = parser.regexParser(text, regex);
    t.deepEqual(result, ['Hello', 'world', 'How', 'are', 'you']);
});

test('parseNumberedList should parse different numbered list formats', t => {
    const text = `1. First item
    2) Second item
    3- Third item
    4: Fourth item`;
    const result = parser.parseNumberedList(text);
    t.deepEqual(result, ['First item', 'Second item', 'Third item', 'Fourth item']);
});

test('parseCommaSeparatedList should parse comma-separated list correctly', t => {
    const text = 'apple, banana, cherry, date';
    const result = parser.parseCommaSeparatedList(text);
    t.deepEqual(result, ['apple', 'banana', 'cherry', 'date']);
});

test('isCommaSeparatedList should correctly identify comma-separated lists', t => {
    t.true(parser.isCommaSeparatedList('a, b, c'));
    t.false(parser.isCommaSeparatedList('a\nb\nc'));
});

test('isNumberedList should correctly identify numbered lists', t => {
    t.true(parser.isNumberedList('1. First\n2. Second'));
    t.true(parser.isNumberedList('1) First\n2) Second'));
    t.false(parser.isNumberedList('First\nSecond'));
});

test('parseJson should parse valid JSON', async t => {
    const validJson = '{"name": "John", "age": 30}';
    const result = await parser.parseJson(validJson);
    t.deepEqual(JSON.parse(result), JSON.parse(validJson));
});

test('parseJson should handle JSON arrays', async t => {
    const jsonArray = '[1, 2, 3, 4, 5]';
    const result = await parser.parseJson(jsonArray);
    t.is(result, jsonArray);
});

test('parseJson should handle nested JSON', async t => {
    const nestedJson = '{"person": {"name": "John", "age": 30}, "hobbies": ["reading", "swimming"]}';
    const result = await parser.parseJson(nestedJson);
    t.is(result, nestedJson);
});

test('parseJson should handle JSON with special characters', async t => {
    const jsonWithSpecialChars = '{"message": "Hello, world!", "symbols": "#$%^&*()"}';
    const result = await parser.parseJson(jsonWithSpecialChars);
    t.is(result, jsonWithSpecialChars);
});

test('parseJson should handle JSON with Unicode characters', async t => {
    const jsonWithUnicode = '{"greeting": "こんにちは", "emoji": "😊"}';
    const result = await parser.parseJson(jsonWithUnicode);
    t.is(result, jsonWithUnicode);
});

test('parseJson should handle large JSON objects', async t => {
    const largeJson = JSON.stringify({
        id: 1,
        name: "Large Object",
        data: Array(1000).fill().map((_, i) => ({ key: `item${i}`, value: `value${i}` }))
    });
    const result = await parser.parseJson(largeJson);
    t.is(result, largeJson);
});

test('parseJson should handle JSON with different number formats', async t => {
    const jsonWithNumbers = '{"integer": 42, "float": 3.14, "scientific": 1.23e-4, "negative": -10}';
    const result = await parser.parseJson(jsonWithNumbers);
    t.is(result, jsonWithNumbers);
});

test('parseJson should handle JSON with boolean and null values', async t => {
    const jsonWithSpecialValues = '{"active": true, "inactive": false, "data": null}';
    const result = await parser.parseJson(jsonWithSpecialValues);
    t.is(result, jsonWithSpecialValues);
});
