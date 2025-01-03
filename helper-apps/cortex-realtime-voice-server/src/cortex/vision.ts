import {type ChatMessage, type CortexVariables, getCortexResponse} from "./utils";

export type MultiMessage = {
  role: string;
  content: string | string[];
}

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
                             chatHistory: (ChatMessage | MultiMessage)[],
                             text: string) {

  const variables: Omit<CortexVariables, 'chatHistory'> & { chatHistory: (ChatMessage | MultiMessage)[] } = {
    chatHistory,
    contextId,
    aiName,
    text
  }

  const res = await getCortexResponse(variables as CortexVariables, VISION_QUERY);

  return res.sys_generator_video_vision;
}
