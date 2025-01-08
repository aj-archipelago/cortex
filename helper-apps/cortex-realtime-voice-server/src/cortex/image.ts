import {type ChatMessage, type CortexVariables, getCortexResponse} from "./utils";

const IMAGE_QUERY = `
query Image($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_entity_continue(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, generatorPathway: "sys_generator_image", voiceResponse: true) {
    result
    tool
    errors
    warnings
  }
}
`

export async function image(contextId: string,
                             aiName: string,
                             chatHistory: ChatMessage[],
                             text: string) {

  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables, IMAGE_QUERY);

  return res.sys_entity_continue;
}
