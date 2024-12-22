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

  constructor(client: RealtimeVoiceClient,
              socket: Socket<ClientToServerEvents,
                ServerToClientEvents,
                InterServerEvents,
                SocketData>) {
    this.realtimeClient = client;
    this.socket = socket;
  }

  public static getToolDefinitions() {
    return [
      {
        type: 'function',
        name: 'Search',
        description: 'Use for current events, news, fact-checking, and information requiring citation. This tool can search the internet, all Al Jazeera news articles and the latest news wires from multiple sources. Only search when necessary for current events, user documents, latest news, or complex topics needing grounding. Don\'t search for remembered information or general knowledge within your capabilities.',
        parameters: {
          type: "object",
          properties: {
            query: {type: "string"}
          },
          required: ["query"]
        },
      },
      {
        type: 'function',
        name: 'Document',
        description: 'Access user\'s personal document index. Use for user-specific uploaded information. If user refers vaguely to "this document/file/article" without context, search the personal index.',
        parameters: {
          type: "object",
          properties: {
            query: {type: "string"}
          },
          required: ["query"]
        },
      },
      {
        type: 'function',
        name: 'Write',
        description: 'Engage for any task related to composing, editing, or refining written content. This includes articles, essays, scripts, or any form of textual creation or modification. If you need to search for information or look at a document first, use the Search or Document tools. This tool is just to create or modify content.',
        parameters: {
          type: "object",
          properties: {
            topic: {type: "string"}
          },
          required: ["topic"]
        },
      },
      {
        type: 'function',
        name: 'Image',
        description: 'Use when asked to create, generate, or revise visual content. This covers photographs, illustrations, diagrams, or any other type of image. This tool only creates images - it cannot manipulate images (e.g. it cannot crop, rotate, or resize an existing image) - for those tasks you will need to use the CodeExecution tool.',
        parameters: {
          type: "object",
          properties: {
            imageCreationPrompt: {type: "string"}
          },
          required: ["imageCreationPrompt"]
        },
      },
      {
        type: 'function',
        name: 'Reason',
        description: 'Employ for reasoning, scientific analysis, evaluating evidence, strategic planning, problem-solving, logic puzzles, mathematical calculations, or any questions that require careful thought or complex choices. Also use when deep, step-by-step reasoning is required.',
        parameters: {
          type: "object",
          properties: {
            reasonPrompt: {type: "string"}
          },
          required: ["reasonPrompt"]
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

  promptModel(prompt: string) {
    this.realtimeClient.createConversationItem({
      id: createId(),
      type: 'message',
      role: 'system',
      content: [
        {type: 'input_text', text: prompt}
      ]
    });

    this.realtimeClient.createResponse({});
  }

  async executeCall(call_id: string, args: string, contextId: string, aiName: string) {
    const call = this.callList.find((c) => c.call_id === call_id);
    console.log('Executing call', call, 'with args', args);
    if (!call) {
      throw new Error(`Call with id ${call_id} not found`);
    }

    let fillerIndex = 0;
    let timeoutId: NodeJS.Timer | undefined;

    const calculateFillerTimeout = (fillerIndex: number) => {
      const baseTimeout = 6500;
      const randomTimeout = Math.floor(Math.random() * Math.min((fillerIndex + 1) * 1000, 5000));
      return baseTimeout + randomTimeout;
    }

    const sendFillerMessage = async () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      this.promptModel("You are currently using a tool to help with the user's request and several seconds have passed since your last voice response. You should respond to the user via audio with a brief vocal utterance e.g. \"hmmm\" or \"let's see\" that will let them know you're still there. Make sure to sound natural and human and fit the tone of the conversation. Don't make another tool call until you have the result of the first one.");
      fillerIndex++;
      // Set next timeout with random interval
      timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
    }

    // Update the user if it takes a while to complete
    timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));

    let finishPrompt ='You have finished working on the user\'s request. Respond to the user via audio';

    try {
      const cortexHistory = this.getCortexHistory();
      console.log('Cortex history', cortexHistory);
      let response;
      switch (call.name.toLowerCase()) {
        case 'search':
        case 'document':
          response = await search(
            contextId,
            aiName,
            cortexHistory,
            call.name === 'Search' ? ['aje', 'bing', 'wires', 'mydata'] : ['mydata'],
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
          const imageUrls = new Set<string>();
          
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
          
          // Emit events for each unique image URL found
          imageUrls.forEach(url => {
            this.socket.emit('imageCreated', url);
          });
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
          console.log('Unknown function call', call);
      }
      console.log(response);

      // Clear timer before creating final output
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      
      this.realtimeClient.createConversationItem({
        id: createId(),
        type: 'function_call_output',
        call_id: call.call_id,
        output: response?.result || '',
      });

      finishPrompt += '.';
      this.promptModel(finishPrompt);

      this.callList = this.callList.filter((c) => c.call_id !== call_id);
    } catch (error) {
      // Make sure to clear timer if there's an error
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      throw error;
    }
  }

  public getCortexHistory() {
    return this.realtimeClient.getConversationItems()
      .filter((item) => item.type === "message")
      .map((item) => {
        return {
          role: item.role || 'user',
          content: item.content && item.content[0] ? item.content[0].text || item.content[0].transcript || '' : ''
        }
      });
  }
}
