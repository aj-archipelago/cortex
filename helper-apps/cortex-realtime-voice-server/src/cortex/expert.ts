import {type ChatMessage, type CortextVariables, getCortexResponse} from "./utils";

const WRITE_QUERY = `
query Expert($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_generator_expert(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName) {
    result
    tool
    errors
    warnings
  }
}
`

export async function expert(contextId: string,
                             aiName: string,
                             chatHistory: ChatMessage[],
                             text: string) {

  const variables: CortextVariables = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables, WRITE_QUERY);

  return res.sys_generator_expert;
}
