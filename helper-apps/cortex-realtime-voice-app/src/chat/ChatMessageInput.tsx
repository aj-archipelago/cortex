import React, { useCallback, useRef, useState } from "react";
import {Pressable, Text, TextInput, View} from "react-native";
import {NativeSyntheticEvent} from "react-native/Libraries/Types/CoreEventTypes";
import {TextInputKeyPressEventData} from "react-native/Libraries/Components/TextInput/TextInput";

type ChatMessageInputProps = {
  placeholder: string;
  onSend?: (message: string) => void;
  onStartStop?: () => void;
};

export const ChatMessageInput = ({
                                   placeholder,
                                   onSend,
                                   onStartStop
                                 }: ChatMessageInputProps) => {
  const [message, setMessage] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const inputRef = useRef<TextInput>(null);

  const handleSend = useCallback(() => {
    if (!onSend) {
      return;
    }
    if (message === "") {
      return;
    }

    onSend(message);
    setMessage("");
  }, [onSend, message]);

  const handleStartStop = useCallback(() => {
    if (!onStartStop) {
      return;
    }
    setIsRecording(!isRecording);
    onStartStop();
  }, [isRecording, onStartStop]);

  return (
    <View className="flex flex-col gap-2 px-2 py-2 border-t border-t-gray-800">
      <Pressable
        className="bg-transparent p-1.5 rounded-lg border-2 border-gray-600"
        onPress={handleStartStop}>
        <Text className="text-s uppercase text-gray-200">{isRecording ? 'Stop' : 'Start'}</Text>
      </Pressable>
      <View className="flex flex-row pt-3 items-center">
        <TextInput
          ref={inputRef}
          className={`grow text-gray-200 bg-transparent border-2 border-gray-600 p-1.5 rounded-lg`}
          placeholder={placeholder}
          value={message}
          onChangeText={setMessage}
          onKeyPress={(e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
            if (e.nativeEvent.key === "Enter") {
              handleSend();
            }
          }}
        />
        <Pressable
          disabled={message.length === 0 || !onSend || !isRecording}
          onPress={handleSend}
          className={'bg-transparent p-1.5 ms-2 rounded-lg border-2 border-gray-600'}
        >
          <Text className="text-s uppercase text-gray-200">Send</Text>
        </Pressable>
      </View>
    </View>
  );
};
