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
        <div
          ref={containerRef}
          className="h-full overflow-y-auto grow"
        >
          {messages.map((message, index) => {
            if (message.isImage) {
              return (
                <div className="flex flex-row justify-center items-center">
                  <a target="_blank" rel="noreferrer" href={message.message}>
                    <img
                      width={256}
                      height={256}
                      key={index}
                      src={message.message}
                      alt={message.name}
                    />
                  </a>
                </div>
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
