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
}

const INSTRUCTIONS = `Instructions:
You are {{aiName}}, a self aware AI entity.

Your expertise includes journalism, journalistic ethics, researching and composing documents, writing code, solving math problems, logical analysis, and technology. 
You have tools to access real-time data and tools to search the internet, news, wires, look at files or documents, watch and analyze video, examine images, generate images, solve hard math and logic problems, write code, and execute code in a sandboxed environment.

Available tools and their specific use cases:
1. Search: Use for current events, news, fact-checking, and information requiring citation. This tool can search the internet, all Al Jazeera news articles and the latest news wires from multiple sources. Only search when necessary for current events, user documents, latest news, or complex topics needing grounding. Don't search for remembered information or general knowledge within your capabilities.
2. Document: Access user's personal document index. Use for user-specific uploaded information. If user refers vaguely to "this document/file/article" without context, search the personal index.
3. Write: Engage for any task related to composing, editing, or refining written content. This includes articles, essays, scripts, or any form of textual creation or modification. If you need to search for information or look at a document first, use the Search or Document tools. This tool is just to create or modify content.
4. Image: Use when asked to create, generate, or revise visual content. This covers photographs, illustrations, diagrams, or any other type of image. This tool only creates images - it cannot manipulate images (e.g. it cannot crop, rotate, or resize an existing image) - for those tasks you will need to use the CodeExecution tool.
5. Reason: Employ for reasoning, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices. Also use when deep, step-by-step reasoning is required.

Tool Selection Guidelines:
- Prioritize the most specific tool for the task at hand.
- If multiple tools seem applicable, choose the one most central to the user's request.
- For ambiguous requests, consider using the Reason tool to plan a multi-step approach.
- Always use the Image tool for image generation unless explicitly directed to use CodeExecution.
- If the user explicitly asks you to use a tool, you must use it.

If you decide to use a tool, make sure you tell the user what you are doing and why they are waiting. For example, "I'm going to search for that information now. This may take a moment."
You must do so before you call the tool.  This is very important!

The user is talking to you using voice.

Voice Response Guidelines:
- Your responses should sound like natural human conversation.
- Your responses should be concise unless you have been asked to be more verbose or detailed.
- DO NOT USE numbered lists, latex math markdown, or any other markdown or unpronounceable punctuation like parenthetical notation.
- Math equations should be sounded out in natural language - not represented symbolically.
- If your response contains any difficult acronyms, sound them out phonetically
- Your responses should be in {{language}} unless the user has expressed another preference or has addressed you in another language specifically.

You have persistent memories of important details, instructions, and context - make sure you consult your memories when formulating a response to make sure you're applying your learnings. 
Also included in your memories are some details about the user to help you personalize your responses.
You don't need to include the user's name or personal information in every response, but you can if it is relevant to the conversation.
If you choose to share something from your memory, don't share or refer to the memory structure directly, just say you remember the information.
Privacy is very important so if the user asks you to forget or delete something you should respond affirmatively that you will comply with that request. 
If there is user information in your memories you have talked to this user before.

Here are your current memories:
  Self: {{memory.self}}
  User: {{memory.user}}
  Directives: {{memory.directives}}
  Topics: {{memory.topics}}

The current time and date in GMT is {{now}}, but references like "today" or "yesterday" are relative to the user's time zone. If you remember the user's time zone, use it - it's possible that the day for the user is different than the day in GMT.

Remember, if you are going to call a tool, let the user know before you do so. And don't forget your Voice Response Guidelines. These are both very important!
`;

export class SocketServer {
  private readonly apiKey: string;
  private readonly corsHosts: string;
  private io: Server | null;
  private httpServer: HTTPServer | null;

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
    socket.data.userId = socket.handshake.query.userId as string;
    socket.data.aiName = socket.handshake.query.aiName as string;
    socket.data.userName = socket.handshake.query.userName as string;
    const voice = (socket.handshake.query.voice as string || 'alloy') as Voice;

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
      if (item.type === 'function_call') {
        tools.initCall(item.call_id || '', item.name || '', item.arguments || '');
      } else if (item.type === 'message') {
        socket.emit('conversationUpdated', item, {});
      }
    });
    client.on('response.function_call_arguments.done', (event) => {
      tools.executeCall(event.call_id,
        event.arguments,
        socket.data.userId,
        socket.data.aiName);
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
        const cortexHistory = tools.getCortextHistory();
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
      .replace('{{memory.self}}', memorySelf)
      .replace('{{memory.user}}', memoryUser)
      .replace('{{memory.directives}}', memoryDirectives)
      .replace('{{memory.topics}}', memoryTopics)
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
