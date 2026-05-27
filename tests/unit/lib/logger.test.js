import test from 'ava';
import { formatLogLine, normalizeLogMessage } from '../../../lib/logger.js';

const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/;

test('formatLogLine emits plain timestamped single-line logs', t => {
    const line = formatLogLine({
        timestamp: '2026-05-06T20:00:00.000Z',
        level: 'info',
        message: 'first line\nsecond line',
    });

    t.is(line, '2026-05-06T20:00:00.000Z info: first line\\nsecond line');
    t.false(ANSI_ESCAPE_PATTERN.test(line));
});

test('normalizeLogMessage stringifies structured payloads without ANSI formatting', t => {
    const message = normalizeLogMessage({
        event: 'token_usage',
        request_id: 'resp_123',
        stream: true,
    });

    t.is(message, '{"event":"token_usage","request_id":"resp_123","stream":true}');
    t.false(ANSI_ESCAPE_PATTERN.test(message));
});
