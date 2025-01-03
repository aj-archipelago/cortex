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
    this.maxNoBufferFrames = 100;
    this.lastUnderrunLog = 0;

    this.port.onmessage = (event) => {
      try {
        if (event.data) {
          const payload = event.data;
          if (payload.event === 'write') {
            const int16Array = payload.buffer;
            const float32Array = new Float32Array(int16Array.length);
            for (let i = 0; i < int16Array.length; i++) {
              float32Array[i] = int16Array[i] / 0x8000;
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
        const finalBuffer = new Float32Array(this.bufferLength);
        finalBuffer.set(buffer.subarray(0, offset));
        this.outputBuffers.push({ buffer: finalBuffer, trackId });
        this.write = { buffer: new Float32Array(this.bufferLength), trackId };
        this.writeOffset = 0;
      } else {
        this.writeOffset = offset;
      }
      
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
        outputChannelData.fill(0);
        return true;
      } else if (outputBuffers.length > 0) {
        this.hasStarted = true;
        this.noBufferCount = 0;
        this.lastUnderrunLog = 0;
        
        const { buffer, trackId } = outputBuffers.shift();
        outputChannelData.set(buffer);
        
        if (trackId) {
          this.trackSampleOffsets[trackId] =
            this.trackSampleOffsets[trackId] || 0;
          this.trackSampleOffsets[trackId] += buffer.length;
          
          // If this was the last buffer for this track, notify completion
          if (outputBuffers.length === 0 || outputBuffers[0].trackId !== trackId) {
            this.port.postMessage({ 
              event: 'track_complete',
              trackId,
              finalOffset: this.trackSampleOffsets[trackId]
            });
          }
        }
        return true;
      } else if (this.hasStarted) {
        this.noBufferCount++;
        
        if (this.noBufferCount >= 5 && currentTime - this.lastUnderrunLog > 1) {
          this.port.postMessage({ 
            event: 'underrun', 
            count: this.noBufferCount,
            bufferSize: this.outputBuffers.length,
            maxBuffers: this.maxNoBufferFrames
          });
          this.lastUnderrunLog = currentTime;
        }
        
        if (this.noBufferCount >= this.maxNoBufferFrames) {
          this.port.postMessage({ 
            event: 'stop',
            reason: 'max_underruns_reached',
            finalCount: this.noBufferCount
          });
          return false;
        }
        outputChannelData.fill(0);
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
