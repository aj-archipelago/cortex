export const StreamProcessorWorklet = `
class StreamProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.hasStarted = false;
    this.hasInterrupted = false;
    this.outputBuffers = [];
    this.bufferLength = 128;
    this.minBufferSize = 3;
    this.write = { buffer: new Float32Array(this.bufferLength), trackId: null };
    this.writeOffset = 0;
    this.trackSampleOffsets = {};
    this.lastErrorTime = 0;
    this.errorCount = 0;
    this.noBufferCount = 0;
    this.maxNoBufferFrames = 50; // Number of empty frames before stopping

    this.port.onmessage = (event) => {
      try {
        if (event.data) {
          const payload = event.data;
          if (payload.event === 'write') {
            const int16Array = payload.buffer;
            const float32Array = new Float32Array(int16Array.length);
            for (let i = 0; i < int16Array.length; i++) {
              float32Array[i] = int16Array[i] / 0x8000; // Convert Int16 to Float32
            }
            this.writeData(float32Array, payload.trackId);
          } else if (payload.event === 'config') {
            this.minBufferSize = payload.minBufferSize;
          } else if (
            payload.event === 'offset' ||
            payload.event === 'interrupt'
          ) {
            const requestId = payload.requestId;
            const trackId = this.write.trackId;
            const offset = this.trackSampleOffsets[trackId] || 0;
            this.port.postMessage({
              event: 'offset',
              requestId,
              trackId,
              offset,
            });
            if (payload.event === 'interrupt') {
              this.hasInterrupted = true;
            }
          } else {
            throw new Error(\`Unhandled event "\${payload.event}"\`);
          }
        }
      } catch (error) {
        this.handleError(error);
      }
    };
  }

  handleError(error) {
    const now = currentTime;
    if (now - this.lastErrorTime > 5) {
      // Reset error count if more than 5 seconds have passed
      this.errorCount = 0;
    }
    this.lastErrorTime = now;
    this.errorCount++;

    if (this.errorCount <= 3) {
      this.port.postMessage({
        event: 'error',
        error: error.message || 'Unknown error in stream processor'
      });
    }
  }

  writeData(float32Array, trackId = null) {
    try {
      let { buffer } = this.write;
      let offset = this.writeOffset;
      
      for (let i = 0; i < float32Array.length; i++) {
        buffer[offset++] = float32Array[i];
        if (offset >= buffer.length) {
          this.outputBuffers.push(this.write);
          this.write = { buffer: new Float32Array(this.bufferLength), trackId };
          buffer = this.write.buffer;
          offset = 0;
        }
      }
      
      // If we have a partial buffer at the end, push it too
      if (offset > 0) {
        // Create a new buffer of exact size needed
        const finalBuffer = new Float32Array(offset);
        finalBuffer.set(buffer.subarray(0, offset));
        this.outputBuffers.push({ buffer: finalBuffer, trackId });
        // Reset write buffer
        this.write = { buffer: new Float32Array(this.bufferLength), trackId };
        this.writeOffset = 0;
      } else {
        this.writeOffset = offset;
      }
      
      // Reset no buffer counter since we just got data
      this.noBufferCount = 0;
      return true;
    } catch (error) {
      this.handleError(error);
      return false;
    }
  }

  process(inputs, outputs, parameters) {
    try {
      const output = outputs[0];
      const outputChannelData = output[0];
      const outputBuffers = this.outputBuffers;

      if (this.hasInterrupted) {
        this.port.postMessage({ event: 'stop' });
        return false;
      } else if (!this.hasStarted && outputBuffers.length < this.minBufferSize) {
        // Wait for more buffers before starting
        return true;
      } else if (outputBuffers.length > 0) {
        this.hasStarted = true;
        this.noBufferCount = 0;
        
        const { buffer, trackId } = outputBuffers.shift();
        // Handle potentially smaller final buffer
        const samplesToCopy = Math.min(buffer.length, outputChannelData.length);
        for (let i = 0; i < samplesToCopy; i++) {
          outputChannelData[i] = buffer[i];
        }
        // Zero-fill any remaining samples in the output buffer
        for (let i = samplesToCopy; i < outputChannelData.length; i++) {
          outputChannelData[i] = 0;
        }
        
        if (trackId) {
          this.trackSampleOffsets[trackId] =
            this.trackSampleOffsets[trackId] || 0;
          this.trackSampleOffsets[trackId] += buffer.length;
        }
        return true;
      } else if (this.hasStarted) {
        // Count empty frames and only stop after a significant gap
        this.noBufferCount++;
        if (this.noBufferCount >= this.maxNoBufferFrames) {
          this.port.postMessage({ event: 'stop' });
          return false;
        }
        // Zero-fill the output while waiting
        for (let i = 0; i < outputChannelData.length; i++) {
          outputChannelData[i] = 0;
        }
      }
      return true;
    } catch (error) {
      this.handleError(error);
      return true;
    }
  }
}

registerProcessor('stream_processor', StreamProcessor);
`;

const script = new Blob([StreamProcessorWorklet], {
  type: 'application/javascript',
});
const src = URL.createObjectURL(script);
export const StreamProcessorSrc = src;
