import axios from 'axios';

// Connects to an SSE endpoint and resolves when [DONE] is received.
// Calls onEvent for each parsed SSE message JSON.
export async function connectToSSEEndpoint(baseUrl, endpoint, payload, onEvent) {
  return new Promise(async (resolve, reject) => {
    try {
      const instance = axios.create({
        baseURL: baseUrl,
        responseType: 'stream',
      });

      const response = await instance.post(endpoint, payload);
      const responseData = response.data;

      const incomingMessage = Array.isArray(responseData) && responseData.length > 0
        ? responseData[0]
        : responseData;

      let eventCount = 0;

      incomingMessage.on('data', data => {
        const events = data.toString().split('\n');

        events.forEach(event => {
          if (event.trim() === '') return;

          eventCount++;

          if (event.trim() === 'data: [DONE]') {
            resolve();
            return;
          }

          const message = event.replace(/^data: /, '');
          try {
            const messageJson = JSON.parse(message);
            onEvent && onEvent(messageJson);
          } catch (_err) {
            // ignore lines that are not JSON
          }
        });
      });
    } catch (error) {
      reject(error);
    }
  });
}


