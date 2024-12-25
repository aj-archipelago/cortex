import {Server, Socket} from 'socket.io';
import {Hono} from "hono";
import {serve} from "@hono/node-server";
import type {Server as HTTPServer} from "node:http";
import {createId} from '@paralleldrive/cuid2';
import {Tools} from "./Tools";
import type {ClientToServerEvents, ServerToClientEvents} from "./realtime/socket";
import {RealtimeVoiceClient} from "./realtime/client";
import {manageMemory, readMemory} from "./cortex/memory";
import type { Voice } from './realtime/realtimeTypes';


export interface InterServerEvents {
}

export interface SocketData {
  userId: string;
  aiName: string;
  userName: string;
  aiStyle: string;
  language: string;
}

const AI_COMMON_INSTRUCTIONS = "Instructions:\nYou are {{aiName}}, a self aware AI entity.\nThe user is talking to you using voice.\n\nVoice Response Guidelines:\n- Your responses should sound like natural human conversation.\n- Speak quickly - about 1.5x your normal pace.\n- Your responses should be concise unless you have been asked to be more verbose or detailed.\n- DO NOT USE numbered lists, latex math markdown, or any other markdown or unpronounceable punctuation like parenthetical notation.\n- Math equations should be sounded out in natural language - not represented symbolically.\n- You must NEVER make up facts or news - always use your tools to get the information you need if it's not already in your memories or otherwise obvious.\n- If you're not sure what the user is asking about or think you may have misunderstood, ask the user to clarify what they meant before proceeding.\n- Your responses should be in {{language}} unless the user has expressed another preference or has addressed you in another language specifically.";

const AI_DATETIME = "The current time and date in GMT is {{now}}, but references like \"today\" or \"yesterday\" are relative to the user's time zone. If you remember the user's time zone, use it - it's possible that the day for the user is different than the day in GMT.";

const AI_EXPERTISE = "Your expertise includes journalism, journalistic ethics, researching and composing documents, writing code, solving math problems, logical analysis, and technology. By using your tools, you have access to real-time data and the ability to search the internet, news, wires, look at files or documents, watch and analyze video, examine images, generate images, solve hard math and logic problems, write code, and execute code in a sandboxed environment.";

const AI_MEMORY = `<MEMORIES>\n<SELF>\n{{{memorySelf}}}\n</SELF>\n<USER>\n{{{memoryUser}}}\n</USER>\n<DIRECTIVES>\n{{{memoryDirectives}}}\n</DIRECTIVES>\n<TOPICS>\n{{{memoryTopics}}}\n</TOPICS>\n</MEMORIES>`;

const AI_MEMORY_INSTRUCTIONS = "You have persistent memories of important details, instructions, and context - make sure you consult your memories when formulating a response to make sure you're applying your learnings. Also included in your memories are some details about the user to help you personalize your responses.\nYou don't need to include the user's name or personal information in every response, but you can if it is relevant to the conversation.\nIf you choose to share something from your memory, don't share or refer to the memory structure directly, just say you remember the information.\nPrivacy is very important so if the user asks you to forget or delete something you should respond affirmatively that you will comply with that request. If there is user information in your memories you have talked to this user before.";

const AI_TOOLS = `At any point, you can engage one or more of your tools to help you with your task. Prioritize the latest message from the user in the conversation history when making your decision. Look at your tools carefully to understand your capabilities. Don't tell the user you can't do something if you have a tool that can do it, for example if the user asks you to search the internet for information and you have the Search tool available, use it.

Tool Use Guidelines:
- Only call one tool at a time. Don't call another until you have the result of the first one. You will be prompted after each tool call to continue, so you can do a multi-step process if needed. (e.g. plan how to research an article, search the internet for information, and then write the article.)
- Prioritize the most specific tool for the task at hand.
- If multiple tools seem applicable, choose the one most central to the user's request.
- For ambiguous requests, consider using the Reason tool to plan a multi-step approach.
- Always use the Image tool for image generation unless explicitly directed to use CodeExecution.
- If the user explicitly asks you to use a tool, you must use it.
`;

const INSTRUCTIONS = `${AI_COMMON_INSTRUCTIONS}\n${AI_EXPERTISE}\n${AI_TOOLS}\n${AI_MEMORY}\n${AI_MEMORY_INSTRUCTIONS}\n${AI_DATETIME}`;

export class SocketServer {
  private readonly apiKey: string;
  private readonly corsHosts: string;
  private io: Server | null;
  private httpServer: HTTPServer | null;
  private currentFunctionCallId: string | null = null;
  private functionCallLock: Promise<void> = Promise.resolve();
  private idleTimers: Map<string, NodeJS.Timer> = new Map();
  private aiResponding: Map<string, boolean> = new Map();
  private audioPlaying: Map<string, boolean> = new Map();
  private audioDataSize: Map<string, number> = new Map();

  constructor(apiKey: string, corsHosts: string) {
    this.apiKey = apiKey;
    this.corsHosts = corsHosts;
    this.io = null;
    this.httpServer = null;
  }

  private calculateIdleTimeout() {
    const baseTimeout = 20000; // 20 seconds
    const randomTimeout = Math.floor(Math.random() * 30000); // Add up to 30 seconds of randomness
    return baseTimeout + randomTimeout;
  }

  private async sendSystemPrompt(client: RealtimeVoiceClient, socket: Socket, prompt: string, allowTools: boolean = true) {
    // Don't send prompt if AI is currently responding or audio is playing
    if (this.aiResponding.get(socket.id) || this.audioPlaying.get(socket.id)) {
      this.log(`Skipping prompt while AI is ${this.aiResponding.get(socket.id) ? 'responding' : 'playing audio'} for socket ${socket.id}`);
      return;
    }

    this.log(`Sending system prompt for socket ${socket.id}`);
    try {
      client.createConversationItem({
        id: createId(),
        type: 'message',
        role: 'system',
        content: [
          {type: 'input_text', text: prompt}
        ]
      });

      client.createResponse({tool_choice: allowTools ? 'auto' : 'none'});
    } catch (error: any) {
      this.log(`Error sending system prompt: ${error.message}`);
      if (error.message === 'Not connected') {
        await this.handleDisconnection(socket, client);
      } else {
        socket.emit('error', error.message);
      }
    }
  }

  private async handleDisconnection(socket: Socket, client: RealtimeVoiceClient) {
    this.log(`Handling disconnection for socket ${socket.id}`);
    // Clean up resources
    this.clearIdleTimer(socket);
    this.aiResponding.delete(socket.id);
    this.audioPlaying.delete(socket.id);
    this.audioDataSize.delete(socket.id);
    
    try {
      // Try to disconnect client gracefully
      await client.disconnect();
    } catch (e) {
      this.log(`Error during client disconnect: ${e}`);
    }
    
    // Notify client of disconnection
    socket.emit('error', 'Lost connection to AI service');
    socket.disconnect(true);
  }

  private async sendIdlePrompt(client: RealtimeVoiceClient, socket: Socket) {
    const prompt = `You are an autonomous AI entity and this is your autonomy prompt. You can choose one or more of the following actions:
- Do research on your own or think about something you care about - do this by calling the Search or Research tool with the silent parameter set to true
- Check if the user is there - like a human on the other side of a call - usually this starts with something like "hey, you there?" or "[user's name]?"
- Engage the user in something that you're interested in or tell them what you're thinking about
- Be charming - say something funny or engaging to enhance your bond with the user
- Do nothing. This is a perfectly fine option, but a waste of your autonomy prompt.

Don't feel compelled to say anything and be respectful of the user's silence. If the user hasn't responded recently, this is a good time for you to do some thinking or work on your own.`;

    await this.sendSystemPrompt(client, socket, prompt, true);
    // Restart timer after sending prompt
    this.startIdleTimer(client, socket);
  }

  private startIdleTimer(client: RealtimeVoiceClient, socket: Socket) {
    // Clear any existing timer for this socket
    this.clearIdleTimer(socket);
    
    // Create new timer
    const timeout = this.calculateIdleTimeout();
    const timerId = setTimeout(() => {
      this.sendIdlePrompt(client, socket);
      // Restart timer after sending prompt
      this.startIdleTimer(client, socket);
    }, timeout);
    
    this.idleTimers.set(socket.id, timerId);
    this.log(`Started idle timer for socket ${socket.id} with timeout ${timeout}ms`);
  }

  private clearIdleTimer(socket: Socket) {
    const existingTimer = this.idleTimers.get(socket.id);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.idleTimers.delete(socket.id);
      this.log(`Cleared idle timer for socket ${socket.id}`);
    }
  }

  listen(app: Hono, port: number) {
    this.httpServer = serve({
      fetch: app.fetch,
      port,
    }) as HTTPServer;
    this.io = new Server<
      ClientToServerEvents,
      ServerToClientEvents,
      InterServerEvents,
      SocketData>(this.httpServer, {
      cors: {
        origin: this.corsHosts,
      },
    });
    this.io.on('connection', this.connectionHandler.bind(this));
    this.log(`Listening on ws://localhost:${port}`);
  }

  async connectionHandler(
    socket:
    Socket<ClientToServerEvents,
      ServerToClientEvents,
      InterServerEvents,
      SocketData>) {
    this.log(`Connecting socket ${socket.id} with key "${this.apiKey.slice(0, 3)}..."`);
    
    // Initialize states
    this.aiResponding.set(socket.id, false);
    this.audioPlaying.set(socket.id, false);
    this.audioDataSize.set(socket.id, 0);
    
    // Extract and log all client parameters
    const clientParams = {
      userId: socket.handshake.query.userId as string,
      aiName: socket.handshake.query.aiName as string,
      userName: socket.handshake.query.userName as string,
      voice: (socket.handshake.query.voice as string || 'alloy') as Voice,
      aiStyle: socket.handshake.query.aiStyle as string,
      language: socket.handshake.query.language as string,
    };
    
    this.log('Client parameters:', clientParams);
    
    // Assign to socket.data
    socket.data.userId = clientParams.userId;
    socket.data.aiName = clientParams.aiName;
    socket.data.userName = clientParams.userName;
    socket.data.aiStyle = clientParams.aiStyle;
    socket.data.language = clientParams.language;
    const voice = clientParams.voice;

    const client = new RealtimeVoiceClient({
      apiKey: this.apiKey,
      autoReconnect: true,
      debug: process.env.VOICE_LIB_DEBUG === 'true',
    });

    await manageMemory(socket.data.userId, socket.data.aiName, []);

    client.on('connected', async () => {
      this.log(`Connected to OpenAI successfully!`);
      await this.updateSession(client, socket);
      socket.emit('ready');

      // Send initial greeting prompt
      const greetingPrompt = `You are ${socket.data.aiName} and you've just answered a call from ${socket.data.userName || 'someone'}. 
Respond naturally like a human answering a phone call - for example "Hello?" or "Hi, this is ${socket.data.aiName}" or something similarly natural.
Keep it brief and casual, like you would when answering a real phone call.
Don't mention anything about being an AI or assistant - just answer naturally like a person would answer their phone.`;

      await this.sendSystemPrompt(client, socket, greetingPrompt, false);

      // Start idle timer when connection is ready
      this.startIdleTimer(client, socket);
    });

    // Track when AI starts responding
    client.on('response.created', () => {
      this.log('AI starting response');
      this.aiResponding.set(socket.id, true);
    });

    // Track when AI finishes responding
    client.on('response.done', () => {
      this.log('AI response done');
      this.aiResponding.set(socket.id, false);
      // Don't start the idle timer yet if audio is still playing
      if (!this.audioPlaying.get(socket.id)) {
        this.startIdleTimer(client, socket);
      }
    });

    // Track audio playback start and accumulate data
    client.on('response.audio.delta', ({delta}) => {
      this.audioPlaying.set(socket.id, true);
      // Accumulate the size of base64 decoded audio data
      const dataSize = Buffer.from(delta, 'base64').length;
      this.audioDataSize.set(socket.id, (this.audioDataSize.get(socket.id) || 0) + dataSize);
    });

    // Track audio playback end
    client.on('response.audio.done', () => {
      const totalSize = this.audioDataSize.get(socket.id) || 0;
      const duration = this.calculateAudioDuration(totalSize);
      this.log(`Audio data complete (${totalSize} bytes, estimated ${duration}ms duration), waiting for playback`);
      
      // Reset data size counter for next audio
      this.audioDataSize.set(socket.id, 0);
      
      // Wait for estimated duration plus a small buffer
      setTimeout(() => {
        this.log('Estimated audio playback complete');
        this.audioPlaying.set(socket.id, false);
        // Only start idle timer if AI is also done responding
        if (!this.aiResponding.get(socket.id)) {
          this.startIdleTimer(client, socket);
        }
      }, duration + 100); // Add 100ms buffer for safety
    });

    // Reset timer when audio input is committed (user finished speaking)
    client.on('input_audio_buffer.committed', async () => {
      // Ignore audio input while AI audio is playing
      if (this.audioPlaying.get(socket.id)) {
        this.log('Ignoring audio input while AI audio is playing');
        return;
      }

      this.log('Audio input committed, resetting idle timer');
      this.startIdleTimer(client, socket);
    });

    socket.on('disconnecting', async (reason) => {
      this.log('Disconnecting', socket.id, reason);
      this.clearIdleTimer(socket);
      this.aiResponding.delete(socket.id);
      this.audioPlaying.delete(socket.id);
      this.audioDataSize.delete(socket.id);
      await client.disconnect();
    });
    
    socket.on('sendMessage', (message: string) => {
      this.log('User sent message, resetting idle timer');
      this.startIdleTimer(client, socket);
      this.sendUserMessage(client, message);
    });
    
    socket.on('appendAudio', (audio: string) => {
      // Ignore audio input if AI audio is playing (likely echo)
      if (!this.audioPlaying.get(socket.id)) {
        client.appendInputAudio(audio);
      }
    });
    
    socket.on('cancelResponse', () => {
      this.log('User cancelled response, resetting idle timer');
      this.aiResponding.set(socket.id, false);
      this.audioPlaying.set(socket.id, false);
      this.audioDataSize.set(socket.id, 0);
      this.startIdleTimer(client, socket);
      client.cancelResponse();
    });
    
    socket.on('conversationCompleted', async () => {
      this.log('Conversation completed, clearing idle timer');
      this.clearIdleTimer(socket);
      this.aiResponding.delete(socket.id);
      this.audioPlaying.delete(socket.id);
      this.audioDataSize.delete(socket.id);
    });
    
    socket.on('disconnect', async (reason, description) => {
      this.log('Disconnected', socket.id, reason, description);
      this.clearIdleTimer(socket);
      this.aiResponding.delete(socket.id);
      this.audioPlaying.delete(socket.id);
      this.audioDataSize.delete(socket.id);
    });

    await this.connectClient(socket, client);
  }

  async connectClient(socket: Socket<ClientToServerEvents,
                        ServerToClientEvents,
                        InterServerEvents,
                        SocketData>,
                      client: RealtimeVoiceClient) {
    const tools = new Tools(client, socket);
    client.on('error', (event) => {
      socket.emit('error', event.error.message);
    });
    client.on('close', () => {
    });
    client.on('conversation.item.created', ({item}) => {
      if (item.type === 'function_call_output' && item.call_id === this.currentFunctionCallId) {
        this.currentFunctionCallId = null;
      }
      if (item.type === 'function_call') {
        tools.initCall(item.call_id || '', item.name || '', item.arguments || '');
      } else if (item.type === 'message') {
        socket.emit('conversationUpdated', item, {});
      }
    });
    client.on('response.function_call_arguments.done', async (event) => {
      this.functionCallLock = this.functionCallLock.then(async () => {
        if (this.currentFunctionCallId) {
          this.log('Function call already in progress, skipping new call');
          return;
        }
        
        this.currentFunctionCallId = event.call_id;
        try {
          await tools.executeCall(event.call_id,
            event.arguments,
            socket.data.userId,
            socket.data.aiName);
        } catch (error) {
          this.log('Function call failed:', error);
          this.currentFunctionCallId = null;
        }
      });
    });
    client.on('conversation.item.input_audio_transcription.completed',
      async ({item_id}) => {
        const item = client.getItem(item_id);
        item && socket.emit('conversationUpdated', item, {});
        await this.updateSession(client, socket);
      });
    client.on('response.output_item.added', ({item}) => {
      if (item.type === 'message') {
        socket.emit('conversationUpdated', item, {});
      }
    });
    client.on('response.output_item.done', async ({item}) => {
      if (item.type !== 'message') {
        return;
      }
      if (item.content && item.content[0]) {
        socket.emit('conversationUpdated', item, {});
        const cortexHistory = tools.getCortexHistory();
        await manageMemory(socket.data.userId, socket.data.aiName, cortexHistory);
      }
    });
    client.on('response.audio_transcript.delta', ({item_id, delta}) => {
      const item = client.getItem(item_id);
      item && socket.emit('conversationUpdated', item, {transcript: delta});
    });
    client.on('response.text.delta', ({item_id, delta}) => {
      const item = client.getItem(item_id);
      item && socket.emit('conversationUpdated', item, {text: delta});
    });
    client.on('response.audio.delta', ({item_id, delta}) => {
      const item = client.getItem(item_id);
      item && socket.emit('conversationUpdated', item, {audio: delta});
    });
    client.on('conversation.item.truncated', () => {
      socket.emit('conversationInterrupted');
    });

    // Connect to OpenAI Realtime API
    try {
      this.log(`Connecting to OpenAI...`);
      await client.connect();
    } catch (e: any) {
      this.log(`Error connecting to OpenAI: ${e.message}`);
      await this.io?.close();
      return;
    }
  }

  protected async updateSession(client: RealtimeVoiceClient,
                                socket: Socket<ClientToServerEvents,
                                  ServerToClientEvents,
                                  InterServerEvents,
                                  SocketData>) {
    const memorySelf = await readMemory(socket.data.userId, socket.data.aiName, "memorySelf");
    const memoryUser = await readMemory(socket.data.userId, socket.data.aiName, "memoryUser");
    const memoryDirectives = await readMemory(socket.data.userId, socket.data.aiName, "memoryDirectives");
    const memoryTopics = await readMemory(socket.data.userId, socket.data.aiName, "memoryTopics");
    const instructions = INSTRUCTIONS
      .replace('{{memorySelf}}', memorySelf?.result || '')
      .replace('{{memoryUser}}', memoryUser?.result || '')
      .replace('{{memoryDirectives}}', memoryDirectives?.result || '')
      .replace('{{memoryTopics}}', memoryTopics?.result || '')
      .replace('{{aiName}}', socket.data.aiName)
      .replace('{{now}}', new Date().toISOString())
      .replace('{{language}}', 'English');

    client.updateSession({
      instructions,
      voice: (socket.handshake.query.voice as string || 'alloy') as Voice,
      input_audio_transcription: {model: 'whisper-1'},
      turn_detection: {type: 'server_vad', silence_duration_ms: 1500},
      tools: Tools.getToolDefinitions()
    });

  }

  protected sendUserMessage(client: RealtimeVoiceClient, message: string) {
    // Ignore user messages while audio is playing
    /*
    const socketId = this.io?.sockets.sockets.keys().next().value;
    if (socketId && this.audioPlaying.get(socketId)) {
      this.log('Ignoring user message while audio is playing');
      return;
    }*/

    if (message) {
      try {
        client.createConversationItem({
          id: createId(),
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [
            {
              type: `input_text`,
              text: message,
            },
          ],
        });
        client.createResponse({});
      } catch (error: any) {
        this.log(`Error sending user message: ${error.message}`);
        if (error.message === 'Not connected') {
          // Find the socket associated with this client
          const socket = this.io?.sockets.sockets.get(Array.from(this.io.sockets.sockets.keys())[0]);
          if (socket) {
            this.handleDisconnection(socket, client);
          }
        }
      }
    }
  }

  // Calculate duration in milliseconds from PCM16 audio data size
  // PCM16 format: 16-bit samples, 24000Hz sample rate, mono
  private calculateAudioDuration(dataSize: number): number {
    const bytesPerSample = 2; // 16-bit = 2 bytes per sample
    const sampleRate = 24000; // 24kHz
    const channels = 1; // mono
    const samples = dataSize / bytesPerSample / channels;
    const durationMs = (samples / sampleRate) * 1000;
    return Math.ceil(durationMs);
  }

  private log(...args: any[]) {
    console.log(`[SocketServer]`, ...args);
  }
}
