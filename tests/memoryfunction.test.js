import test from 'ava';
import { enforceTokenLimit, modifyText } from '../pathways/system/entity/memory/sys_memory_update.js';

test('enforceTokenLimit preserves priority order correctly', t => {
    const input = `
[P1] Highest priority item
[P2] High priority item
[P3] Medium priority item
[P4] Low priority item
[P5] Lowest priority item`.trim();

    // Enforce trimming
    const result = enforceTokenLimit(input, 20);
    
    // Should keep P1, P2 only
    t.true(result.includes('[P1]'));
    t.true(result.includes('[P2]'));
    t.false(result.includes('[P3]'));
    t.false(result.includes('[P4]'));
    t.false(result.includes('[P5]'));
});

test('enforceTokenLimit handles empty input', t => {
    t.is(enforceTokenLimit(''), '');
    t.is(enforceTokenLimit(null), null);
});

test('enforceTokenLimit removes duplicates', t => {
    const input = `
[P3] Duplicate item
[P3] Duplicate item
[P2] Unique item`.trim();

    const result = enforceTokenLimit(input);
    
    // Count occurrences of "Duplicate item"
    const matches = result.match(/Duplicate item/g) || [];
    t.is(matches.length, 1);
});

test('enforceTokenLimit handles topics section differently', t => {
    const input = `
2024-03-19T10:00:00Z Discussed AI ethics
2024-03-19T11:00:00Z Discussed programming
2024-03-19T12:00:00Z Discussed testing`.trim();

    const result = enforceTokenLimit(input, 20, true);
    
    // For topics, should remove oldest entries first regardless of content
    t.false(result.includes('10:00:00Z'));
    t.false(result.includes('11:00:00Z'));
    t.true(result.includes('12:00:00Z'));
});

test('enforceTokenLimit adds P3 to unprioritized lines', t => {
    const input = `
Item without priority
[P1] Item with priority`.trim();

    const result = enforceTokenLimit(input);
    
    t.true(result.includes('[P3] Item without priority'));
    t.true(result.includes('[P1] Item with priority'));
});

test('modifyText handles delete operations with escaped characters', t => {
    const input = '[P2] Pizza Connection: Has special appreciation for Pisanello\'s';
    const modifications = [{
        type: 'delete',
        pattern: '\\[P2\\] Pizza Connection: Has special appreciation for Pisanello\'s'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Pizza Connection'));
});

test('modifyText handles delete with partial priority match', t => {
    const input = '[P3] Test memory item';
    const modifications = [{
        type: 'delete',
        pattern: 'Test memory item'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Test memory item'));
});

test('modifyText handles multiple modifications in sequence', t => {
    const input = '[P2] Keep this line\n[P3] Delete this line\n[P1] Also keep this';
    const modifications = [
        { type: 'delete', pattern: 'Delete this line' },
        { type: 'add', newtext: 'New line added', priority: '2' }
    ];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Keep this line'));
    t.true(result.includes('Also keep this'));
    t.true(result.includes('[P2] New line added'));
    t.false(result.includes('Delete this line'));
});

test('modifyText handles delete with whitespace variations', t => {
    const input = '  [P2]  Item with spaces  \n[P3]Item without spaces';
    const modifications = [
        { type: 'delete', pattern: 'Item with spaces' },
        { type: 'delete', pattern: 'Item without spaces' }
    ];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Item with spaces'));
    t.false(result.includes('Item without spaces'));
});

test('modifyText preserves existing priority when adding with priority in text', t => {
    const input = '';
    const modifications = [{
        type: 'add',
        newtext: '[P1] High priority item',
        priority: '3' // This should be ignored since priority is in text
    }];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('[P1] High priority item'));
    t.false(result.includes('[P3] [P1] High priority item'));
});

test('modifyText handles delete with regex special characters', t => {
    const input = '[P2] Special (chars) [test] {here} *star*';
    const modifications = [{
        type: 'delete',
        pattern: 'Special \\(chars\\) \\[test\\] \\{here\\} \\*star\\*'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Special (chars)'));
});