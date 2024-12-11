
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
export type MemorySection = "memorySelf" | "memoryUser" | "memoryTopics" | "memoryDirectives"
export type CortextVariables = {
  contextId?: string,
  aiName?: string,
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
}

export async function getCortexResponse(
  variables: CortextVariables,
  query: string) {
  const headers = getHeaders();
  const body = {
    query,
    variables
  }
  const res = await fetch(getCortexUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    console.log(res)
    throw new Error('Failed to fetch data')
  }

  const responseObject = await res.json();
  // console.log('cortext response', responseObject);
  return responseObject.data;
}
