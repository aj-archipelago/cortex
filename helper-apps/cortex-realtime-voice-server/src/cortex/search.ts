import {type ChatMessage, type CortexVariables, type DataSource, getCortexResponse} from "./utils";

const SEARCH_QUERY = `
query Search($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String, $dataSources: [String]) {
  sys_entity_continue(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, dataSources: $dataSources, generatorPathway: "sys_generator_results", voiceResponse: true) {
    result
    tool
    errors
    warnings
  }
}
`

export async function search(contextId: string,
                             aiName: string,
                             chatHistory: ChatMessage[],
                             dataSources: DataSource[],
                             text: string) {
  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
    dataSources,
    text
  }

  const res = await getCortexResponse(variables, SEARCH_QUERY);

  return res.sys_entity_continue;
}
