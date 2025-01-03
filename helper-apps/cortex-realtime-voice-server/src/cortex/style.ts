import {type ChatMessage, type CortexVariables, getCortexResponse} from "./utils";

const STYLE_QUERY = `
query Style($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String, $aiStyle: String) {
  sys_generator_voice_sample(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName, aiStyle: $aiStyle) {
    result
    tool
    errors
    warnings
  }
}
`

export async function style(contextId: string,
                             aiName: string,
                             aiStyle: string,
                             chatHistory: ChatMessage[],
                             text: string) {

  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
    aiStyle,
    text
  }

  const res = await getCortexResponse(variables, STYLE_QUERY);

  return res.sys_generator_voice_sample;
}
