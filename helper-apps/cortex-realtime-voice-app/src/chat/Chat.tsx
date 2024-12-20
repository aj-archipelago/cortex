import type {Voice} from '../../../cortex-realtime-voice-server/src/realtime/realtimeTypes';
import {ChatMessage, ChatTile} from "./ChatTile";
import {useCallback, useEffect, useRef, useState} from "react";
import {io, Socket} from "socket.io-client";
import {ClientToServerEvents, ServerToClientEvents} from "../../../cortex-realtime-voice-server/src/realtime/socket";
import LiveAudioStream, {Options} from 'react-native-live-audio-stream';
import {Audio} from 'expo-av';
import {Sound} from "expo-av/build/Audio/Sound";
import {AVPlaybackStatus} from "expo-av/src/AV";
import {AVPlaybackStatusSuccess} from "expo-av/src/AV.types";
import {
  cacheDirectory,
  writeAsStringAsync,
  EncodingType
} from 'expo-file-system';

type ChatProps = {
  userId: string,
  userName: string,
  aiName: string,
  language: string,
  aiMemorySelfModify: boolean,
  aiStyle: string,
  voice: Voice,
}

function addWavHeader(
  audioData: string,
  sampleRate: number,
  sampleSize: number,
  numChannels: number
): string {
  // Decode the base64 audio data
  const audioDataBuffer = Uint8Array.from(atob(audioData), c => c.charCodeAt(0));
  const dataSize = audioDataBuffer.length;
  console.log('audioDataBuffer size', dataSize);

  // Calculate header values
  const byteRate = sampleRate * numChannels * (sampleSize / 8);
  const blockAlign = numChannels * (sampleSize / 8);
  const totalSize = dataSize + 44 - 8; // Total file size - 8

  // Create a buffer for the header
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  // Write the WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size
  view.setUint16(20, 1, true); // AudioFormat (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, sampleSize, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Combine header and audio data
  const wavBuffer = new Uint8Array(44 + dataSize);
  wavBuffer.set(new Uint8Array(header), 0);
  wavBuffer.set(audioDataBuffer, 44);

  // Convert the combined buffer to base64
  return btoa(String.fromCharCode.apply(null, wavBuffer as unknown as number[]));
}

// Helper function to write strings to the DataView
function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}


export default function Chat({
                               userId,
                               userName,
                               aiName,
                               language,
                               aiMemorySelfModify,
                               aiStyle,
                               voice
                             }: ChatProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [audioChunks, setAudioChunks] = useState<string[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([{
    id: 'foo',
    message: 'Hello, how can I help you today?',
    name: 'Paul',
    isImage: false,
    timestamp: Date.now(),
    isSelf: true,
  }]);
  const audioRef = useRef<Sound>(new Audio.Sound());
  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents>>(
      io(`${process.env.EXPO_PUBLIC_SOCKET_URL}/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}`, {autoConnect: false})
    );

  const stopConversation = useCallback(async () => {
    console.log('Stopping conversation');
    await LiveAudioStream.stop();
    try {
      const playStatus = await audioRef.current.getStatusAsync();
      if (playStatus.isLoaded) {
        await audioRef.current.stopAsync();
        await audioRef.current.unloadAsync();
      }
    } catch (e) {
      console.error('Error stopping conversation', e);
    }
    const socket = socketRef.current;
    socket.emit('conversationCompleted');
    socket.removeAllListeners();
    socket.disconnect();
    setIsRecording(false);
    setAudioChunks([]);
  }, []);

  const playAudioChunk = async (chunk: string) => {
    const tmpFilename = `${cacheDirectory}speech.wav`;
    const wavData = addWavHeader(chunk, 24000, 16, 1);
    console.log('Loading audio chunk to play', tmpFilename);
    try {
      await writeAsStringAsync(tmpFilename, wavData, {
        encoding: EncodingType.Base64
      });
      const result = await audioRef.current.loadAsync({uri: tmpFilename});
      console.log('Loaded audio chunk', result);
      const playResult = await audioRef.current.playAsync();
      console.log('Played audio chunk', playResult);
    } catch (e) {
      console.error('Error loading audio chunk', e);
    }
  }

  const saveAudioChunk = (chunk: string) => {
    setAudioChunks((prev) => {
      console.log('setting audio chunk', prev.length);
      if (prev.length === 0) {
        audioRef.current.setOnPlaybackStatusUpdate((status: AVPlaybackStatus) => {
          console.log('status', status);
          if (status.isLoaded) {
            const playStatus = status as AVPlaybackStatusSuccess;
            console.log('playStatus', playStatus);
            if (playStatus.didJustFinish) {
              audioRef.current.unloadAsync().then(() => {
                setAudioChunks((prev) => {
                  const chunk = prev.pop();
                  if (chunk) {
                    playAudioChunk(chunk).then(() => {
                      console.log('Playing next chunk')
                    });
                  }
                  return [...prev];
                });
              });
            }
          }
        });
        console.log('Playing first chunk');
        playAudioChunk(chunk).then(() => {
          console.log('tried to play first chunk');
        });
      }
      return [chunk, ...prev];
    });
  };

  const startConversation = useCallback(() => {
    console.log('Starting conversation', process.env.EXPO_PUBLIC_SOCKET_URL);
    const socket = socketRef.current;
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
      LiveAudioStream.start();
      console.log('Recording started');
      setIsRecording(true);
    });
    socket.on('conversationInterrupted', async () => {
      console.log('conversationInterrupted');
      if (isRecording) {
        socket.emit('cancelResponse');
      }
    });
    socket.on('conversationUpdated', (item, delta) => {
      if (delta?.audio) {
        saveAudioChunk(delta.audio);
      } else {
        setMessages((prev) => {
          let foundExisting = false;
          const newList = prev.map((m) => {
            if (m.id === item.id) {
              foundExisting = true;
              let message = m.message;
              if (delta.transcript) {
                message += delta.transcript;
              } else if (delta.text) {
                message += delta.text;
              } else if (item.content && item.content[0]?.text) {
                message = item.content[0]?.text;
              } else if (item.content && item.content[0]?.transcript) {
                message = item.content[0]?.transcript;
              }
              return {
                ...m,
                message,
              };
            }
            return {...m};
          });
          if (foundExisting) {
            return newList;
          } else {
            return [
              ...newList,
              {
                id: item.id,
                isSelf: item.role === 'user',
                name: item.role === 'user' ? userName : aiName,
                message: '',
                isImage: false,
                timestamp: Date.now(),
              }
            ]
          }
        });
      }
    });
    socket.connect();
  }, [stopConversation]);

  const postMessage = useCallback(async (message: string) => {
    if (socketRef.current?.connected) {
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

  useEffect(() => {
    const options: Options = {
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      audioSource: 6, // Android only
      bufferSize: 4096,
      wavFile: '',
    };

    LiveAudioStream.init(options);
    LiveAudioStream.on('data', (data) => {
      console.log('recorded data');
      if (socketRef.current?.connected) {
        socketRef.current?.emit('appendAudio', data);
      }
    });
  }, []);

  return (
    <ChatTile
      messages={messages}
      onSend={postMessage}
      onStartStop={onStartStop}/>
  );
}
