import {type ChatMessage, type CortexVariables, getCortexResponse, type MemorySection} from "./utils";
import { logger } from '../utils/logger';

const SEARCH_MEMORY_QUERY = `
query SearchMemory($contextId: String, $chatHistory: [MultiMessage], $aiName: String, $section: String) {
  sys_search_memory(contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, section: $section) {
    result
    tool
    warnings
    errors
  }
}
`

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
query ReadMemory($contextId: String, $aiName: String, $section: String, $priority: Int, $recentHours: Int) {
  sys_read_memory(contextId: $contextId, aiName: $aiName, section: $section, priority: $priority, recentHours: $recentHours) {
    result
    tool
    warnings
    errors
  }
}
`

export async function searchMemory(contextId: string,
  aiName: string,
  chatHistory: ChatMessage[],
  section: MemorySection
) {
logger.log('Searching memory', contextId, aiName, chatHistory);
const variables: CortexVariables = {
chatHistory,
contextId,
aiName,
section
}

const res = await getCortexResponse(variables, SEARCH_MEMORY_QUERY);

return res.sys_search_memory;
}

export async function manageMemory(contextId: string,
                                   aiName: string,
                                   chatHistory: ChatMessage[]
) {
  logger.log('Managing memory', contextId, aiName, chatHistory);
  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
  }

  const res = await getCortexResponse(variables, MANAGE_MEMORY_QUERY);

  return res.sys_memory_manager;
}

export async function readMemory(contextId: string,
                                 aiName: string,
                                 section: MemorySection,
                                 priority: number = 0,
                                 recentHours: number = 0
) {

  const variables: CortexVariables = {
    section,
    contextId,
    aiName,
    priority,
    recentHours
  }

  const res = await getCortexResponse(variables, READ_MEMORY);

  return res.sys_read_memory;
}
