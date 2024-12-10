import {type ChatMessage, type CortextVariables, getCortexResponse} from "./utils";

const WRITE_QUERY = `
query Reason($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_generator_reasoning(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName) {
    result
    tool
    errors
    warnings
  }
}
`

export async function reason(contextId: string,
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

  return res.sys_generator_reasoning;
}
