/**
 * Check if a MIME type is text-based and should be treated as text content.
 * This is used to determine if charset=utf-8 should be added to content-type headers.
 * 
 * @param {string} mimeType - The MIME type to check (may include charset parameter)
 * @returns {boolean} True if the MIME type is text-based
 */
export function isTextMimeType(mimeType) {
  if (!mimeType) return false;
  const baseType = mimeType.split(';')[0].trim().toLowerCase();
  return baseType.startsWith('text/') || 
         baseType === 'application/json' ||
         baseType === 'application/javascript' ||
         baseType === 'application/xml' ||
         baseType === 'application/xhtml+xml' ||
         baseType === 'application/x-sh' ||
         baseType === 'application/x-shellscript' ||
         (baseType.startsWith('application/x-') && baseType.includes('script'));
}

