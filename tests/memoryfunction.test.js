import test from 'ava';
import { enforceTokenLimit } from '../pathways/system/entity/memory/sys_memory_update.js';

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