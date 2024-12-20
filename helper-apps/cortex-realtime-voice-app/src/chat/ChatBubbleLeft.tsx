import {ChatMessage} from "./ChatMessage";
import {Text, View} from "react-native";

type ChatBubbleLeftProps = {
  name: string;
  message: string;
};

export const ChatBubbleLeft = ({name, message}: ChatBubbleLeftProps) => {
  return (
    <View className="flex items-start justify-start p-3">
      <View className="flex flex-col leading-1.5 p-4 border-gray-200 bg-gray-900 rounded-e-xl rounded-es-xl mr-20">
        <View className="flex items-start justify-start space-x-2">
          <Text className="text-lg font-bold text-gray-100">{name}</Text>
        </View>
        <ChatMessage message={message}/>
      </View>
    </View>
  )
}
