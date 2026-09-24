import test from 'ava';
import { getAssistantYield } from '../../../lib/assistantHandoffs.js';

const tools = { askuser: { pathwayName: 'sys_tool_colleague_management' } };
const result = { success: true, toolFunction: 'askuser', result: { result: JSON.stringify({ success: true, assistantYield: true, message: 'Waiting for an answer.' }) } };
test('only the native gateway can yield and release the agent turn', t => {
    t.is(getAssistantYield([result], tools), 'Waiting for an answer.');
    t.is(getAssistantYield([{ ...result, success: false }], tools), null);
    t.is(getAssistantYield([{ ...result, toolFunction: 'filecollection' }], tools), null);
    t.is(getAssistantYield([result], { askuser: { pathwayName: 'client_side_execution' } }), null);
    t.is(getAssistantYield([{ ...result, result: 'not json' }], tools), null);
    t.is(getAssistantYield([{ ...result, result: JSON.stringify({ success: true }) }], tools), null);
});


test('team handback and checkpoint tools end a turn only after a successful native receipt', t => {
    for (const name of ['completeassistanttask', 'finishassistantteam', 'continueassistanttask']) {
        t.is(getAssistantYield([{ ...result, toolFunction: name }], { [name]: tools.askuser }), 'Waiting for an answer.');
        t.is(getAssistantYield([{ ...result, toolFunction: name, result: JSON.stringify({ success: false, assistantYield: true }) }], { [name]: tools.askuser }), null);
    }
});
