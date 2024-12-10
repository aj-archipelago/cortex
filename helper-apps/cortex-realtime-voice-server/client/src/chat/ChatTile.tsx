import {ChatBubble} from './ChatBubble';
import {ChatMessageInput} from './ChatMessageInput';
import React, {useEffect, useRef} from 'react';
import {useWindowResize} from "./hooks/useWindowResize";

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
  const containerRef = useRef<any>(null);
  const size = useWindowResize();
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      if (containerRef.current.scrollToEnd) containerRef.current.scrollToEnd();
    }
  }, [containerRef, messages]);

  return (
    <div className="flex flex-col h-full w-full min-w-72">
      <div
        className="flex flex-col h-full"
        style={{
          height: size.height,
        }}
      >
        <h1 className='text-xl font-bold text-center text-white p-3 bg-black'>Chat</h1>
        <div
          ref={containerRef}
          className="h-full overflow-y-auto grow"
        >
          {messages.map((message, index) => {
            if (message.isImage) {
              return (
                <img
                  className="flex ml-3 w-[256] h-[256]"
                  width={512}
                  height={512}
                  key={index}
                  src={message.message}
                  alt={message.name}
                />);
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
        </div>
        <ChatMessageInput
          placeholder="Type a message"
          onSend={onSend}
          onStartStop={onStartStop}
        />
      </div>
    </div>
  );
};
