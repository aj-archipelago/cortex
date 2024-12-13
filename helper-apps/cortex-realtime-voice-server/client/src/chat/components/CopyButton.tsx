import React, { useState } from 'react';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';

interface CopyButtonProps {
  text: string;
  className?: string;
}

export const CopyButton: React.FC<CopyButtonProps> = ({ text, className = '' }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className={`p-1 text-gray-400 hover:text-cyan-400 transition-colors duration-200 ${className}`}
      title="Copy to clipboard"
    >
      {copied ? (
        <CheckIcon sx={{ fontSize: 16 }} />
      ) : (
        <ContentCopyIcon sx={{ fontSize: 16 }} />
      )}
    </button>
  );
}; 