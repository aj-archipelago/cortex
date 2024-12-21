import {type ChatMessage, type CortexVariables, getCortexResponse} from "./utils";

const VISION_QUERY = `
query Vision($text: String, $contextId: String, $chatHistory: [MultiMessage], $aiName: String) {
  sys_generator_video_vision(text: $text, contextId: $contextId, chatHistory: $chatHistory, aiName: $aiName) {
    result
    tool
    errors
    warnings
  }
}
`

export async function vision(contextId: string,
                             aiName: string,
                             chatHistory: ChatMessage[],
                             text: string) {

  const variables: CortexVariables = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables, VISION_QUERY);

  return res.sys_generator_video_vision;
}
