import axios from 'axios';

// Connects to an SSE endpoint and resolves when [DONE] is received.
// Calls onEvent for each parsed SSE message JSON.
export async function connectToSSEEndpoint(baseUrl, endpoint, payload, onEvent) {
  return new Promise(async (resolve, reject) => {
    let sawDone = false;
    const timeout = setTimeout(() => {
      reject(new Error('SSE timeout waiting for [DONE]'));
    }, 20000); // 20 second timeout
    
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
            sawDone = true;
            clearTimeout(timeout);
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

      // If the underlying stream ends without a [DONE], treat as failure
      incomingMessage.on('end', () => {
        if (!sawDone) {
          clearTimeout(timeout);
          reject(new Error('SSE stream ended without [DONE]'));
        }
      });

      incomingMessage.on('close', () => {
        if (!sawDone) {
          clearTimeout(timeout);
          reject(new Error('SSE stream closed without [DONE]'));
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}


