import {type ChatMessage, type CortextVariables, getCortexResponse, type MemorySection} from "./utils";

const MANAGE_MEMORY_QUERY = `
query ManageMemory($contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_memory_manager(contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName) {
    result
    tool
    warnings
    errors
  }
}
`

const READ_MEMORY = `
query ReadMemory($contextId: String, $aiName: String, $section: String) {
  sys_read_memory(contextId: $contextId, aiName: $aiName, section: $section) {
    result
    tool
    warnings
    errors
  }
}
`

export async function manageMemory(contextId: string,
                                   aiName: string,
                                   chatHistory: ChatMessage[]
) {
  console.log('Managing memory', contextId, aiName, chatHistory);
  const variables: CortextVariables = {
    chatHistory,
    contextId,
    aiName,
  }

  const res = await getCortexResponse(variables, MANAGE_MEMORY_QUERY);

  return res.sys_memory_manager;
}

export async function readMemory(contextId: string,
                                 aiName: string,
                                 section: MemorySection
) {

  const variables: CortextVariables = {
    section,
    contextId,
    aiName,
  }

  const res = await getCortexResponse(variables, READ_MEMORY);

  return res.sys_read_memory;
}
