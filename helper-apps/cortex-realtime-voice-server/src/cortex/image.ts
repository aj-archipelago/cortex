import {type ChatMessage, type CortextVariables, getCortexResponse} from "./utils";

const IMAGE_QUERY = `
query Image($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_generator_image(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName) {
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

  const variables: CortextVariables = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables, IMAGE_QUERY);

  return res.sys_generator_image;
}
