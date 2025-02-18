import {ChatMessage, ChatTile} from "./ChatTile";
import {useCallback, useEffect, useRef, useState} from "react";
import {io, Socket} from "socket.io-client";
import {ClientToServerEvents, ServerToClientEvents} from "../../../cortex-realtime-voice-server/src/utils/socket";
import {
  RealtimeAudioModule,
  RealtimeAudioPlayerViewRef,
  RealtimeAudioRecorderViewRef,
  RealtimeAudioPlayerView,
  RealtimeAudioRecorderView,
  AudioEncoding,
  Visualizers
} from 'react-native-realtime-audio';
import {FlatList, View, StyleSheet, Text, useWindowDimensions, Pressable} from "react-native";
import {useSafeAreaInsets} from "react-native-safe-area-context";
import type {ViewToken} from "@react-native/virtualized-lists";

type ChatProps = {
  userId: string,
  userName: string,
  aiName: string,
  language: string,
  aiMemorySelfModify: boolean,
  aiStyle: string,
  voice: string,
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
  const {width, height} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const socketRef =
    useRef<Socket<ServerToClientEvents, ClientToServerEvents>>(
      io(`${process.env.EXPO_PUBLIC_SOCKET_URL}/?userId=${userId}&userName=${userName}&aiName=${aiName}&voice=${voice}&aiStyle=${aiStyle}&language=${language}`,
        {autoConnect: false})
    );
  const playerRef = useRef<RealtimeAudioPlayerViewRef>(null);
  const recorderRef = useRef<RealtimeAudioRecorderViewRef>(null);

  const onViewableItemsChanged = useCallback(({viewableItems}: {
    viewableItems: Array<ViewToken<{ id: string }>>;
  }) => {
    if (viewableItems[0]) {
      setCurrentVisibleIndex(viewableItems[0].index || 0);
      console.log('Current visible index:', viewableItems[0].index);
    }
  }, []);

  const stopConversation = useCallback(() => {
    console.log('Stopping conversation');
    recorderRef.current?.stopRecording();
    playerRef.current?.stop();
    const socket = socketRef.current;
    socket.emit('conversationCompleted');
    socket.removeAllListeners();
    socket.disconnect();
    setIsRecording(false);
    setIsConnected(false);
  }, []);


  const startConversation = useCallback(() => {
    console.log('Starting conversation', process.env.EXPO_PUBLIC_SOCKET_URL);
    const socket = socketRef.current;
    socket.on('connect', () => {
      console.log('Connected', socket.id);
    });
    socket.on('disconnect', () => {
      console.log('Disconnected', socket.id);
      stopConversation()
      console.log('Conversation stopped by disconnect');
    });
    socket.on('ready', () => {
      recorderRef.current?.startRecording();
      console.log('Recording started');
      setIsConnected(true);
      setIsRecording(true);
    });
    socket.on('conversationInterrupted', () => {
      console.log("Stopping conversation due to interruption");
      // socket.emit('cancelResponse');
      playerRef.current?.stop();
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
    });
    socket.on('conversationUpdated', (item, delta) => {
      if (delta?.audio) {
        playerRef.current?.addBuffer(delta.audio);
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
    if (isConnected) {
      stopConversation()
      console.log('Conversation stopped by user');
    } else {
      startConversation();
    }
  }, [isConnected, startConversation, stopConversation]);

  const onMuteUnmute = useCallback(() => {
    if (isRecording) {
      recorderRef.current?.stopRecording();
    } else if (isConnected) {
      recorderRef.current?.startRecording();
    } else {
      return;
    }
    setIsRecording(!isRecording);
  }, [isRecording]);

  useEffect(() => {
    const checkPermissions = async () => {
      const result = await RealtimeAudioModule.checkAndRequestAudioPermissions();
      console.log("Permissions result", result);
    };
    checkPermissions().then(() => console.log("Permissions checked."));
  }, []);

  const totalHeight = height - insets.top - insets.bottom - 35;
  const controlsHeight = 100;
  const listHeight = totalHeight - controlsHeight;
  const itemWidth = width * 0.9;
  const renderItem = ({item}: { item: { id: string } }) => {
    if (item.id === 'audio') {
      return (
        <View
          className={'justify-center items-center'}
          style={{width: itemWidth, height: listHeight}}>
          <RealtimeAudioPlayerView
            ref={playerRef}
            style={[styles.audioContainer, {width: itemWidth - 20, height: itemWidth - 20}]}
            audioFormat={{
              sampleRate: 24000,
              encoding: AudioEncoding.pcm16bitInteger,
              channelCount: 1
            }}
            waveformColor={'#459cb2'}
            visualizer={Visualizers.tripleCircle}
            onPlaybackStopped={() => {
              console.log('onPlaybackStopped');
              if (socketRef.current?.connected) {
                socketRef.current?.emit('audioPlaybackComplete', "trackId");
              }
            }}
          />
          <RealtimeAudioRecorderView
            ref={recorderRef}
            style={[styles.audioContainer, {width: itemWidth - 20, height: 100, marginTop: 20}]}
            audioFormat={{
              sampleRate: 24000,
              encoding: AudioEncoding.pcm16bitInteger,
              channelCount: 1
            }}
            echoCancellationEnabled={true}
            waveformColor={'#459cb2'}
            onAudioCaptured={(audioEvent) => {
              if (socketRef.current?.connected) {
                socketRef.current?.emit('appendAudio', audioEvent.nativeEvent.audioBuffer);
              }
            }}
            />
        </View>
      );
    } else {
      return (
        <View style={[styles.audioContainer, {width: itemWidth, height: listHeight}]}>
          <ChatTile
            height={listHeight}
            messages={messages}
            onSend={postMessage}
          />
        </View>
      );
    }
  }

  return (
    <View className={'bg-gray-800'} style={{height: totalHeight}}>
      <FlatList
        data={[{id: 'audio'}, {id: 'text'}]}
        horizontal
        initialNumToRender={2}
        snapToInterval={width}
        decelerationRate="fast"
        showsHorizontalScrollIndicator={false}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.listContainer, {width: itemWidth * 2, height: listHeight}]}
        snapToAlignment="start"
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{itemVisiblePercentThreshold: 60}}
      />
      <View
        className={'bg-gray-950 border-t-2 border-gray-900 border-solid'}
        style={{height: controlsHeight, width: width}}>
        <View
          className={'flex-row justify-center items-center'}
          style={{height: controlsHeight - 70}}>
          <View className={`${currentVisibleIndex === 0 ? 'bg-gray-200' : 'bg-gray-800'} p-1.5 rounded-lg m-2`}/>
          <View className={`${currentVisibleIndex === 1 ? 'bg-gray-200' : 'bg-gray-800'} p-1.5 rounded-lg m-2`}/>
        </View>
        <View className={'flex-row justify-center items-center'}>
          {isConnected && (
            <Pressable
              onPress={onMuteUnmute}
              className={`${isRecording ? 'bg-gray-800' : 'bg-red-950'} p-3 rounded-3xl mx-3`}
            >
              <Text className={'text-gray-200 font-bold text-3xl'}>🎙️</Text>
            </Pressable>
          )}
          <Pressable
            onPress={onStartStop}
            className={`${isConnected ? 'bg-red-700' : 'bg-green-700'} p-3 rounded-3xl mx-3`}
          >
            <Text className={'text-gray-200 font-bold text-3xl'}>📞</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  listContainer: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'flex-start',
  },
  audioContainer: {
    backgroundColor: '#06034e',
    borderRadius: 10,
  }
})
