import {Text} from "react-native";

type ChatMessageProps = {
  message: string;
}

export const ChatMessage = ({message}: ChatMessageProps) => {
  return <Text className="text-white text-md font-medium my-2">{message}</Text>;
}
