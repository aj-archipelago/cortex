import { logger } from '../utils/logger';

function getCortexApiKey() {
  if (process.env.NODE_ENV === 'production') {
    return process.env.CORTEX_API_KEY || ''
  } else if (process.env.NODE_ENV === 'test') {
    return process.env.CORTEX_DEV_API_KEY || ''
  }
  return '';
}

function getCortexUrl() {
  if (process.env.NODE_ENV === 'production') {
    return 'https://cortex.aljazeera.com/graphql'
  } else if (process.env.NODE_ENV === 'test') {
    return 'https://cortex.aljazeera.com/dev/graphql';
  }
  return 'http://localhost:4000/graphql';
}

function getHeaders() {
  const headers: HeadersInit = new Headers();
  headers.set('accept', 'application/json');
  headers.set('Content-Type', 'application/json');
  headers.set('ocp-apim-subscription-key', getCortexApiKey());
  return headers;
}

export type ChatMessage = { role: string, content: string }
export type DataSource = "mydata" | "aja" | "aje" | "wires" | "bing"

export const MemorySection = {
  memorySelf: "memorySelf",
  memoryUser: "memoryUser",
  memoryTopics: "memoryTopics",
  memoryDirectives: "memoryDirectives",
  memoryAll: "memoryAll"
} as const;

export type MemorySection = typeof MemorySection[keyof typeof MemorySection];

export type CortexVariables = {
  contextId?: string,
  aiName?: string,
  aiStyle?: string,
  chatHistory?: ChatMessage[],
  text?: string,
  useMemory?: boolean,
  language?: string,
  dataSources?: DataSource[];
  section?: MemorySection;
  width?: number;
  height?: number;
  size?: string;
  style?: string;
  priority?: number;
  recentHours?: number;
}

function truncateBody(body: any): string {
  const str = JSON.stringify(body);
  if (str.length <= 5000) return str;
  
  const halfLength = 2500;
  return str.substring(0, halfLength) + '...' + str.substring(str.length - halfLength);
}

export async function getCortexResponse(
  variables: CortexVariables,
  query: string) {
  const headers = getHeaders();
  const body = {
    query,
    variables
  }
  logger.log(`Cortex URL: ${getCortexUrl()}`);
  logger.log(`Cortex Body: ${truncateBody(body)}`);
  logger.log(`Cortex Headers: ${JSON.stringify(headers)}`);
  const res = await fetch(getCortexUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    logger.error('Failed to fetch data:', res);
    throw new Error('Failed to fetch data')
  }

  const responseObject = await res.json();
  // Debug logging can be enabled/disabled via logger's environment control
  logger.debug('cortex response', responseObject);
  return responseObject.data;
}
