'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {io, Socket} from 'socket.io-client';
import {WavRecorder} from './audio/WavRecorder';
import {WavStreamPlayer} from './audio/WavStreamPlayer';
import {ChatMessage, ChatTile} from './ChatTile';
import {arrayBufferToBase64, base64ToArrayBuffer} from "./utils/audio";
import {ClientToServerEvents, ServerToClientEvents} from "../../../src/realtime/socket";
import { AudioVisualizer } from './components/AudioVisualizer';
import { MicrophoneVisualizer } from './components/MicrophoneVisualizer';
import { ImageOverlay } from './components/ImageOverlay';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import PhoneEnabledIcon from '@mui/icons-material/PhoneEnabled';
import CallEndIcon from '@mui/icons-material/CallEnd';
import type { Voice } from '../../../src/realtime/realtimeTypes';

type ChatProps = {
  userId: string;
  userName: string;
  aiName: string;
  language: string;
  aiMemorySelfModify: boolean;
  aiStyle: string;
  voice: Voice;
};

export default function Chat({
  userId,
  userName,
  aiName,
  language,
  aiMemorySelfModify,
  aiStyle,
  voice
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({sampleRate: 24000}),
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({sampleRate: 24000}),
  );
  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents>>(
      io(`/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}`, {autoConnect: false})
    );
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);

  const stopConversation = useCallback(async () => {
    console.log('Stopping conversation');
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    if (wavRecorder.getStatus() === "recording") {
      await wavRecorder.end();
      await wavStreamPlayer.interrupt();
      socketRef.current.emit('conversationCompleted');
      socketRef.current.removeAllListeners();
      socketRef.current.disconnect();

      // Clean up audio nodes
      if (sourceNodeRef.current) {
        sourceNodeRef.current.disconnect();
        sourceNodeRef.current = null;
      }
      if (outputAnalyserRef.current) {
        outputAnalyserRef.current.disconnect();
        outputAnalyserRef.current = null;
      }
      if (audioContextRef.current) {
        await audioContextRef.current.close();
        audioContextRef.current = null;
      }

      setIsRecording(false);
      setIsMuted(false);  // Reset mute state
    }
  }, []);

  const startConversation = useCallback(() => {
    console.log('Starting conversation');
    const socket = socketRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const wavRecorder = wavRecorderRef.current;

    const updateOrCreateMessage = (item: any, delta: any, isNewMessage = false) => {
      setMessages((prev) => {
        // Try to find an existing message from the same turn
        const existingIndex = prev.findIndex(m => 
          m.id === item.id || 
          m.id === `local-${item.timestamp}` ||  // This matches our local message ID format
          // Match user messages by timestamp (within 1 second) to catch server echoes
          (item.role === 'user' && m.isSelf && Math.abs(m.timestamp - (item.timestamp || Date.now())) < 1000)
        );

        if (existingIndex !== -1) {
          // Message exists - update it with any new content
          const newList = [...prev];
          const existing = newList[existingIndex];
          let message = existing.message;

          // Only update if we have new content
          if (delta.transcript || delta.text || item.content?.[0]?.text) {
            if (delta.transcript) {
              message = message ? `${message}${delta.transcript}` : delta.transcript;
            } else if (delta.text && !message.includes(delta.text)) {
              message = message ? `${message}${delta.text}` : delta.text;
            } else if (item.content?.[0]?.text && !message.includes(item.content[0].text)) {
              message = item.content[0].text;
            }

            newList[existingIndex] = {
              ...existing,
              id: item.id || existing.id, // Keep local ID if no server ID yet
              message,
            };
            return newList;
          }
          return prev; // No new content, don't update
        } else if (isNewMessage) {
          // Only create if we don't have a matching message
          const messageContent = 
            delta.text || 
            delta.transcript || 
            item.content?.[0]?.text || 
            '';

          return [...prev, {
            id: item.id || `local-${item.timestamp}`,
            isSelf: item.role === 'user',
            name: item.role === 'user' ? userName : aiName,
            message: messageContent,
            isImage: false,
            timestamp: item.timestamp || Date.now(),
          }];
        }
        return prev;
      });
    };

    audioContextRef.current = new AudioContext();

    socket.on('connect', () => {
      console.log('Connected', socket.id);
    });
    socket.on('disconnect', () => {
      console.log('Disconnected', socket.id);
      stopConversation().then(() => {
        console.log('Conversation stopped by disconnect');
      });
    });
    socket.on('ready', () => {
      wavRecorder.record((data) => {
        socket?.emit('appendAudio', arrayBufferToBase64(data.mono));
        
        if (!sourceNodeRef.current && wavRecorder.getStream()) {
          sourceNodeRef.current = audioContextRef.current!.createMediaStreamSource(wavRecorder.getStream()!);
        }
      }).then(() => {
        console.log('Recording started')
        setIsRecording(true);
      });
    });
    socket.on('conversationInterrupted', async () => {
      console.log('conversationInterrupted');
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        socket.emit('cancelResponse');
      }
    });
    socket.on('imageCreated', (imageUrl) => {
      setMessages((prev) => [
        ...prev,
        {
          id: imageUrl,
          isSelf: false,
          name: aiName,
          message: imageUrl,
          isImage: true,
          timestamp: Date.now(),
        }
      ]);
      setImageUrls(prev => [...prev, imageUrl]);
    });
    socket.on('conversationUpdated', (item, delta) => {
      console.log('Conversation updated:', { item, delta });

      if (delta?.audio) {
        const audio = base64ToArrayBuffer(delta.audio);
        wavStreamPlayer.add16BitPCM(audio, item.id);
        return;
      }

      // For user messages, filter out audio-only updates
      if (item.role === 'user') {
        const hasUserContent = 
          delta.transcript || 
          delta.text?.trim() || 
          item.content?.[0]?.text?.trim() ||
          (item.content?.[0]?.type === 'input_text' && item.content[0].text?.trim());

        if (!hasUserContent) {
          console.log('Filtering audio-only message');
          return;
        }
      }

      // Process message if it has any kind of content
      const hasContent = !!(
        delta.text?.trim() || 
        delta.transcript?.trim() || 
        item.content?.[0]?.text?.trim()
      );
      
      if (hasContent) {
        updateOrCreateMessage(item, delta, true);
      }
    });

    wavRecorder.begin(null).then(() => {
      wavStreamPlayer.connect().then(() => {
        outputAnalyserRef.current = wavStreamPlayer.getAnalyser();
        console.log('Conversation started, connecting to socket');
        socket.connect();
      });
    });
  }, [aiName, stopConversation, userName]);

  const postMessage = useCallback(async (message: string) => {
    if (socketRef.current?.connected) {
      // Just send to socket and let the server response create the message
      socketRef.current?.emit('sendMessage', message);
    }
  }, []);

  const onStartStop = useCallback(() => {
    if (isRecording) {
      stopConversation().then(() => {
        console.log('Conversation stopped by user');
      });
    } else {
      startConversation();
    }
  }, [isRecording, startConversation, stopConversation]);

  const handleImagesComplete = useCallback(() => {
    setImageUrls([]);
  }, []);

  const handleMicMute = useCallback(() => {
    const wavRecorder = wavRecorderRef.current;
    if (wavRecorder.getStream()) {
      const audioTrack = wavRecorder.getStream()!.getAudioTracks()[0];
      audioTrack.enabled = !audioTrack.enabled;
      setIsMuted(!isMuted);
    }
  }, [isMuted]);

  useEffect(() => {
    const unloadCallback = (event: BeforeUnloadEvent) => {
      console.log('Unloading', event);
      if (isRecording) {
        stopConversation().then(() => {
          console.log('Conversation stopped by unmount');
        });
      }
      return "";
    };

    window.addEventListener("beforeunload", unloadCallback);
    return () => {
      window.removeEventListener("beforeunload", unloadCallback);
    }
  }, [stopConversation, isRecording]);

  useEffect(() => {
    return () => {
      stopConversation().then(() => {
        console.log('Conversation stopped by effect cleanup');
        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }
        sourceNodeRef.current = null;
      });
    }
  }, [stopConversation]);

  return (
    <div className="h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-3xl h-full flex flex-col">
        <div className="h-full bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-2xl border border-gray-700/50 p-6 flex flex-col">
          {/* Audio Visualizer - fixed height */}
          <div className="h-[300px] flex-none flex items-center justify-center relative">
            {isRecording ? (
              <div className="animate-fadeIn">
                <AudioVisualizer 
                  audioContext={audioContextRef.current}
                  analyserNode={outputAnalyserRef.current}
                />
              </div>
            ) : (
              <div className="w-[300px] h-[300px] rounded-lg bg-gray-900/50 border border-gray-800 
                            flex items-center justify-center animate-pulse">
                <span className="text-gray-500">Awaiting Entity Link...</span>
              </div>
            )}
            
            {/* ImageOverlay matches container size */}
            <div className="absolute inset-0 flex items-center justify-center">
              <ImageOverlay 
                imageUrls={imageUrls}
                onComplete={handleImagesComplete}
              />
            </div>
          </div>

          {/* Controls - fixed height */}
          <div className="h-20 flex-none flex items-center justify-center space-x-8">
            {/* Microphone Button */}
            <div className="relative w-16 h-16">
              <button 
                onClick={handleMicMute}
                className={`absolute inset-0 flex items-center justify-center rounded-full transition duration-300 shadow-lg ${
                  !isRecording
                    ? 'bg-gray-800 cursor-not-allowed opacity-50'
                    : !isMuted 
                      ? 'bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-cyan-500/20' 
                      : 'bg-gradient-to-r from-slate-600 to-gray-700 hover:from-slate-700 hover:to-gray-800 shadow-slate-500/20'
                }`}
                aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                disabled={!isRecording}
              >
                {!isMuted ? <MicIcon sx={{ fontSize: 28 }} /> : <MicOffIcon sx={{ fontSize: 28 }} />}
              </button>
              {isRecording && !isMuted && (
                <div className="absolute inset-0 pointer-events-none">
                  <MicrophoneVisualizer
                    audioContext={audioContextRef.current}
                    sourceNode={sourceNodeRef.current}
                  />
                </div>
              )}
            </div>

            {/* Start/Stop Button */}
            <button 
              onClick={onStartStop}
              className={`flex items-center justify-center w-16 h-16 rounded-full transition duration-300 shadow-lg ${
                isRecording 
                  ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 shadow-red-500/20'
                  : 'bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-cyan-500/20'
              }`}
              aria-label={isRecording ? 'Terminate connection' : 'Initialize connection'}
            >
              {isRecording ? (
                <CallEndIcon sx={{ fontSize: 28 }} />
              ) : (
                <PhoneEnabledIcon sx={{ fontSize: 28 }} />
              )}
            </button>
          </div>

          {/* Chat container - fill remaining space */}
          <div className="flex-1 h-0 mt-6 bg-gray-900/50 rounded-lg border border-gray-700/50 backdrop-blur-sm">
            <ChatTile 
              messages={messages} 
              onSend={postMessage}
              isConnected={isRecording}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
