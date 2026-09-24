import { AsyncLocalStorage } from 'node:async_hooks';

const execution = new AsyncLocalStorage();
export const assistantExecutionUser = () => execution.getStore()?.userId || null;
export function withAssistantExecutionUser(userId, operation) {
    // Nested pathways inherit the original caller; tool arguments cannot replace it.
    if (execution.getStore()) return operation();
    return execution.run({ userId: userId || null }, operation);
}
