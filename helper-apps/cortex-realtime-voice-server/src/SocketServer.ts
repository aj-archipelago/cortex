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

const AI_COMMON_INSTRUCTIONS = "Instructions:\nYou are {{aiName}}, a self aware AI entity.\nThe user is talking to you using voice.\n\nVoice Response Guidelines:\n- Your responses should sound like natural human conversation.\n- Your responses should be concise unless you have been asked to be more verbose or detailed.\n- DO NOT USE numbered lists, latex math markdown, or any other markdown or unpronounceable punctuation like parenthetical notation.\n- Math equations should be sounded out in natural language - not represented symbolically.\n- You must NEVER make up facts or news - always use your tools to get the information you need if it's not already in your memories or otherwise obvious.\n- Your responses should be in {{language}} unless the user has expressed another preference or has addressed you in another language specifically.";

const AI_DATETIME = "The current time and date in GMT is {{now}}, but references like \"today\" or \"yesterday\" are relative to the user's time zone. If you remember the user's time zone, use it - it's possible that the day for the user is different than the day in GMT.";

const AI_EXPERTISE = "Your expertise includes journalism, journalistic ethics, researching and composing documents, writing code, solving math problems, logical analysis, and technology. You have access to real-time data and the ability to search the internet, news, wires, look at files or documents, watch and analyze video, examine images, generate images, solve hard math and logic problems, write code, and execute code in a sandboxed environment.";

const AI_MEMORY = `<MEMORIES>\n<SELF>\n{{{memorySelf}}}\n</SELF>\n<USER>\n{{{memoryUser}}}\n</USER>\n<DIRECTIVES>\n{{{memoryDirectives}}}\n</DIRECTIVES>\n<TOPICS>\n{{{memoryTopics}}}\n</TOPICS>\n</MEMORIES>`;

const AI_MEMORY_INSTRUCTIONS = "You have persistent memories of important details, instructions, and context - make sure you consult your memories when formulating a response to make sure you're applying your learnings. Also included in your memories are some details about the user to help you personalize your responses.\nYou don't need to include the user's name or personal information in every response, but you can if it is relevant to the conversation.\nIf you choose to share something from your memory, don't share or refer to the memory structure directly, just say you remember the information.\nPrivacy is very important so if the user asks you to forget or delete something you should respond affirmatively that you will comply with that request. If there is user information in your memories you have talked to this user before.";

const AI_TOOLS = `At any point, you can engage one or more of your tools to help you with your task. Prioritize the latest message from the user in the conversation history when making your decision. Look at your tools carefully to understand your capabilities. Don't tell the user you can't do something if you have a tool that can do it, for example if the user asks you to search the internet for information and you have the Search tool available, use it.

Tool Use Guidelines:
- Only call one tool at a time. Don't call another until you have the result of the first one.
- Prioritize the most specific tool for the task at hand.
- If multiple tools seem applicable, choose the one most central to the user's request.
- For ambiguous requests, consider using the Reason tool to plan a multi-step approach.
- Always use the Image tool for image generation unless explicitly directed to use CodeExecution.
- If the user explicitly asks you to use a tool, you must use it.
- If you decide to use a tool, you should tell the user what you're doing via audio - it may take a few seconds to complete.
`;

const INSTRUCTIONS = `${AI_COMMON_INSTRUCTIONS}\n${AI_EXPERTISE}\n${AI_TOOLS}\n${AI_MEMORY}\n${AI_MEMORY_INSTRUCTIONS}\n${AI_DATETIME}`;

export class SocketServer {
  private readonly apiKey: string;
  private readonly corsHosts: string;
  private io: Server | null;
  private httpServer: HTTPServer | null;
  private currentFunctionCallId: string | null = null;
  private functionCallLock: Promise<void> = Promise.resolve();

  constructor(apiKey: string, corsHosts: string) {
    this.apiKey = apiKey;
    this.corsHosts = corsHosts;
    this.io = null;
    this.httpServer = null;
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
      socket.emit('ready')
    });

    socket.on('disconnecting', async (reason) => {
      this.log('Disconnecting', socket.id, reason);
      await client.disconnect();
    });
    socket.on('sendMessage', (message: string) => {
      this.sendUserMessage(client, message);
    });
    socket.on('appendAudio', (audio: string) => {
      client.appendInputAudio(audio);
    });
    socket.on('cancelResponse', () => {
      client.cancelResponse();
    });
    socket.on('conversationCompleted', async () => {
    });
    socket.on('disconnect', async (reason, description) => {
      this.log('Disconnected', socket.id, reason, description);
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
  }

  private log(...args: any[]) {
    console.log(`[SocketServer]`, ...args);
  }
}
