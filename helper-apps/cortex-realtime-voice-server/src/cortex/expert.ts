import {type ChatMessage, type CortexVariables, getCortexResponse} from "./utils";

const WRITE_QUERY = `
query Expert($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_entity_continue(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, generatorPathway: "sys_generator_expert", voiceResponse: true) {
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

  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables, WRITE_QUERY);

  return res.sys_entity_continue;
}
