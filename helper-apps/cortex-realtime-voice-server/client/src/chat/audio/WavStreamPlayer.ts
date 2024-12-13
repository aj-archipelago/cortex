import { StreamProcessorSrc } from './worklets/StreamProcessor';
import { AudioAnalysis, AudioAnalysisOutputType } from './analysis/AudioAnalysis';

interface WavStreamPlayerOptions {
  sampleRate?: number;
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
  private context: AudioContext | null;
  private stream: AudioWorkletNode | null;
  private analyser: AnalyserNode | null;
  private trackSampleOffsets: Record<string, TrackSampleOffset>;
  private interruptedTrackIds: Record<string, boolean>;

  /**
   * Creates a new WavStreamPlayer instance
   * @param options
   */
  constructor({ sampleRate = 44100 }: WavStreamPlayerOptions = {}) {
    this.scriptSrc = StreamProcessorSrc;
    this.sampleRate = sampleRate;
    this.context = null;
    this.stream = null;
    this.analyser = null;
    this.trackSampleOffsets = {};
    this.interruptedTrackIds = {};
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
    const streamNode = new AudioWorkletNode(this.context, 'stream_processor');
    streamNode.connect(this.context.destination);
    streamNode.port.onmessage = (e: MessageEvent) => {
      const { event } = e.data;
      if (event === 'stop') {
        streamNode.disconnect();
        this.stream = null;
      } else if (event === 'offset') {
        const { requestId, trackId, offset } = e.data;
        const currentTime = offset / this.sampleRate;
        this.trackSampleOffsets[requestId] = { trackId, offset, currentTime };
      }
    };
    if (this.analyser) {
      this.analyser.disconnect();
      streamNode.connect(this.analyser);
    }
    this.stream = streamNode;
    return true;
  }

  /**
   * Adds 16BitPCM data to the currently playing audio stream
   * You can add chunks beyond the current play point and they will be queued for play
   * @param arrayBuffer
   * @param trackId
   */
  add16BitPCM(arrayBuffer: ArrayBuffer | Int16Array, trackId: string = 'default'): Int16Array {
    if (this.interruptedTrackIds[trackId]) {
      return new Int16Array();
    }
    if (!this.stream) {
      this._start();
    }
    let buffer: Int16Array;
    if (arrayBuffer instanceof Int16Array) {
      buffer = arrayBuffer;
    } else {
      buffer = new Int16Array(arrayBuffer);
    }
    this.stream?.port.postMessage({ event: 'write', buffer, trackId });
    return buffer;
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
}
