// Utility function for chunking text into smaller pieces
export function easyChunker(text) {
  const result = [];
  const n = 10000;

  // If the text is less than n characters, just process it as is
  if (text.length <= n) {
    return [text];
  }

  let startIndex = 0;
  while (startIndex < text.length) {
    let endIndex = Math.min(startIndex + n, text.length);

    // Make sure we don't split in the middle of a sentence
    while (
      endIndex > startIndex &&
      text[endIndex] !== "." &&
      text[endIndex] !== " "
    ) {
      endIndex--;
    }

    // If we didn't find a sentence break, just split at n characters
    if (endIndex === startIndex) {
      endIndex = startIndex + n;
    }

    // Push the chunk to the result array
    result.push(text.substring(startIndex, endIndex));

    // Move the start index to the next chunk
    startIndex = endIndex;
  }

  return result;
}
