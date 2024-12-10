import React, { useCallback, useRef, useState } from "react";

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
  const inputRef = useRef<HTMLInputElement>(null);

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
    <div className="flex flex-col gap-2 px-2 py-2 border-t border-t-gray-800">
      <button
        className="bg-transparent p-1.5 rounded-lg border-2 border-gray-600"
        onClick={handleStartStop}>
        <p className="text-s uppercase text-gray-200">{isRecording ? 'Stop' : 'Start'}</p>
      </button>
      <div className="flex flex-row pt-3 items-center">
        <input
          ref={inputRef}
          className={`grow text-gray-200 bg-transparent border-2 border-gray-600 p-1.5 rounded-lg`}
          style={{
            paddingLeft: message.length > 0 ? 12 : 24,
            caretShape: "block",
          }}
          placeholder={placeholder}
          value={message}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            e.target?.value && setMessage(e.target.value);
          }}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === "Enter") {
              handleSend();
            }
          }}
        />
        <button
          disabled={message.length === 0 || !onSend || !isRecording}
          onClick={handleSend}
          className={'bg-transparent p-1.5 ms-2 rounded-lg border-2 border-gray-600'}
        >
          <p className="text-s uppercase text-gray-200">Send</p>
        </button>
      </div>
    </div>
  );
};
