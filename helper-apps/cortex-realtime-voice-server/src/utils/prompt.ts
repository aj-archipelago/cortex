import { RealtimeVoiceClient } from "../realtime/client";
import { createId } from "@paralleldrive/cuid2";
import { logger } from "./logger";

// Time to wait after last user message before allowing AI to speak
const USER_SPEAKING_THRESHOLD_MS = 1500;

export interface SendPromptOptions {
  allowTools?: boolean;
  disposable?: boolean;
  aiResponding?: boolean;
  audioPlaying?: boolean;
  lastUserMessageTime?: number;
  userSpeaking?: boolean;
}

export async function sendPrompt(
  client: RealtimeVoiceClient,
  prompt: string,
  getOptions: (() => SendPromptOptions) | SendPromptOptions
) {
  const options = typeof getOptions === 'function' ? getOptions() : getOptions;
  
  const {
    allowTools = false,
    disposable = true,
    aiResponding = false,
    audioPlaying = false,
    lastUserMessageTime = 0,
    userSpeaking = false
  } = options;

  // Check if user is currently speaking (based on active speaking or recent message)
  const timeSinceLastMessage = Date.now() - lastUserMessageTime;
  const recentlySpoke = timeSinceLastMessage < USER_SPEAKING_THRESHOLD_MS;
  const isUserActive = userSpeaking || recentlySpoke;

  // Don't send prompt if AI is responding, audio is playing, or user is speaking/recently spoke
  if (aiResponding || audioPlaying || isUserActive) {
    logger.log(`${disposable ? 'Skipping' : 'Queuing'} prompt while ${
      userSpeaking ? 'user is actively speaking' :
      recentlySpoke ? 'user recently finished speaking' :
      aiResponding ? 'AI is responding' :
      'AI audio is playing'
    }`);
    if (!disposable) {
      // Try again after a short delay if the message is important
      // Pass the getOptions callback to get fresh state on retry
      return new Promise((resolve) => {
        setTimeout(() => {
          sendPrompt(client, prompt, getOptions).then(resolve);
        }, 1000);
      });
    }
    return;
  }

  logger.log('Sending prompt');

  client.createConversationItem({
    id: createId(),
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: prompt }
    ]
  });

  client.createResponse({ tool_choice: allowTools ? 'auto' : 'none' });
} 