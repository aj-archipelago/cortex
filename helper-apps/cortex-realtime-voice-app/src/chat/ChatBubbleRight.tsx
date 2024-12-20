import {ChatMessage} from "./ChatMessage";
import {Text, View} from "react-native";

type ChatBubbleRightProps = {
  name: string;
  message: string;
};

export const ChatBubbleRight = ({name, message}: ChatBubbleRightProps) => {
  return (
    <View className="flex items-end justify-end p-3">
      <View className="flex flex-col leading-1.5 p-4 border-gray-200 bg-[#2F93FF] rounded-b-xl rounded-tl-xl ml-20">
        <View className="flex items-end justify-end space-x-2">
          <Text className="text-lg font-bold text-gray-100">{name}</Text>
        </View>
        <ChatMessage message={message}/>
      </View>
    </View>
  )
}
