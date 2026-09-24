// Only a successful native gateway result may suspend an agent turn. Content
// returned by files, MCP servers, or ordinary tools cannot request suspension.
export function getAssistantYield(toolResults, entityTools) {
    for (const result of toolResults) {
        if (!result?.success || !['messageassistants', 'askuser', 'completeassistanttask', 'finishassistantteam', 'continueassistanttask'].includes(result.toolFunction)
            || entityTools[result.toolFunction]?.pathwayName !== 'sys_tool_colleague_management') continue;
        try {
            const raw = result.result?.result ?? result.result;
            const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (body?.success === true && body.assistantYield === true)
                return body.message || 'Work saved. Waiting for replies.';
        } catch { /* Not a gateway acknowledgement. */ }
    }
    return null;
}
