import { StreamProcessorSrc } from './worklets/StreamProcessor';
import { AudioAnalysis, AudioAnalysisOutputType } from './analysis/AudioAnalysis';

interface WavStreamPlayerOptions {
  sampleRate?: number;
  minBufferSize?: number;
}

interface TrackSampleOffset {
  trackId: string | null;
  offset: number;
  currentTime: number;
}

/**
 * Plays audio streams received in raw PCM16 chunks from the browser
 */
export class WavStreamPlayer {
  private readonly scriptSrc: string;
  private readonly sampleRate: number;
  private readonly minBufferSize: number;
  private context: AudioContext | null;
  private stream: AudioWorkletNode | null;
  private analyser: AnalyserNode | null;
  private trackSampleOffsets: Record<string, TrackSampleOffset>;
  private interruptedTrackIds: Record<string, boolean>;
  private isRestarting: boolean;
  public onTrackComplete?: (trackId: string) => void;
  public currentTrackId: string | null;

  /**
   * Creates a new WavStreamPlayer instance
   * @param options
   */
  constructor({ sampleRate = 44100, minBufferSize = 10 }: WavStreamPlayerOptions = {}) {
    this.scriptSrc = StreamProcessorSrc;
    this.sampleRate = sampleRate;
    this.minBufferSize = minBufferSize;
    this.context = null;
    this.stream = null;
    this.analyser = null;
    this.trackSampleOffsets = {};
    this.interruptedTrackIds = {};
    this.isRestarting = false;
    this.currentTrackId = null;
  }

  /**
   * Connects the audio context and enables output to speakers
   */
  async connect(): Promise<boolean> {
    this.context = new AudioContext({ sampleRate: this.sampleRate });
    if (this.context.state === 'suspended') {
      await this.context.resume();
    }
    try {
      await this.context.audioWorklet.addModule(this.scriptSrc);
    } catch (e) {
      console.error(e);
      throw new Error(`Could not add audioWorklet module: ${this.scriptSrc}`);
    }
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    this.analyser = analyser;
    return true;
  }

  /**
   * Gets the current frequency domain data from the playing track
   * @param analysisType
   * @param minDecibels default -100
   * @param maxDecibels default -30
   */
  getFrequencies(
    analysisType: 'frequency' | 'music' | 'voice' = 'frequency',
    minDecibels = -100,
    maxDecibels = -30,
  ): AudioAnalysisOutputType {
    if (!this.analyser) {
      throw new Error('Not connected, please call .connect() first');
    }
    return AudioAnalysis.getFrequencies(
      this.analyser,
      this.sampleRate,
      null,
      analysisType,
      minDecibels,
      maxDecibels,
    );
  }

  /**
   * Starts audio streaming
   * @private
   */
  private _start(): boolean {
    if (!this.context) {
      throw new Error('AudioContext not initialized');
    }
    if (this.isRestarting) {
      return false;
    }
    try {
      const streamNode = new AudioWorkletNode(this.context, 'stream_processor');
      streamNode.connect(this.context.destination);
      streamNode.port.onmessage = (e: MessageEvent) => {
        const { event } = e.data;
        if (event === 'stop') {
          streamNode.disconnect();
          this.stream = null;
          this.isRestarting = false;
          if (e.data.reason === 'max_underruns_reached') {
            console.warn(`Audio stream stopped due to ${e.data.finalCount} consecutive underruns`);
          }
        } else if (event === 'offset') {
          const { requestId, trackId, offset } = e.data;
          const currentTime = offset / this.sampleRate;
          this.trackSampleOffsets[requestId] = { trackId, offset, currentTime };
        } else if (event === 'track_complete') {
          const { trackId } = e.data;
          this.onTrackComplete?.(trackId);
        } else if (event === 'error') {
          console.error('Stream processor error:', e.data.error);
          this._handleStreamError();
        } else if (event === 'underrun') {
          console.warn(
            `Audio buffer underrun: ${e.data.count} frames without data. ` +
            `Buffer size: ${e.data.bufferSize}/${e.data.maxBuffers}`
          );
        }
      };
      if (this.analyser) {
        this.analyser.disconnect();
        streamNode.connect(this.analyser);
      }
      this.stream = streamNode;
      // Send minBufferSize to the worklet
      streamNode.port.postMessage({ event: 'config', minBufferSize: this.minBufferSize });
      return true;
    } catch (error) {
      console.error('Error starting stream:', error);
      this.isRestarting = false;
      return false;
    }
  }

  /**
   * Handles stream errors by attempting to restart
   * @private
   */
  private async _handleStreamError() {
    if (this.isRestarting) return;
    
    this.isRestarting = true;
    try {
      if (this.stream) {
        this.stream.disconnect();
        this.stream = null;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      this._start();
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Adds 16BitPCM data to the currently playing audio stream
   * You can add chunks beyond the current play point and they will be queued for play
   * @param arrayBuffer
   * @param trackId
   */
  public add16BitPCM(pcmData: ArrayBuffer, trackId: string) {
    if (!this.context || !this.analyser) {
      return new Int16Array();
    }

    this.currentTrackId = trackId;
    try {
      if (this.interruptedTrackIds[trackId]) {
        return new Int16Array();
      }
      
      if (!this.stream && !this._start()) {
        throw new Error('Failed to start audio stream');
      }

      let buffer: Int16Array;
      try {
        if (pcmData instanceof Int16Array) {
          buffer = pcmData;
        } else {
          buffer = new Int16Array(pcmData);
        }
      } catch (error) {
        console.error('Error creating Int16Array:', error);
        return new Int16Array();
      }

      if (!buffer.length) {
        console.warn('Received empty buffer for track:', trackId);
        return buffer;
      }

      this.stream?.port.postMessage({ event: 'write', buffer, trackId });
      return buffer;
    } catch (error) {
      console.error('Error processing audio chunk:', error);
      this._handleStreamError();
      return new Int16Array();
    }
  }

  /**
   * Clears the interrupted state for a track
   * @param trackId
   */
  clearInterruptedState(trackId: string): void {
    delete this.interruptedTrackIds[trackId];
  }

  /**
   * Clears all interrupted states
   */
  clearAllInterruptedStates(): void {
    this.interruptedTrackIds = {};
  }

  /**
   * Gets the offset (sample count) of the currently playing stream
   * @param interrupt
   */
  async getTrackSampleOffset(interrupt = false): Promise<TrackSampleOffset | null> {
    if (!this.stream) {
      return null;
    }
    const requestId = crypto.randomUUID();
    this.stream.port.postMessage({
      event: interrupt ? 'interrupt' : 'offset',
      requestId,
    });
    let trackSampleOffset: TrackSampleOffset | undefined;
    while (!trackSampleOffset) {
      trackSampleOffset = this.trackSampleOffsets[requestId];
      await new Promise((r) => setTimeout(() => r(null), 1));
    }
    const { trackId } = trackSampleOffset;
    if (interrupt && trackId) {
      this.interruptedTrackIds[trackId] = true;
    }
    return trackSampleOffset;
  }

  /**
   * Strips the current stream and returns the sample offset of the audio
   */
  async interrupt(): Promise<TrackSampleOffset | null> {
    return this.getTrackSampleOffset(true);
  }

  /**
   * Gets the analyser node
   */
  getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  /**
   * Sets a callback to be called when a track completes playback
   * @param callback The callback function that receives the trackId
   */
  setTrackCompleteCallback(callback: (trackId: string) => void) {
    this.onTrackComplete = callback;
  }

  async fadeOut(durationMs: number) {
    if (!this.context) return;
    const gainNode = this.context.createGain();
    gainNode.gain.setValueAtTime(1, this.context.currentTime);
    gainNode.gain.linearRampToValueAtTime(0, this.context.currentTime + durationMs / 1000);
    
    // Insert gain node before destination
    this.stream?.disconnect();
    this.stream?.connect(gainNode);
    gainNode.connect(this.context.destination);
    
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }
}
