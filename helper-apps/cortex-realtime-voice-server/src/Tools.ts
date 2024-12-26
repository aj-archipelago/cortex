import {Socket} from "socket.io";
import {createId} from "@paralleldrive/cuid2";
import type {InterServerEvents, SocketData} from "./SocketServer";
import type {RealtimeVoiceClient} from "./realtime/client";
import type {ClientToServerEvents, ServerToClientEvents} from "./realtime/socket";
import {search} from "./cortex/search";
import {expert} from "./cortex/expert";
import {image} from "./cortex/image";
import {vision} from "./cortex/vision";
import {reason} from "./cortex/reason";
import { logger } from './utils/logger';

type Call = {
  call_id: string;
  name: string;
  arguments: string;
}

export class Tools {
  private callList: Array<Call> = [];
  private realtimeClient: RealtimeVoiceClient;
  private socket: Socket<ClientToServerEvents,
    ServerToClientEvents,
    InterServerEvents,
    SocketData>;
  private aiResponding: boolean = false;
  private audioPlaying: boolean = false;
  private audioDataSize: number = 0;

  constructor(client: RealtimeVoiceClient,
              socket: Socket<ClientToServerEvents,
                ServerToClientEvents,
                InterServerEvents,
                SocketData>) {
    this.realtimeClient = client;
    this.socket = socket;

    // Track AI response state
    client.on('response.created', () => {
      this.aiResponding = true;
    });

    client.on('response.done', () => {
      this.aiResponding = false;
    });

    // Track audio playback state
    client.on('response.audio.delta', ({delta}) => {
      this.audioPlaying = true;
      // Accumulate the size of base64 decoded audio data
      const dataSize = Buffer.from(delta, 'base64').length;
      this.audioDataSize += dataSize;
    });

    client.on('response.audio.done', () => {
      const duration = this.calculateAudioDuration(this.audioDataSize);
      logger.log(`Audio data complete (${this.audioDataSize} bytes, estimated ${duration}ms duration), waiting for playback`);
      
      // Reset data size counter for next audio
      this.audioDataSize = 0;
      
      // Wait for estimated duration plus a small buffer
      setTimeout(() => {
        logger.log('Estimated audio playback complete');
        this.audioPlaying = false;
      }, duration + 1000); // Add 1 second buffer for safety
    });
  }

  // Calculate duration in milliseconds from PCM16 audio data size
  private calculateAudioDuration(dataSize: number): number {
    const bytesPerSample = 2; // 16-bit = 2 bytes per sample
    const sampleRate = 24000; // 24kHz
    const channels = 1; // mono
    const samples = dataSize / bytesPerSample / channels;
    const durationMs = (samples / sampleRate) * 1000;
    return Math.ceil(durationMs);
  }

  private async sendSystemPrompt(prompt: string, allowTools: boolean = false, disposable: boolean = true) {
    // Don't send prompt if AI is currently responding or audio is playing
    if (this.aiResponding || this.audioPlaying) {
      logger.log(`${disposable ? 'Skipping' : 'Queuing'} prompt while AI is ${this.aiResponding ? 'responding' : 'playing audio'}`);
      if (!disposable) {
        // Try again after a short delay if the message is important
        setTimeout(() => {
          this.sendSystemPrompt(prompt, allowTools, disposable);
        }, 1000);
      }
      return;
    }

    logger.log('Sending system prompt');
    this.realtimeClient.createConversationItem({
      id: createId(),
      type: 'message',
      role: 'system',
      content: [
        {type: 'input_text', text: prompt}
      ]
    });

    this.realtimeClient.createResponse({tool_choice: allowTools ? 'auto' : 'none'});
  }

  public static getToolDefinitions() {
    return [
      {
        type: 'function',
        name: 'Search',
        description: 'Use for current events, news, fact-checking, and information requiring citation. This tool can search the internet, all Al Jazeera news articles and the latest news wires from multiple sources. You pass in detailed instructions about what you need the tool to do in detailedInstructions.',
        parameters: {
          type: "object",
          properties: {
            detailedInstructions: {type: "string"},
            silent: {type: "boolean", default: false}
          },
          required: ["detailedInstructions", "silent"]
        },
      },
      {
        type: 'function',
        name: 'Document',
        description: 'Access user\'s personal document index. Use for user-specific uploaded information. If user refers vaguely to "this document/file/article" without context, search the personal index. You pass in detailed instructions about what you need the tool to do in detailedInstructions.',
        parameters: {
          type: "object",
          properties: {
            detailedInstructions: {type: "string"},
            silent: {type: "boolean", default: false}
          },
          required: ["detailedInstructions", "silent"]
        },
      },
      {
        type: 'function',
        name: 'Write',
        description: 'Engage for any task related to composing, editing, or refining written content. This includes articles, essays, scripts, or any form of textual creation or modification. If you need to search for information or look at a document first, use the Search or Document tools. This tool is just to create or modify content. You pass in detailed instructions about what you need the tool to do in detailedInstructions.',
        parameters: {
          type: "object",
          properties: {
            detailedInstructions: {type: "string"},
            silent: {type: "boolean", default: false}
          },
          required: ["detailedInstructions"]
        },
      },
      {
        type: 'function',
        name: 'Image',
        description: 'Use this tool when asked to create, generate, or revise visual content including selfies, photographs, illustrations, diagrams, or any other type of image. You pass in detailed instructions about the image(s) you want to create in detailedInstructions. This tool only creates images - it cannot manipulate images (e.g. it cannot crop, rotate, or resize an existing image) - for those tasks you will need to use the CodeExecution tool.',
        parameters: {
          type: "object",
          properties: {
            detailedInstructions: {type: "string"},
            silent: {type: "boolean", default: false}
          },
          required: ["detailedInstructions"]
        },
      },
      {
        type: 'function',
        name: 'Reason',
        description: 'Use this tool any time you need to think carefully about something or solve a problem. Use it to solve all math problems, logic problems, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices. Also use when deep, step-by-step reasoning is required. You pass in detailed instructions about what you need the tool to do in detailedInstructions.',
        parameters: {
          type: "object",
          properties: {
            detailedInstructions: {type: "string"},
            silent: {type: "boolean", default: false}
          },
          required: ["detailedInstructions", "silent"]
        },
      },
      // {
      //   type: 'function',
      //   name: 'Code',
      //   description: 'Engage for any programming-related tasks, including creating, modifying, reviewing, or explaining code. Use for general coding discussions or when specific programming expertise is needed.',
      //   parameters: {
      //     type: "object",
      //     properties: {
      //       codingPrompt: {type: "string"}
      //     },
      //     required: ["codingPrompt"]
      //   },
      // },
      // {
      //   type: 'function',
      //   name: 'CodeExecution',
      //   description: 'Use when explicitly asked to run or execute code, or when a coding agent is needed to perform specific tasks that require code execution like data analysis, data processing, image processing, or business intelligence tasks.',
      //   parameters: {
      //     type: "object",
      //     properties: {
      //       codeExecutionPrompt: {type: "string"}
      //     },
      //     required: ["codeExecutionPrompt"]
      //   },
      // },
      // {
      //   type: 'function',
      //   name: 'PDF',
      //   description: 'Use specifically for processing and answering questions about PDF file content.',
      //   parameters: {
      //     type: "object",
      //     properties: {
      //       query: {type: "string"}
      //     },
      //     required: ["query"]
      //   },
      // },
      // {
      //   type: 'function',
      //   name: 'Vision',
      //   description: 'Engage for analyzing and responding to queries about image files (jpg, gif, bmp, png, etc).',
      //   parameters: {
      //     type: "object",
      //     properties: {
      //       query: {type: "string"}
      //     },
      //     required: ["query"]
      //   },
      // },
      // {
      //   type: 'function',
      //   name: 'Video',
      //   description: 'Use for processing and answering questions about video or audio file content.',
      //   parameters: {
      //     type: "object",
      //     properties: {
      //       query: {type: "string"}
      //     },
      //     required: ["query"]
      //   },
      // }
    ];
  }

  initCall(call_id: string, name: string, args: string) {
    this.callList.push({call_id, name, arguments: args});
  }

  updateCall(call_id: string, args: string) {
    const call = this.callList.find((c) => c.call_id === call_id);
    if (!call) {
      throw new Error(`Call with id ${call_id} not found`);
    }
    call.arguments = args;
  }

  async executeCall(call_id: string, args: string, contextId: string, aiName: string) {
    const call = this.callList.find((c) => c.call_id === call_id);
    logger.log('Executing call', call, 'with args', args);
    if (!call) {
      throw new Error(`Call with id ${call_id} not found`);
    }

    let fillerIndex = 0;
    let timeoutId: NodeJS.Timer | undefined;
    let isSilent = false;

    // Check if silent parameter is true in args
    try {
      const parsedArgs = JSON.parse(args);
      isSilent = parsedArgs.silent === true;
    } catch (e) {
      // Ignore JSON parse errors
    }

    const calculateFillerTimeout = (fillerIndex: number) => {
      const baseTimeout = 6500;
      const randomTimeout = Math.floor(Math.random() * Math.min((fillerIndex + 1) * 1000, 5000));
      return baseTimeout + randomTimeout;
    }

    const sendFillerMessage = async () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      // Skip filler messages if silent
      if (!isSilent) {
        // Filler messages are disposable - skip if busy
        await this.sendSystemPrompt(`You are currently using the ${call.name} tool to help with the user's request and several seconds have passed since your last voice response. You should respond to the user via audio with a brief vocal utterance e.g. \"hmmm\" or \"let's see\" that will let them know you're still there. Make sure to sound natural and human and fit the tone of the conversation. Keep it very short.`, false, true);
      }

      fillerIndex++;
      // Set next timeout with random interval
      timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
    }

    // Skip initial message if silent
    if (!isSilent) {
      // Initial message is not disposable - keep trying if busy
      await this.sendSystemPrompt(`You are currently using the ${call.name} tool to help with the user's request. If you haven't yet told the user via voice that you're doing something, do so now. Keep it very short and make it fit the conversation naturally. Examples: "I'm on it.", "I'm not sure. Let me look that up.", "Give me a moment to read the news.", "I'm checking on that now.", etc.`, false, false);
    }

    // Update the user if it takes a while to complete
    timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));

    let finishPrompt =`You have finished using the ${call.name} tool to help with the user's request. If you didn't get the results you wanted, need more information, or have more steps in your process, you can call another tool right now. If you choose not to call another tool because you have everything you need, respond to the user via audio`;

    try {
      const cortexHistory = this.getCortexHistory(args);
      logger.log('Cortex history', cortexHistory);
      let response;
      // Declare imageUrls at a higher scope
      const imageUrls = new Set<string>();
      switch (call.name.toLowerCase()) {
        case 'search':
        case 'document':
          response = await search(
            contextId,
            aiName,
            cortexHistory,
            call.name === 'Search' ? ['aje', 'aja', 'bing', 'wires', 'mydata'] : ['mydata'],
            JSON.stringify({query: args})
          );
          finishPrompt += ' by reading the output of the tool to the user verbatim'
          break;

        case 'write':
        case 'code':
          response = await expert(
            contextId,
            aiName,
            cortexHistory,
            JSON.stringify({query: args})
          );
          finishPrompt += ' by reading the output of the tool to the user verbatim'
          break;

        case 'image':
          const argsObject = JSON.parse(args);
          response = await image(
            contextId,
            aiName,
            cortexHistory,
            JSON.stringify({query: args})
          );
          
          // Extract image URLs from markdown ![...](url), HTML <img src="url">, and standard markdown links [text](url)
          const markdownImagePattern = /!\[.*?\]\((.*?)\)/g;
          const htmlPattern = /<img.*?src=["'](.*?)["']/g;
          const markdownLinkPattern = /\[.*?\]\((.*?)\)/g;
          
          let match;
          
          // Find markdown image URLs
          while ((match = markdownImagePattern.exec(response.result)) !== null) {
            imageUrls.add(match[1]);
          }
          
          // Find HTML image URLs
          while ((match = htmlPattern.exec(response.result)) !== null) {
            imageUrls.add(match[1]);
          }
          
          // Find standard markdown link URLs
          while ((match = markdownLinkPattern.exec(response.result)) !== null) {
            const url = match[1];
            // Only add URLs that appear to be image files
            if (url.match(/\.(jpg|jpeg|png|gif|webp|bmp)$/i)) {
              imageUrls.add(url);
            }
          }
          break;

        case 'pdf':
        case 'vision':
        case 'video':
          response = await vision(
            contextId,
            aiName,
            cortexHistory,
            JSON.stringify({query: args})
          );
          break;

        case 'reason':
          response = await reason(
            contextId,
            aiName,
            cortexHistory,
            JSON.stringify({query: args})
          );
          finishPrompt += ' by reading the output of the tool to the user verbatim'
          break;

        default:
          logger.log('Unknown function call', call);
      }
      logger.log(response);

      // Clear timer before creating final output
      if (timeoutId) {
        clearTimeout(timeoutId);
        // This is to avoid voice run-on if we were using please wait...
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      await this.realtimeClient.createConversationItem({
        id: createId(),
        type: 'function_call_output',
        call_id: call.call_id,
        output: response?.result || '',
      });

      if (isSilent) {
        finishPrompt = `You have finished using the ${call.name} tool. If you didn't get the results you wanted, need more information, or have more steps in your process, you can call another tool right now`;
      }

      finishPrompt += '.';
      await this.sendSystemPrompt(finishPrompt, true, false);

      // Send image events after finish prompt if we collected any
      if (call.name.toLowerCase() === 'image' && imageUrls.size > 0) {
        imageUrls.forEach(url => {
          this.socket.emit('imageCreated', url);
        });
      }

      this.callList = this.callList.filter((c) => c.call_id !== call_id);
    } catch (error) {
      // Make sure to clear timer if there's an error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      throw error;
    }
  }

  public getCortexHistory(args: string = '') {
    const history = this.realtimeClient.getConversationItems()
      .filter((item) => item.type === "message" && item.role !== "system")
      .map((item) => {
        return {
          role: item.role || 'user',
          content: item.content && item.content[0] ? item.content[0].text || item.content[0].transcript || '' : ''
        }
      });

    // Add lastUserMessage if it exists in the current call
    if (args) {
      try {
        const parsedArgs = JSON.parse(args);
        if (parsedArgs.lastUserMessage || parsedArgs.detailedInstructions) {
          history.push({
            role: 'user',
            content: parsedArgs.lastUserMessage || parsedArgs.detailedInstructions
          });
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }

    return history;
  }
}
