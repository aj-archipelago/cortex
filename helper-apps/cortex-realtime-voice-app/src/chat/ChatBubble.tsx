import { ChatBubbleRight } from './ChatBubbleRight';
import { ChatBubbleLeft } from './ChatBubbleLeft';

type ChatBubbleProps = {
  message: string;
  name: string;
  isSelf: boolean;
};

export const ChatBubble = ({
                              name,
                              message,
                              isSelf,
                            }: ChatBubbleProps) => {
  return (
    isSelf ? (
      <ChatBubbleRight name={name} message={message} />
    ) : (
      <ChatBubbleLeft name={name} message={message} />
    )
  );
};
