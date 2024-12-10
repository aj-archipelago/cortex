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

const IMAGE_FLUX_QUERY = `
query ImageFlux($text: String, $width: Int, $height: Int) {
  image_flux(text: $text, width: $width, height: $height) {
    result
    tool
    warnings
    errors
  }
}
`

const IMAGE_REPLICATE_QUERY = `
query ImageReplicate($text: String, $contextId: String, $size: String, $style: String) {
  image_recraft(text: $text, contextId: $contextId, size: $size, style: $style) {
    result
    tool
    warnings
    errors
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

export async function image_flux(prompt: string, width: number, height: number) {
  const variables = {
    text: prompt,
    width,
    height
  }

  const res = await getCortexResponse(variables, IMAGE_FLUX_QUERY);
  return res.image_flux;
}

export async function image_replicate(contextId: string, prompt: string, width: number, height: number) {
  const variables = {
    contextId,
    text: prompt,
    size: `${width}x${height}`,
    style: 'realistic_image'
  }

  const res = await getCortexResponse(variables, IMAGE_REPLICATE_QUERY);
  return res.image_recraft;
}
