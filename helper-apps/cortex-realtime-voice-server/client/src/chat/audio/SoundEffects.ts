export class SoundEffects {
  private static audioContext: AudioContext | null = null;
  private static connectBuffer: AudioBuffer | null = null;
  private static disconnectBuffer: AudioBuffer | null = null;

  private static async getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  private static async loadSound(url: string): Promise<AudioBuffer> {
    const context = await this.getAudioContext();
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    return await context.decodeAudioData(arrayBuffer);
  }

  static async init() {
    try {
      this.connectBuffer = await this.loadSound('/sounds/connect.mp3');
      this.disconnectBuffer = await this.loadSound('/sounds/disconnect.mp3');
    } catch (error) {
      console.error('Failed to load sound effects:', error);
    }
  }

  static async playConnect() {
    if (!this.connectBuffer) return;
    
    try {
      const context = await this.getAudioContext();
      const source = context.createBufferSource();
      source.buffer = this.connectBuffer;
      source.connect(context.destination);
      source.start(0);
    } catch (error) {
      console.error('Failed to play connect sound:', error);
    }
  }

  static async playDisconnect() {
    if (!this.disconnectBuffer) return;
    
    try {
      const context = await this.getAudioContext();
      const source = context.createBufferSource();
      source.buffer = this.disconnectBuffer;
      source.connect(context.destination);
      source.start(0);
    } catch (error) {
      console.error('Failed to play disconnect sound:', error);
    }
  }
} 