export function arrayBufferToBase64(
  arrayBuffer: ArrayBuffer | Int16Array,
): string {
  let buffer: ArrayBuffer;
  if (arrayBuffer instanceof ArrayBuffer) {
    buffer = arrayBuffer;
  } else {
    buffer = arrayBuffer.buffer as ArrayBuffer;
  }

  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x80_00; // 32KB chunk size
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as any);
  }

  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64)
  const len = binaryString.length
  const bytes = new Uint8Array(len)

  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  return bytes.buffer as ArrayBuffer;
}
