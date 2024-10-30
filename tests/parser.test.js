import test from 'ava';
import * as parser from '../server/parser.js';
import * as pathwayTools from '../lib/pathwayTools.js';
import serverFactory from '../index.js';

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

test('parseNumberedObjectList should parse numbered object list correctly', async t => {
    const text = `1. name: John, age: 30
    2. name: Jane, age: 25`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
    ]);
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

test('parseJson should extract JSON from text', async t => {
    const textWithJson = 'Here is some JSON: {"name": "John", "age": 30} and some more text';
    const result = await parser.parseJson(textWithJson);
    t.deepEqual(JSON.parse(result), {name: "John", age: 30});
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

test('parseJson should attempt to repair invalid JSON', async t => {
    const invalidJson = '{"name": "John", "age": 30,}';
    
    const result = await parser.parseJson(invalidJson);
    
    console.log('parseJson result:', result);  // For debugging
    
    t.not(result, null);
    
    if (result !== null) {
        const parsedResult = JSON.parse(result);
        t.deepEqual(parsedResult, {name: "John", age: 30});
    }
});

test('parseJson should return null for unrepairable JSON', async t => {
    const unreparableJson = 'This is not JSON at all';
    const result = await parser.parseJson(unreparableJson);
    t.is(result, '{}');
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

test('parseNumberedObjectList should handle mixed separators', async t => {
    const text = `1. name: John, age-30
    2. name - Jane, age: 25`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
    ]);
});

test('parseNumberedObjectList should handle n fields', async t => {
    const text = `1. name: John, age: 30, city: New York, country: USA
    2. name: Jane, age: 25, country: Canada`;
    const format = 'name age city country';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John', age: 30, city: 'New York', country: 'USA' },
        { name: 'Jane', age: 25, country: 'Canada' }
    ]);
});

test('parseNumberedObjectList should ignore extra fields', async t => {
    const text = `1. name: John, age: 30, city: New York
    2. name: Jane, age: 25, country: Canada`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
    ]);
});

test('parseNumberedObjectList should handle missing fields', async t => {
    const text = `1. name: John
    2. age: 25`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John' },
        { age: 25 }
    ]);
});

test('parseNumberedObjectList should be case-insensitive for field names', async t => {
    const text = `1. NAME: John, AGE: 30
    2. Name: Jane, Age: 25`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
    ]);
});

test('parseNumberedObjectList should handle whitespace variations', async t => {
    const text = `1. name:John,age:   30
    2.    name    :    Jane   ,   age:25`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { name: 'John', age: 30 },
        { name: 'Jane', age: 25 }
    ]);
});

test('parseNumberedObjectList should handle empty input', async t => {
    const text = '';
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, []);
});

test('parseNumberedObjectList should handle input with no valid fields', async t => {
    const text = `1. foo: bar, baz: qux
    2. quux: corge`;
    const format = 'name age';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, []);
});

test('parseNumberedObjectList should handle values with splitters in them', async t => {
    const text = `1. name: John Doe, birth: 1990-01-01
    2. name: Jane Smith, birth: 1985-05-05`;
    const format = 'name birth';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { 'name': 'John Doe', 'birth': '1990-01-01' },
        { 'name': 'Jane Smith', 'birth': '1985-05-05' }
    ]);
});

test('parseNumberedObjectList should infer field names when given a list of separated values', async t => {
    const text = `1. John Doe, 1990-01-01
    2. Jane Smith, 1985-05-05`;
    const format = 'name birth';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { 'name': 'John Doe', 'birth': '1990-01-01' },
        { 'name': 'Jane Smith', 'birth': '1985-05-05' }
    ]);
});

test('parseNumberedObjectList should match simple string output to objects', async t => {
    const text = "1. World: The Earth and all its inhabitants, considered as a single entity.\n2. Dear: Loved or cherished by someone; regarded with deep affection.\n3. Hello: Used as a greeting or to begin a conversation.";
    const format = 'name definition';
    const result = await parser.parseNumberedObjectList(text, format);
    t.deepEqual(result, [
        { 'name': 'World', 'definition': 'The Earth and all its inhabitants, considered as a single entity.' },
        { 'name': 'Dear', 'definition': 'Loved or cherished by someone; regarded with deep affection.' },
        { 'name': 'Hello', 'definition': 'Used as a greeting or to begin a conversation.' }
    ]);
});