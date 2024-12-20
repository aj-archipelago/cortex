import {ChatBubble} from './ChatBubble';
import {ChatMessageInput} from './ChatMessageInput';
import {useEffect, useRef} from 'react';
import {useWindowDimensions, Image, View, ScrollView, Platform} from "react-native";
import {useSafeAreaInsets} from "react-native-safe-area-context";

export type ChatMessage = {
  id: string;
  name: string;
  message: string;
  isSelf: boolean;
  isImage: boolean
  timestamp: number;
};

type ChatTileProps = {
  messages: ChatMessage[];
  onSend?: (message: string) => Promise<void>;
  onStartStop?: () => void;
};

export const ChatTile = ({messages, onSend, onStartStop}: ChatTileProps) => {
  const size = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const containerRef = useRef<any>(null);
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      if (containerRef.current.scrollToEnd) containerRef.current.scrollToEnd();
    }
  }, [containerRef, messages]);

  return (
    <View className="flex flex-col h-full w-full min-w-72 bg-gray-800">
      <View
        className="flex flex-col h-full"
        style={{
          height: size.height - insets.top - insets.bottom - 44,
        }}
      >
        <ScrollView
          ref={containerRef}
          className="h-full overflow-y-auto grow"
        >
          {messages.map((message, index) => {
            if (message.isImage) {
              return (
                <View key={`image-dic-${index}`} className="flex flex-row justify-center items-center">
                  <Image
                    width={256}
                    height={256}
                    key={index}
                    src={message.message}
                    alt={message.name}
                  />
                </View>
              );
            }
            return (
              <ChatBubble
                key={index}
                name={message.name}
                message={message.message}
                isSelf={message.isSelf}
              />
            );
          })}
        </ScrollView>
        <ChatMessageInput
          placeholder="Type a message"
          onSend={onSend}
          onStartStop={onStartStop}
        />
      </View>
    </View>
  );
};
