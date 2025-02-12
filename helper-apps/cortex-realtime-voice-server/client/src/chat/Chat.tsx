'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {io, Socket} from 'socket.io-client';
import {WavRecorder} from './audio/WavRecorder';
import {WavStreamPlayer} from './audio/WavStreamPlayer';
import {ChatMessage, ChatTile} from './ChatTile';
import {arrayBufferToBase64, base64ToArrayBuffer} from "./utils/audio";
import {ClientToServerEvents, ServerToClientEvents} from "../../../src/utils/socket";
import { AudioVisualizer } from './components/AudioVisualizer';
import { MicrophoneVisualizer } from './components/MicrophoneVisualizer';
import { ImageOverlay } from './components/ImageOverlay';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import PhoneEnabledIcon from '@mui/icons-material/PhoneEnabled';
import CallEndIcon from '@mui/icons-material/CallEnd';
import CloseIcon from '@mui/icons-material/Close';
import ChatIcon from '@mui/icons-material/Chat';
import {SoundEffects} from './audio/SoundEffects';
import { logger } from '../utils/logger';
import {ScreenshotCapture} from './components/ScreenshotCapture';
import {Voice} from "openai-realtime-socket-client";

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
  const [isLoading, setIsLoading] = useState(false);
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [isMuted, setIsMuted] = useState(false);
  const [overlayKey, setOverlayKey] = useState(0);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({sampleRate: 24000}),
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({sampleRate: 24000}),
  );
  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents>>(
      io(`/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}&aiStyle=${aiStyle}&language=${language}`, {autoConnect: false})
    );
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const [showChat, setShowChat] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Log on every render
  logger.log('Chat rendering, showChat:', showChat);

  // Log on mount only
  useEffect(() => {
    logger.log('Chat mounted');
    return () => logger.log('Chat unmounted');
  }, []);

  // Existing effect to track showChat changes
  useEffect(() => {
    logger.log('showChat changed:', showChat);
  }, [showChat]);

  const stopConversation = useCallback(async () => {
    logger.log('Stopping conversation');
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const socket = socketRef.current;

    try {
      // First stop recording and audio playback
      if (wavRecorder.getStatus() === "recording") {
        await wavRecorder.end();
      }
      if (wavStreamPlayer) {
        await wavStreamPlayer.interrupt();
      }

      // Clean up socket connection first
      if (socket) {
        // Only emit if we're still connected
        if (socket.connected) {
          socket.emit('conversationCompleted');
          // Wait a bit to ensure the message is sent
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        socket.removeAllListeners();
        socket.disconnect();
        // Create a new socket instance to ensure clean state
        socketRef.current = io(`/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}&aiStyle=${aiStyle}&language=${language}`, {
          autoConnect: false,
          reconnection: false
        });
      }

      // Then clean up audio nodes
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

      // Reset recorder and player
      wavRecorderRef.current = new WavRecorder({sampleRate: 24000});
      wavStreamPlayerRef.current = new WavStreamPlayer({sampleRate: 24000});

      // Play disconnect sound last
      await SoundEffects.playDisconnect();

      // Reset state
      setIsRecording(false);
      setIsMuted(false);
      setImageUrls([]);
      setIsAudioPlaying(false);
    } catch (error) {
      logger.error('Error stopping conversation:', error);
      // Even if there's an error, try to reset critical state
      setIsRecording(false);
      setIsAudioPlaying(false);
    }
  }, [userId, userName, aiName, voice, aiStyle, language]);

  const startConversation = useCallback(() => {
    logger.log('Starting conversation');

    // Clean up any existing socket connection first
    if (socketRef.current?.connected) {
      socketRef.current.disconnect();
    }

    // Create a new socket instance
    socketRef.current = io(`/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}&aiStyle=${aiStyle}&language=${language}`, {
      autoConnect: false,
      timeout: 10000 // 10 second connection timeout
    });

    const socket = socketRef.current;

    // Remove ALL existing listeners before adding new ones
    socket.removeAllListeners();

    // Create fresh audio context
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    audioContextRef.current = new AudioContext();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const wavRecorder = wavRecorderRef.current;

    const updateOrCreateMessage = (item: any, delta: any, isNewMessage = false) => {
      setMessages((prev) => {
        // Skip messages that start with <INSTRUCTIONS>
        if (item.role === 'user' &&
            (item.content?.[0]?.text?.startsWith('<INSTRUCTIONS>') ||
             delta.text?.startsWith('<INSTRUCTIONS>') ||
             delta.transcript?.startsWith('<INSTRUCTIONS>'))) {
          return prev;
        }

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
              message = message + delta.transcript;  // Concatenate transcript chunks
            } else if (delta.text) {
              message = message + delta.text;  // Concatenate text chunks
            } else if (item.content?.[0]?.text) {
              message = item.content[0].text;  // Full message replacement
            }

            newList[existingIndex] = {
              ...existing,
              id: item.id || existing.id,
              message,
            };
            return newList;
          }
          return prev;
        } else if (isNewMessage) {
          // Only create if we don't have a matching message
          const messageContent =
            delta.text ||
            delta.transcript ||
            item.content?.[0]?.text ||
            '';

          // For user messages, use a timestamp slightly before now
          // For AI messages, use current timestamp
          const timestamp = item.role === 'user' ?
            Date.now() - 500 : // 500ms earlier for user messages
            Date.now();

          return [...prev, {
            id: item.id || `local-${timestamp}`,
            isSelf: item.role === 'user',
            name: item.role === 'user' ? userName : aiName,
            message: messageContent,
            isImage: false,
            timestamp,
          }];
        }
        return prev;
      });
    };

    socket.on('connect', () => {
      logger.log('Connected', socket.id);
      SoundEffects.playConnect();
    });
    socket.on('disconnect', () => {
      logger.log('Disconnected', socket.id);
      stopConversation().then(() => {
        logger.log('Conversation stopped by disconnect');
      });
    });
    socket.on('ready', () => {
      wavRecorder.record((data) => {
        socket?.emit('appendAudio', arrayBufferToBase64(data.mono));

        if (!sourceNodeRef.current && wavRecorder.getStream()) {
          sourceNodeRef.current = audioContextRef.current!.createMediaStreamSource(wavRecorder.getStream()!);
        }
      }).then(() => {
        logger.log('Recording started')
        setIsRecording(true);
        setIsLoading(false);  // Clear loading only when fully set up
      });
    });
    socket.on('conversationInterrupted', async () => {
      logger.log('conversationInterrupted');
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        socket.emit('cancelResponse');
        if (wavStreamPlayer.currentTrackId) {
          await wavStreamPlayer.fadeOut(150);
          socket.emit('audioPlaybackComplete', trackSampleOffset.trackId);
        }
      }
    });
    socket.on('imageCreated', (imageUrl) => {
      logger.log('imageCreated event received:', imageUrl);
      setImageUrls(prev => {
        logger.log('setImageUrls called with prev:', prev);
        const next = prev.length === 0 ? [imageUrl] : [...prev, imageUrl];
        logger.log('setImageUrls returning next:', next);
        if (prev.length === 0) {
          setOverlayKey(k => k + 1);
        }
        return next;
      });
    });
    socket.on('conversationUpdated', (item, delta) => {
      logger.log('Conversation updated:', { item, delta });

      if (delta?.audio) {
        const audio = base64ToArrayBuffer(delta.audio);
        wavStreamPlayer.add16BitPCM(audio, item.id);
        setIsAudioPlaying(true);

        // Set up track completion callback if not already set
        if (!wavStreamPlayer.onTrackComplete) {
          wavStreamPlayer.setTrackCompleteCallback((trackId) => {
            logger.log('Audio track completed:', trackId);
            setIsAudioPlaying(false);
            socket.emit('audioPlaybackComplete', trackId);
          });
        }
        return;
      } else {
        logger.log('Raw delta:', JSON.stringify(delta));
        logger.log('Raw item:', JSON.stringify(item));
      }

      // For user messages, filter out audio-only updates
      if (item.role === 'user') {
        const hasUserContent =
          delta.transcript ||
          delta.text ||
          item.content?.[0]?.text ||
          (item.content?.[0]?.type === 'input_text' && item.content[0].text);

        if (!hasUserContent) {
          logger.log('Filtering audio-only message');
          return;
        }
      }

      // Process message if it has any kind of content
      const hasContent = !!(
        delta.text ||
        delta.transcript ||
        item.content?.[0]?.text
      );

      if (hasContent) {
        updateOrCreateMessage(item, delta, true);
      }
    });

    wavRecorder.begin(null).then(() => {
      wavStreamPlayer.connect().then(() => {
        outputAnalyserRef.current = wavStreamPlayer.getAnalyser();
        logger.log('Conversation started, connecting to socket');
        socket.connect();
      });
    });

    // Add error handler to clear loading state if setup fails
    socket.on('connect_error', () => {
      logger.log('Connection error');
      setIsLoading(false);
    });
  }, [aiName, stopConversation, userName, aiStyle, voice, language, userId]);

  const postMessage = useCallback(async (message: string) => {
    if (socketRef.current?.connected) {
      // Just send to socket and let the server response create the message
      socketRef.current?.emit('sendMessage', message);
    }
  }, []);

  const onStartStop = useCallback(async () => {
    if (isLoading) return;  // Prevent any action while loading

    try {
      if (isRecording) {
        setIsLoading(true);
        await stopConversation();
        logger.log('Conversation stopped by user');
      } else {
        startConversation();  // startConversation now handles its own loading state
      }
    } finally {
      setIsLoading(false);
    }
  }, [isRecording, startConversation, stopConversation, isLoading]);

  const handleImagesComplete = useCallback(() => {
    // Don't clear the array anymore
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
      logger.log('Unloading', event);
      if (isRecording) {
        stopConversation().then(() => {
          logger.log('Conversation stopped by unmount');
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
        logger.log('Conversation stopped by effect cleanup');
        if (audioContextRef.current) {
          audioContextRef.current.close();
          audioContextRef.current = null;
        }
        sourceNodeRef.current = null;
      });
    }
  }, [stopConversation]);

  useEffect(() => {
    logger.log('imageUrls changed:', imageUrls);
  }, [imageUrls]);

  // Log in toggle
  const toggleChat = () => {
    logger.log('Toggle clicked, current showChat:', showChat);
    setShowChat(prev => {
      logger.log('Setting showChat from', prev, 'to', !prev);
      return !prev;
    });
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  // Add a debug log in the render to check values
  const chatPanelClasses = `absolute inset-x-0 bottom-0 h-[66vh] bg-gray-800/95 
                           backdrop-blur-sm border-t border-gray-700/50 shadow-2xl
                           rounded-t-2xl z-50 transition-transform duration-300 ease-in-out
                           transform translate-y-full ${showChat ? 'translate-y-0' : ''}`;

  logger.log('Render state:', {
    showChat,
    mounted,
    classes: chatPanelClasses
  });

  useEffect(() => {
    // Initialize sound effects when component mounts
    SoundEffects.init().catch(console.error);
  }, []);

  return (
    <div className="h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-3xl h-full flex flex-col relative gap-[5px]">
        {socketRef.current?.connected && (
          <ScreenshotCapture socket={socketRef.current} />
        )}

        <div className={`flex flex-col bg-gray-800/50 backdrop-blur-sm rounded-2xl 
                        shadow-2xl border border-gray-700/50 px-6 pt-6 pb-2
                        transition-all duration-300 ease-in-out`}
             style={showChat ? {
               height: '34vh'
             } : { height: '100%' }}>
          <div className="flex flex-col justify-center flex-1">
            <div className={`flex items-center justify-center relative
                           transition-all duration-300 ease-in-out 
                           ${showChat ? 'mb-2' : 'mb-8'}`}>
              {isRecording ? (
                <div className={`animate-fadeIn h-full aspect-square flex items-center justify-center
                               transition-all duration-300 ease-in-out`}>
                  <AudioVisualizer
                    audioContext={audioContextRef.current}
                    analyserNode={outputAnalyserRef.current}
                    width={showChat ? window.innerHeight * (100 - 66) / 100 * 0.6 : window.innerHeight * 0.75}
                    height={showChat ? window.innerHeight * (100 - 66) / 100 * 0.6 : window.innerHeight * 0.75}
                  />
                </div>
              ) : (
                <div className="h-full aspect-square flex items-center justify-center">
                  <div className={`aspect-square flex items-center justify-center
                            rounded-lg bg-gray-900/50 border border-gray-800 
                            animate-pulse transition-all duration-300 ease-in-out`}
                       style={{
                         width: showChat ?
                           window.innerHeight * (100 - 66) / 100 * 0.6 :
                           window.innerHeight * 0.75,
                         height: showChat ?
                           window.innerHeight * (100 - 66) / 100 * 0.6 :
                           window.innerHeight * 0.75
                       }}>
                    <span className={`text-gray-500 transition-all duration-300 ease-in-out
                                   ${showChat ? 'text-sm' : 'text-xl'}`}>
                      Awaiting Entity Link...
                    </span>
                  </div>
                </div>
              )}

              <div className="absolute inset-0 flex items-center justify-center">
                <ImageOverlay
                  key={overlayKey}
                  imageUrls={imageUrls}
                  onComplete={handleImagesComplete}
                  isAudioPlaying={isAudioPlaying}
                />
              </div>
            </div>

            <div className={`flex-none flex items-center justify-center
                           transition-all duration-300 ease-in-out 
                           ${showChat ? 'pb-2' : 'py-4'}
                           ${showChat ? 'space-x-3' : 'space-x-8'}`}>
              <div className={`relative ${showChat ? 'w-12 h-12' : 'w-16 h-16'}`}>
                {isRecording && !isMuted && (
                  <div className="absolute inset-0 pointer-events-none">
                    <MicrophoneVisualizer
                      audioContext={audioContextRef.current}
                      sourceNode={sourceNodeRef.current}
                      size={showChat ? 'small' : 'large'}
                    />
                  </div>
                )}
                <button
                  onClick={handleMicMute}
                  className={`absolute inset-0 z-10 flex items-center justify-center rounded-full transition duration-300 shadow-lg ${
                    !isRecording
                      ? 'bg-gray-800/50 cursor-not-allowed opacity-50'
                      : !isMuted 
                        ? 'bg-gradient-to-r from-blue-500/70 to-cyan-500/70 hover:from-blue-600/70 hover:to-cyan-600/70 shadow-cyan-500/20' 
                        : 'bg-gradient-to-r from-slate-600/70 to-gray-700/70 hover:from-slate-700/70 hover:to-gray-800/70 shadow-slate-500/20'
                  }`}
                  aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                  disabled={!isRecording}
                >
                  {!isMuted ? <MicIcon sx={{ fontSize: showChat ? 20 : 28 }} /> : <MicOffIcon sx={{ fontSize: showChat ? 20 : 28 }} />}
                </button>
              </div>

              <button
                onClick={onStartStop}
                disabled={isLoading}
                className={`flex items-center justify-center ${showChat ? 'w-12 h-12' : 'w-16 h-16'} rounded-full transition duration-300 shadow-lg ${
                  isLoading ? 'opacity-50 cursor-not-allowed' :
                  isRecording 
                    ? 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-700 hover:to-red-800 shadow-red-500/20'
                    : 'bg-gradient-to-r from-blue-500 to-cyan-500 hover:from-blue-600 hover:to-cyan-600 shadow-cyan-500/20'
                }`}
                aria-label={isRecording ? 'Terminate connection' : 'Initialize connection'}
              >
                {isRecording ? (
                  <CallEndIcon sx={{ fontSize: showChat ? 20 : 28 }} />
                ) : (
                  <PhoneEnabledIcon sx={{ fontSize: showChat ? 20 : 28 }} />
                )}
              </button>

              <button
                onClick={toggleChat}
                className={`flex items-center justify-center ${showChat ? 'w-12 h-12' : 'w-16 h-16'} rounded-full 
                           transition duration-300 shadow-lg
                           bg-gradient-to-r from-gray-600 to-gray-700 
                           hover:from-gray-700 hover:to-gray-800`}
                aria-label={showChat ? 'Hide chat' : 'Show chat'}
              >
                {showChat ? <CloseIcon sx={{ fontSize: 20 }} /> : <ChatIcon sx={{ fontSize: 28 }} />}
              </button>
            </div>
          </div>
        </div>

        {mounted && showChat && (
          <div className={`bg-gray-800/95 backdrop-blur-sm border-t border-gray-700/50 
                          shadow-2xl rounded-t-2xl transition-all duration-300 ease-in-out`}
               style={{
                 height: '66vh',
                 transform: showChat ? 'none' : 'translateY(100%)',
               }}>
            <div className="h-full">
              <ChatTile
                messages={messages}
                onSend={postMessage}
                isConnected={isRecording}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
