import type {RealtimeItem} from "./realtimeTypes";

type DeltaType = {
  transcript?: string;
  audio?: string;
  text?: string;
  arguments?: string;
};

export interface ServerToClientEvents {
  error: (message: string) => void;
  ready: () => void;
  conversationUpdated: (item: RealtimeItem, delta: DeltaType) => void;
  conversationInterrupted: () => void;
  imageCreated: (imageUrl: string) => void;
  requestScreenshot: () => void;
}

export interface ClientToServerEvents {
  sendMessage: (message: string) => void;
  appendAudio: (audio: string) => void;
  cancelResponse: () => void;
  conversationCompleted: () => void;
  audioPlaybackComplete: (trackId: string) => void;
  screenshotCaptured: (imageData: string) => void;
  screenshotError: (error: string) => void;
}
