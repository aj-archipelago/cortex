import axios from 'axios';

export async function collectAnthropicSSE(baseUrl, endpoint, payload, timeoutMs = 60000) {
  const events = [];
  await connectAnthropicSSE(baseUrl, endpoint, payload, (event) => {
    events.push(event);
  }, timeoutMs);
  return events;
}

export async function connectAnthropicSSE(baseUrl, endpoint, payload, onEvent, timeoutMs = 60000) {
  return new Promise(async (resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fn(value);
    };
    const timeout = setTimeout(() => {
      settle(reject, new Error('Anthropic SSE timeout'));
    }, timeoutMs);

    try {
      const instance = axios.create({
        baseURL: baseUrl,
        responseType: 'stream',
      });

      const response = await instance.post(endpoint, payload);
      const stream = response.data;

      let buffer = '';
      let currentEvent = 'message';
      let dataLines = [];

      const flushEvent = () => {
        if (dataLines.length === 0) return;
        const dataRaw = dataLines.join('\n');
        let data = dataRaw;
        try {
          data = JSON.parse(dataRaw);
        } catch {
          // Keep raw data for non-JSON SSE frames.
        }
        onEvent?.({ event: currentEvent, data, dataRaw });
        dataLines = [];
        currentEvent = 'message';
      };

      const processLine = (line) => {
        if (line === '') {
          flushEvent();
          return;
        }

        if (line.startsWith('event:')) {
          currentEvent = line.replace(/^event:\s*/, '').trim() || 'message';
          return;
        }

        if (line.startsWith('data:')) {
          dataLines.push(line.replace(/^data:\s*/, ''));
        }
      };

      stream.on('data', (chunk) => {
        buffer += chunk.toString();
        let index = buffer.indexOf('\n');
        while (index !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);
          processLine(line);
          index = buffer.indexOf('\n');
        }
      });

      stream.on('end', () => {
        flushEvent();
        settle(resolve);
      });

      stream.on('close', () => {
        flushEvent();
        settle(resolve);
      });

      stream.on('error', (error) => {
        settle(reject, error);
      });
    } catch (error) {
      settle(reject, error);
    }
  });
}
