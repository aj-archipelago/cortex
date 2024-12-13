import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown, { Components } from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { nightOwl } from 'react-syntax-highlighter/dist/esm/styles/prism';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import SendIcon from '@mui/icons-material/Send';
import 'katex/dist/katex.min.css';
import { CopyButton } from './components/CopyButton';

// Define the code component props interface
interface CodeComponentProps {
  node?: any;
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
}

// Add types for math components
interface MathComponentProps {
  value: string;
}

// Extend Components type to include math components
interface MarkdownComponents extends Components {
  math?: (props: MathComponentProps) => JSX.Element;
  inlineMath?: (props: MathComponentProps) => JSX.Element;
}

export type ChatMessage = {
  id: string;
  name: string;
  message: string;
  isSelf: boolean;
  isImage: boolean;
  timestamp: number;
};

export type ChatTileProps = {
  messages: ChatMessage[];
  onSend: (message: string) => void;
  isConnected?: boolean;
};

const MessageContent = ({ message }: { message: string }) => {
  if (message.match(/^https?:\/\/.*\.(jpg|jpeg|png|gif|webp)$/i)) {
    return (
      <img 
        src={message} 
        alt="Shared" 
        className="max-w-full rounded-lg max-h-64 object-contain"
      />
    );
  }

  const components: MarkdownComponents = {
    code({ inline, className, children }: CodeComponentProps) {
      const match = /language-(\w+)/.exec(className || '');
      const language = match ? match[1] : '';
      
      if (!inline && language) {
        return (
          <div className="rounded-lg overflow-hidden my-2 relative group">
            <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <CopyButton text={String(children)} />
            </div>
            <SyntaxHighlighter
              style={nightOwl}
              language={language}
              customStyle={{
                margin: 0,
                background: 'transparent',
              }}
            >
              {String(children).replace(/\n$/, '')}
            </SyntaxHighlighter>
          </div>
        );
      }
      
      return inline ? (
        <code className="bg-gray-800/50 px-1.5 py-0.5 rounded text-cyan-300">
          {children}
        </code>
      ) : (
        <SyntaxHighlighter
          style={nightOwl}
          language="text"
          customStyle={{
            margin: 0,
            background: 'transparent',
          }}
        >
          {String(children).replace(/\n$/, '')}
        </SyntaxHighlighter>
      );
    },
    // Style links
    a: ({ node, children, ...props }) => (
      <a 
        {...props} 
        className="text-cyan-400 hover:text-cyan-300 underline"
        target="_blank" 
        rel="noopener noreferrer" 
      >
        {children}
      </a>
    ),
    // Style tables
    table: ({ node, ...props }) => (
      <div className="overflow-x-auto my-4">
        <table {...props} className="border-collapse table-auto w-full" />
      </div>
    ),
    th: ({ node, ...props }) => (
      <th {...props} className="border border-gray-600 px-4 py-2 bg-gray-800" />
    ),
    td: ({ node, ...props }) => (
      <td {...props} className="border border-gray-600 px-4 py-2" />
    ),
    // Add special styling for math blocks
    math: ({ value }) => (
      <div className="py-2 overflow-x-auto">
        <span>{value}</span>
      </div>
    ),
    inlineMath: ({ value }) => (
      <span className="px-1">{value}</span>
    ),
  };

  return (
    <ReactMarkdown
      className="prose prose-invert max-w-none"
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeRaw, rehypeKatex]}
      components={components}
    >
      {message}
    </ReactMarkdown>
  );
};

export function ChatTile({ messages, onSend, isConnected = false }: ChatTileProps) {
  const [message, setMessage] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Sort messages by timestamp before rendering
  const sortedMessages = [...messages].sort((a, b) => a.timestamp - b.timestamp);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (message.trim()) {
      onSend(message.trim());
      setMessage('');
    }
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className="h-full flex flex-col">
      {/* Messages container - scrollable */}
      <div className="flex-1 h-0 overflow-y-auto">
        <div className="p-4 space-y-4">
          {sortedMessages.map((msg) => (
            <div key={msg.id} className="flex flex-col">
              <div className={`w-full rounded-lg p-3 relative group ${
                msg.isSelf 
                  ? 'bg-blue-500/30 border border-blue-500/20' 
                  : 'bg-gray-700/30 border border-gray-600/20'
              }`}>
                <div className="flex justify-between items-start">
                  <div className="text-xs text-gray-400 mb-1">{msg.name}</div>
                  <div className="opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                    <CopyButton text={msg.message} />
                  </div>
                </div>
                <MessageContent message={msg.message} />
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} aria-hidden="true" />
        </div>
      </div>

      {/* Input area - fixed height */}
      <div className="flex-none h-[68px] border-t border-gray-700/50 p-4 bg-gray-900/30 backdrop-blur-sm">
        <form onSubmit={handleSubmit} className="flex space-x-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className={`flex-grow bg-gray-800/50 border border-gray-700/50 rounded-lg px-4 py-2 
                     text-gray-100 focus:outline-none focus:ring-2 focus:ring-cyan-500/50
                     ${!isConnected && 'opacity-50 cursor-not-allowed'}`}
            placeholder={isConnected ? "Type a message..." : "Connect to send messages..."}
            disabled={!isConnected}
          />
          <button
            type="submit"
            disabled={!isConnected}
            className={`p-2 rounded-lg bg-gradient-to-r from-blue-500 to-cyan-500 
                     ${isConnected ? 'hover:from-blue-600 hover:to-cyan-600' : 'opacity-50 cursor-not-allowed'}
                     shadow-lg shadow-cyan-500/20`}
          >
            <SendIcon sx={{ fontSize: 20 }} />
          </button>
        </form>
      </div>
    </div>
  );
}
