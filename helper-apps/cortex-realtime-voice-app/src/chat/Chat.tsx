import type {Voice} from '../../../cortex-realtime-voice-server/src/realtime/realtimeTypes';
import {ChatMessage, ChatTile} from "./ChatTile";
import {useCallback, useEffect, useRef, useState} from "react";
import {io, Socket} from "socket.io-client";
import {ClientToServerEvents, ServerToClientEvents} from "../../../cortex-realtime-voice-server/src/realtime/socket";
import {
  RealtimeAudioModule,
  RealtimeAudioRecorderModule,
  RealtimeAudioPlayerModule,
  RealtimeAudioPlayer,
  RealtimeAudioRecorder,
  AudioEncoding
} from 'react-native-realtime-audio';
import {useEvent, useEventListener} from "expo";

type ChatProps = {
  userId: string,
  userName: string,
  aiName: string,
  language: string,
  aiMemorySelfModify: boolean,
  aiStyle: string,
  voice: Voice,
}

const audioPlayer: RealtimeAudioPlayer = new RealtimeAudioPlayerModule.RealtimeAudioPlayer({
  sampleRate: 24000,
  encoding: AudioEncoding.pcm16bitInteger,
  channelCount: 1
});

const audioRecorder: RealtimeAudioRecorder = new RealtimeAudioRecorderModule.RealtimeAudioRecorder({
    sampleRate: 24000,
    encoding: AudioEncoding.pcm16bitInteger,
    channelCount: 1
  },
  true);

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const audioEvent = useEvent(RealtimeAudioRecorderModule, "onAudioCaptured");
  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents>>(
      io(`${process.env.EXPO_PUBLIC_SOCKET_URL}/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}`,
        {autoConnect: false})
    );

  useEventListener(RealtimeAudioPlayerModule, "onPlaybackStopped", () => {
    console.log('onPlaybackStopped');
    if (socketRef.current?.connected) {
      socketRef.current?.emit('audioPlaybackComplete', "trackId");
    }
  })

  useEffect(() => {
    if (audioEvent) {
      socketRef.current?.emit('appendAudio', audioEvent.audioBuffer);
    }
  }, [audioEvent]);

  const stopConversation = useCallback(async () => {
    console.log('Stopping conversation');
    await audioRecorder.stopRecording();
    await audioPlayer.stop();
    const socket = socketRef.current;
    socket.emit('conversationCompleted');
    socket.removeAllListeners();
    socket.disconnect();
    setIsRecording(false);
  }, []);


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
      audioRecorder.startRecording();
      console.log('Recording started');
      setIsRecording(true);
    });
    socket.on('conversationInterrupted', async () => {
      console.log("Stopping conversation due to interruption");
      // socket.emit('cancelResponse');
      await audioPlayer.stop();
    });
    socket.on('conversationUpdated', (item, delta) => {
      if (delta?.audio) {
        audioPlayer.addBuffer(delta.audio);
      } else {
        // console.log('conversationUpdated', item, delta);
        setMessages((prev) => {
          // Skip messages that start with <INSTRUCTIONS>
          if (item.role === 'user' &&
            (item.content?.[0]?.text?.startsWith('<INSTRUCTIONS>') ||
              delta.text?.startsWith('<INSTRUCTIONS>') ||
              delta.transcript?.startsWith('<INSTRUCTIONS>'))) {
            return prev;
          }

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
    const checkPermissions = async () => {
      const result = await RealtimeAudioModule.checkAndRequestAudioPermissions();
      console.log("Permissions result", result);
    };
    checkPermissions().then(() => console.log("Permissions checked."));
  }, []);

  return (
    <ChatTile
      messages={messages}
      onSend={postMessage}
      onStartStop={onStartStop}/>
  );
}
