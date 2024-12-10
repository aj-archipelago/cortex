import Markdown from "react-markdown";

type ChatMessageProps = {
  message: string;
}

export const ChatMessage = ({message}: ChatMessageProps) => {
  return <Markdown
    children={message}
    components={{
      h1: ({children}) => <h1 className="text-xl font-bold text-gray-100">{children}</h1>,
      h2: ({children}) => <h2 className="text-lg font-semi-bold text-gray-100">{children}</h2>,
      p: ({children}) => <p className="text-sm font-normal text-gray-100">{children}</p>,
      ol: ({children}) => <ol className="list-decimal list-inside">{children}</ol>,
      ul: ({children}) => <ul className="list-disc list-inside">{children}</ul>
    }}
  />;
}
