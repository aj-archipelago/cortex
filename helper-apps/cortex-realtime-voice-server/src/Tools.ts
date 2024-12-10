import {Socket} from "socket.io";
import {createId} from "@paralleldrive/cuid2";
import type {InterServerEvents, SocketData} from "./SocketServer";
import type {RealtimeVoiceClient} from "./realtime/client";
import type {ClientToServerEvents, ServerToClientEvents} from "./realtime/socket";
import {search} from "./cortex/search";
import {expert} from "./cortex/expert";
import {image_replicate} from "./cortex/image";
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
        description: 'Search for current events, news, fact-checking, and information requiring citation. This tool can search the internet, all Al Jazeera news articles and the latest news wires from multiple sources.',
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
        description: 'Write a piece of content: Use for any task related to composing, editing, or refining written content. This includes articles, essays, scripts, or any form of textual creation or modification. If you need to search for information or look at a document first, use the Search or Document tools. This tool is just to create or modify content.',
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
        description: 'Create an Image: Use when asked to create, generate, or revise visual content. This covers photographs, illustrations, diagrams, or any other type of image. This tool only creates new images - it cannot manipulate images (e.g. it cannot crop, rotate, or resize an existing image) - for those tasks you will need to use the CodeExecution tool.',
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

  async executeCall(call_id: string, args: string, contextId: string, aiName: string) {
    const call = this.callList.find((c) => c.call_id === call_id);
    console.log('Executing call', call, 'with args', args);
    if (!call) {
      throw new Error(`Call with id ${call_id} not found`);
    }
    const cortexHistory = this.getCortextHistory();
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
        break;

      case 'write':
      case 'code':
        response = await expert(
          contextId,
          aiName,
          cortexHistory,
          JSON.stringify({query: args})
        );
        break;

      case 'image':
        const argsObject = JSON.parse(args);
        response = await image_replicate(contextId, argsObject.imageCreationPrompt, 1024, 1024);
        const imageData = JSON.parse(response.result);
        if (imageData && imageData.output) {
          this.socket.emit('imageCreated', imageData.output);
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
        break;

      default:
        console.log('Unknown function call', call);
    }
    console.log(response);
    this.realtimeClient.createConversationItem({
      id: createId(),
      type: 'function_call_output',
      call_id: call.call_id,
      output: response.result,
    });
    this.realtimeClient.createResponse({});

    this.callList = this.callList.filter((c) => c.call_id !== call_id);
  }

  public getCortextHistory() {
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
