type RealtimeEvent = {
  event_id: string,
}

type RealtimeContentResponseEvent = RealtimeEvent & {
  response_id: string,
  item_id: string,
  output_index: number,
  content_index: number,
}

type RealtimeFunctionResponseEvent = RealtimeEvent & {
  response_id: string,
  item_id: string,
  output_index: number,
  call_id: string,
}

type AudioFormat = 'pcm16' | 'g711_ulaw' | 'g711_alaw';
export type AzureVoice = 'amuch' | 'dan' | 'elan' | 'marilyn' | 'meadow' | 'breeze' | 'cove' | 'ember' | 'jupiter' | 'alloy' | 'echo' | 'shimmer';
export type OpenAIVoice = 'alloy' | 'echo' | 'shimmer' | 'ash' | 'ballad' | 'coral' | 'sage' | 'verse';
export type Voice = AzureVoice | OpenAIVoice;
type Modality = 'text' | 'audio';
type ToolDefinition = {
  type: string,
  name: string,
  description: string,
  parameters: Record<string, any>,
}
type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

export type RealtimeResponseConfig = {
  conversation: string,
  metadata: Record<string, any>,
  modalities: Array<Modality>,
  instructions: string,
  voice: Voice,
  output_audio_format: AudioFormat,
  tools: Array<ToolDefinition>,
  tool_choice: ToolChoice,
  temperature: number,
  max_output_tokens: number | 'inf'
}

export type RealtimeSessionConfig = {
  modalities: Array<Modality>,
  instructions: string,
  voice: Voice,
  input_audio_format: AudioFormat,
  output_audio_format: AudioFormat,
  input_audio_transcription: null | { model: 'whisper-1' | (string & {}) },
  turn_detection: null | {
    type: 'server_vad' | 'none',
    threshold?: number,
    prefix_padding_ms?: number,
    silence_duration_ms?: number
  },
  tools: Array<ToolDefinition>,
  tool_choice: ToolChoice,
  temperature: number,
  max_response_output_tokens: number | 'inf'
}

export type RealtimeSession = RealtimeSessionConfig & {
  id: string,
  model: string,
}

export type RealtimeItem = {
  id: string,
  type: 'message' | 'function_call' | 'function_call_output',
  status?: 'in_progress' | 'completed' | 'incomplete',
  role?: 'user' | 'assistant' | 'system',
  content?: Array<{
    type: 'input_text' | 'input_audio' | 'text' | 'audio',
    audio?: string,
    text?: string,
    transcript?: string | null,
  }>,
  call_id?: string,
  name?: string,
  arguments?: string,
  output?: string,
}

type RealtimeResponse = {
  id: string,
  status: 'in_progress' | 'completed' | 'incomplete' | 'failed',
  status_details: null | {
    type: 'incomplete',
    reason: 'interruption' | 'max_output_tokens' | 'content_filter',
  } | {
    type: 'failed',
    error?: Error | null,
  },
  output: Array<RealtimeItem>,
  usage?: {
    total_tokens: number
    input_tokens: number
    output_tokens: number
  },
}

type RealtimeContentPart = {
  type: 'text' | 'audio',
  text?: string,
  audio?: string,
  transcript?: string | null,
}

export type RealtimeErrorEvent = RealtimeEvent & {
  type: 'error',
  error: {
    type: string,
    code: string,
    message: string,
    param: null,
    event_id: string
  }
}

export type SessionCreatedEvent = RealtimeEvent & {
  type: 'session.created',
  session: RealtimeSession
}

export type SessionUpdatedEvent = RealtimeEvent & {
  type: 'session.updated',
  session: RealtimeSession
}

export type ConversationCreatedEvent = RealtimeEvent & {
  type: 'conversation.created',
  conversation: {
    id: string,
  }
}

export type ConversationItemCreatedEvent = RealtimeEvent & {
  type: 'conversation.item.created',
  previous_item_id: string,
  item: RealtimeItem,
}

export type ConversationItemInputAudioTranscriptionCompletedEvent = RealtimeEvent & {
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: string,
  content_index: number,
  transcript: string,
}

export type ConversationItemInputAudioTranscriptionFailedEvent = RealtimeEvent & {
  type: 'conversation.item.input_audio_transcription.failed',
  item_id: string,
  content_index: number,
  error: {
    type: string,
    code: string,
    message: string,
    param: null | string,
  }
}

export type ConversationItemTruncatedEvent = RealtimeEvent & {
  type: 'conversation.item.truncated',
  item_id: string,
  content_index: number,
  audio_end_ms: number,
}

export type ConversationItemDeletedEvent = RealtimeEvent & {
  type: 'conversation.item.deleted',
  item_id: string,
}

export type InputAudioBufferCommittedEvent = RealtimeEvent & {
  type: 'input_audio_buffer.committed',
  previous_item_id: string,
  item_id: string,
}

export type InputAudioBufferClearedEvent = RealtimeEvent & {
  type: 'input_audio_buffer.cleared',
}

export type InputAudioBufferSpeechStartedEvent = RealtimeEvent & {
  type: 'input_audio_buffer.speech_started',
  audio_start_ms: number,
  item_id: string,
}

export type InputAudioBufferSpeechStoppedEvent = RealtimeEvent & {
  type: 'input_audio_buffer.speech_stopped',
  audio_end_ms: number,
  item_id: string,
}

export type ResponseCreatedEvent = RealtimeEvent & {
  type: 'response.created',
  response: RealtimeResponse
}

export type ResponseDoneEvent = RealtimeEvent & {
  type: 'response.done',
  response: RealtimeResponse,
}

export type ResponseOutputItemAddedEvent = RealtimeEvent & {
  type: 'response.output_item.added',
  response_id: string,
  output_index: number,
  item: RealtimeItem,
}

export type ResponseOutputItemDoneEvent = RealtimeEvent & {
  type: 'response.output_item.done',
  response_id: string,
  output_index: number,
  item: RealtimeItem,
}

export type ResponseContentPartAddedEvent = RealtimeContentResponseEvent & {
  type: 'response.content_part.added',
  part: RealtimeContentPart,
}

export type ResponseContentPartDoneEvent = RealtimeContentResponseEvent & {
  type: 'response.content_part.done',
  part: RealtimeContentPart,
}

export type ResponseTextDeltaEvent = RealtimeContentResponseEvent & {
  type: 'response.text.delta',
  delta: string,
}

export type ResponseTextDoneEvent = RealtimeContentResponseEvent & {
  type: 'response.text.done',
  text: string,
}

export type ResponseAudioTranscriptDeltaEvent = RealtimeContentResponseEvent & {
  type: 'response.audio_transcript.delta',
  delta: string,
}

export type ResponseAudioTranscriptDoneEvent = RealtimeContentResponseEvent & {
  type: 'response.audio_transcript.done',
  transcript: string,
}

export type ResponseAudioDeltaEvent = RealtimeContentResponseEvent & {
  type: 'response.audio.delta',
  delta: string,
}

export type ResponseAudioDoneEvent = RealtimeContentResponseEvent & {
  type: 'response.audio.done',
}

export type ResponseFunctionCallArgumentsDeltaEvent = RealtimeFunctionResponseEvent & {
  type: 'response.function_call_arguments.delta',
  delta: string,
}

export type ResponseFunctionCallArgumentsDoneEvent = RealtimeFunctionResponseEvent & {
  type: 'response.function_call_arguments.done',
  arguments: string,
}

export type RateLimitsUpdatedEvent = RealtimeEvent & {
  type: 'rate_limits.updated',
  rate_limits: Array<{
    name: 'requests' | 'tokens' | 'input_tokens' | 'output_tokens' | (string & {})
    limit: number
    remaining: number
    reset_seconds: number
  }>
}
