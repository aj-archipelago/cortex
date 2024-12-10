import {ChatMessage} from "./ChatMessage";

type ChatBubbleRightProps = {
  name: string;
  message: string;
};

export const ChatBubbleRight = ({name, message}: ChatBubbleRightProps) => {
  return (
    <div className="flex items-end justify-end p-3">
      <div className="flex flex-col leading-1.5 p-4 border-gray-200 bg-[#2F93FF] rounded-b-xl rounded-tl-xl ml-20">
        <div className="flex items-end justify-end space-x-2">
          <p className="text-sm font-semibold text-gray-100">{name}</p>
        </div>
        <p className="text-sm font-normal py-2.5 text-gray-100">
          <ChatMessage message={message}/>
        </p>
      </div>
    </div>
  )
}
