import test from 'ava';
import {
    getClientToolCallbackTimeoutMs,
    getClientToolHeartbeatStaleMs,
} from '../../../lib/pathwayTools.js';
import entityAgent from '../../../pathways/system/entity/sys_entity_agent.js';

test('client tool callback timeout honors a bounded per-tool timeout', (t) => {
    t.is(getClientToolCallbackTimeoutMs({ definition: { timeout: 600000 } }), 600000);
    t.is(getClientToolCallbackTimeoutMs({ definition: {} }), 300000);
    t.is(getClientToolCallbackTimeoutMs({ definition: { timeout: 5000 } }), 10000);
    t.is(getClientToolCallbackTimeoutMs({ definition: { timeout: 3600000 } }), 900000);
});

test('client tool heartbeat tolerates background browser timer throttling', (t) => {
    t.is(getClientToolHeartbeatStaleMs({ definition: { timeout: 900000 } }), 90000);
    t.is(getClientToolHeartbeatStaleMs({ definition: {} }), 90000);
});

test('entity agent timeout leaves headroom around the longest client tool', (t) => {
    t.true(entityAgent.timeout > 900);
});
