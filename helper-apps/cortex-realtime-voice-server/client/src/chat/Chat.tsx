'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {io, Socket} from 'socket.io-client';
import {WavRecorder} from './audio/WavRecorder';
import {WavStreamPlayer} from './audio/WavStreamPlayer';
import {ChatMessage, ChatTile} from './ChatTile';
import {arrayBufferToBase64, base64ToArrayBuffer} from "./utils/audio";
import {ClientToServerEvents, ServerToClientEvents} from "../../../src/realtime/socket";

type ChatProps = {
  userId: string;
  userName: string;
  aiName: string;
};

export default function Chat({userId, userName, aiName}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({sampleRate: 24000}),
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({sampleRate: 24000}),
  );
  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents>>(
      io(`/?userId=${userId}&userName=${userName}&aiName=${aiName}`, {autoConnect: false})
    );

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
      setIsRecording(false);
    }
  }, []);

  const startConversation = useCallback(() => {
    console.log('Starting conversation', process.env.NEXT_PUBLIC_SOCKET_URL);
    const socket = socketRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const wavRecorder = wavRecorderRef.current;

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
    socket.on('conversationUpdated', (item, delta) => {
      if (delta?.audio) {
        const audio = base64ToArrayBuffer(delta.audio);
        wavStreamPlayer.add16BitPCM(audio, item.id);
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
                name: item.role === 'user' ? 'You' : 'News AI',
                message: '',
                isImage: false,
                timestamp: Date.now(),
              }
            ]
          }
        });
      }
    });

    wavRecorder.begin(null).then(() => {
      wavStreamPlayer.connect().then(() => {
        console.log('Conversation started, connecting to socket:', process.env.NEXT_PUBLIC_SOCKET_URL);
        socket.connect();
      });
    });
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
      });
    }
  }, [stopConversation]);

  return (
    <main className="flex flex-row">
      <ChatTile messages={messages} onSend={postMessage} onStartStop={onStartStop}/>
    </main>
  );
}
