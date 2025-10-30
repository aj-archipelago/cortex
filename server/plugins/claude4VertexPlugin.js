import Claude3VertexPlugin from "./claude3VertexPlugin.js";
import logger from "../../lib/logger.js";
import axios from 'axios';

// Claude 4 default maximum file size limit (30MB) for both images and PDFs
const CLAUDE4_DEFAULT_MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB

// Helper function to detect file type from URL or content
function detectFileType(url, contentType) {
  const lowerUrl = url.toLowerCase();
  
  // Check for data URLs first and extract media type
  if (lowerUrl.startsWith('data:')) {
    const match = lowerUrl.match(/data:([^;,]+)/);
    if (match) {
      const mediaType = match[1];
      if (mediaType.includes('pdf')) return 'pdf';
      if (mediaType.includes('text') || mediaType.includes('markdown')) return 'text';
    }
  }
  
  // Check URL extension - extract path before query string/fragment and check if it ends with extension
  // Remove query string and fragment for more accurate extension detection
  const urlPath = lowerUrl.split('?')[0].split('#')[0];
  if (urlPath.endsWith('.pdf')) return 'pdf';
  if (urlPath.endsWith('.txt') || urlPath.endsWith('.text')) return 'text';
  if (urlPath.endsWith('.md') || urlPath.endsWith('.markdown')) return 'text';
  
  // Check content type parameter
  if (contentType) {
    if (contentType.includes('pdf')) return 'pdf';
    if (contentType.includes('text/plain') || contentType.includes('text/markdown')) return 'text';
  }
  
  return null;
}

// Fetch image and convert to base64 data URL (copy from parent)
async function fetchImageAsDataURL(imageUrl) {
  try {
    const dataResponse = await axios.get(imageUrl, {
      timeout: 30000,
      responseType: 'arraybuffer',
      maxRedirects: 5
    });

    const contentType = dataResponse.headers['content-type'];
    const base64Image = Buffer.from(dataResponse.data).toString('base64');
    return `data:${contentType};base64,${base64Image}`;
  } catch (e) {
    logger.error(`Failed to fetch image: ${imageUrl}. ${e}`);
    throw e;
  }
}

// Fetch file and convert to base64
async function fetchFileAsDataURL(fileUrl, fileType) {
  try {
    const dataResponse = await axios.get(fileUrl, {
      timeout: 30000,
      responseType: 'arraybuffer',
      maxRedirects: 5
    });

    const contentType = dataResponse.headers['content-type'];
    const base64Data = Buffer.from(dataResponse.data).toString('base64');
    
    // Return appropriate data URL format
    if (fileType === 'pdf') {
      return `data:application/pdf;base64,${base64Data}`;
    } else if (fileType === 'text') {
      return `data:text/plain;base64,${base64Data}`;
    }
    
    return `data:${contentType};base64,${base64Data}`;
  } catch (e) {
    logger.error(`Failed to fetch file: ${fileUrl}. ${e}`);
    throw e;
  }
}

// Fetch text file and return as plain text
async function fetchTextFileAsString(fileUrl) {
  try {
    const dataResponse = await axios.get(fileUrl, {
      timeout: 30000,
      responseType: 'text',
      maxRedirects: 5
    });

    return dataResponse.data;
  } catch (e) {
    logger.error(`Failed to fetch text file: ${fileUrl}. ${e}`);
    throw e;
  }
}

// Extended convertContentItem function that handles PDFs and text files
async function convertContentItemClaude4(item, maxImageSize, plugin) {
  try {
    switch (typeof item) {
      case "string":
        return item ? { type: "text", text: item } : null;

      case "object":
        switch (item.type) {
          case "text":
            // Handle text content, but also check if it's stringified JSON containing documents
            if (!item.text) return null;
            
            // Try to parse stringified JSON to check if it's actually a document
            let parsedText = item.text;
            if (typeof item.text === 'string' && item.text.startsWith('{')) {
              try {
                const parsed = JSON.parse(item.text);
                // If this is stringified JSON for an image_url or document, process it accordingly
                if (parsed.type === 'image_url') {
                  return await convertContentItemClaude4(parsed, maxImageSize, plugin);
                } else if (parsed.type === 'document') {
                  return await convertContentItemClaude4(parsed, maxImageSize, plugin);
                }
              } catch (e) {
                // Not valid JSON, treat as plain text
              }
            }
            
            return { type: "text", text: parsedText };

          case "tool_use":
            return {
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: typeof item.input === 'string' ? { query: item.input } : item.input
            };

          case "tool_result":
            return {
              type: "tool_result",
              tool_use_id: item.tool_use_id,
              content: item.content
            };

          case "image_url":
            // Handle images and documents coming as image_url type
            // May include: image_url.url, url, originalFilename
            // Note: gcs URLs are for Google models only, Claude uses the main url
            // Handle both: { image_url: "string" } and { image_url: { url: "string" } }
            let imageUrl = item.url || item.image_url?.url;
            if (typeof item.image_url === 'string') {
              imageUrl = item.image_url;
            }
            
            const originalFilename = item.originalFilename || '';
            
            if (!imageUrl) {
              logger.warn("Could not parse image URL from content - skipping image content.");
              return null;
            }

            // Check if this is actually a PDF document (by filename or URL extension)
            // Do this BEFORE image validation since PDFs are not images
            const isPDF = originalFilename.toLowerCase().endsWith('.pdf') || 
                          detectFileType(imageUrl) === 'pdf';
            const isTxt = originalFilename.toLowerCase().endsWith('.txt') ||
                          originalFilename.toLowerCase().endsWith('.md');

            // Handle PDF documents
            if (isPDF) {
              try {
                // Fetch the PDF from the URL (Azure Blob Storage or http/https)
                const pdfData = await fetchFileAsDataURL(imageUrl, 'pdf');
                const base64Pdf = pdfData.split(",")[1];
                const pdfSize = Buffer.from(base64Pdf, 'base64').length;
                
                if (pdfSize > maxImageSize) {
                  logger.warn(`PDF size ${pdfSize} bytes exceeds maximum allowed size ${maxImageSize} - skipping PDF content.`);
                  return null;
                }
                
                return {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: base64Pdf
                  }
                };
              } catch (error) {
                logger.error(`Failed to fetch PDF from image_url field: ${error.message}`);
                return null;
              }
            }

            // Handle text documents
            if (isTxt) {
              try {
                const textContent = await fetchTextFileAsString(imageUrl);
                return {
                  type: "text",
                  text: textContent
                };
              } catch (error) {
                logger.error(`Failed to fetch text file from image_url field: ${error.message}`);
                return null;
              }
            }

            // Only validate and handle as image if not a document
            try {
              if (!await plugin.validateImageUrl(imageUrl)) {
                return null;
              }

              const urlData = imageUrl.startsWith("data:") ? imageUrl : await fetchImageAsDataURL(imageUrl);
              if (!urlData) { return null; }
              
              const base64Image = urlData.split(",")[1];
              const base64Size = Buffer.from(base64Image, 'base64').length;
              
              if (base64Size > maxImageSize) {
                logger.warn(`Image size ${base64Size} bytes exceeds maximum allowed size ${maxImageSize} - skipping image content.`);
                return null;
              }
              
              const [, mimeType = "image/jpeg"] = urlData.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/) || [];

              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64Image,
                },
              };
            } catch (error) {
              logger.error(`Failed to process image: ${error.message}`);
              return null;
            }

          case "document":
            // Handle Claude document blocks (PDFs and text files)
            const documentUrl = item.url || item.source?.url;
            const documentData = item.data || item.source?.data;
            const documentFileId = item.file_id || item.source?.file_id;
            
            if (documentFileId) {
              // Use file_id reference
              return {
                type: "document",
                source: {
                  type: "file",
                  file_id: documentFileId
                }
              };
            } else if (documentUrl) {
              // Determine file type
              const fileType = detectFileType(documentUrl);
              
              if (fileType === 'pdf') {
                // Fetch PDF and convert to base64
                const pdfData = await fetchFileAsDataURL(documentUrl, 'pdf');
                const base64Pdf = pdfData.split(",")[1];
                const pdfSize = Buffer.from(base64Pdf, 'base64').length;
                
                if (pdfSize > maxImageSize) {
                  logger.warn(`PDF size ${pdfSize} bytes exceeds maximum allowed size ${maxImageSize} - skipping PDF content.`);
                  return null;
                }
                
                return {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: base64Pdf
                  }
                };
              } else if (fileType === 'text') {
                // For text files, we can send as plain text or base64
                // Using plain text is more efficient
                const textContent = await fetchTextFileAsString(documentUrl);
                return {
                  type: "text",
                  text: textContent
                };
              } else {
                logger.warn(`Unsupported document type for URL: ${documentUrl}`);
                return null;
              }
            } else if (documentData) {
              // Already have base64 data
              const mediaType = item.media_type || item.source?.media_type || "application/pdf";
              
              if (mediaType.includes('pdf')) {
                const pdfSize = Buffer.from(documentData, 'base64').length;
                
                if (pdfSize > maxImageSize) {
                  logger.warn(`PDF size ${pdfSize} bytes exceeds maximum allowed size ${maxImageSize} - skipping PDF content.`);
                  return null;
                }
                
                return {
                  type: "document",
                  source: {
                    type: "base64",
                    media_type: "application/pdf",
                    data: documentData
                  }
                };
              } else if (mediaType.includes('text')) {
                // Decode base64 text data
                const textContent = Buffer.from(documentData, 'base64').toString('utf-8');
                return {
                  type: "text",
                  text: textContent
                };
              }
            }
            
            logger.warn("Could not parse document content - skipping document.");
            return null;

          default:
            return null;
        }

      default:
        return null;
    }
  } catch (e) {
    logger.warn(`Error converting content item: ${e}`);
    return null;
  }
}

class Claude4VertexPlugin extends Claude3VertexPlugin {
  
  constructor(pathway, model) {
    super(pathway, model);
    this.isMultiModal = true;
  }
  
  // Override to use 30MB default for Claude 4 (instead of 20MB)
  getModelMaxImageSize() {
    return (this.promptParameters.maxImageSize ?? this.model.maxImageSize ?? CLAUDE4_DEFAULT_MAX_FILE_SIZE);
  }
  
  // Override convertMessagesToClaudeVertex to use the extended content conversion
  async convertMessagesToClaudeVertex(messages) {
    // Create a deep copy of the input messages
    const messagesCopy = JSON.parse(JSON.stringify(messages));
  
    let system = "";
    let imageCount = 0;
    const maxImages = 20; // Claude allows up to 20 images per request
  
    // Extract system messages
    const systemMessages = messagesCopy.filter(message => message.role === "system");
    if (systemMessages.length > 0) {
      system = systemMessages.map(message => {
        if (Array.isArray(message.content)) {
          return message.content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join("\n");
        }
        return message.content;
      }).join("\n");
    }
  
    // Filter out system messages and empty messages
    let modifiedMessages = messagesCopy
      .filter(message => message.role !== "system")
      .map(message => {
        if (message.tool_calls) {
          return {
            role: message.role,
            content: message.tool_calls.map(toolCall => ({
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments)
            }))
          };
        }
        
        if (message.role === "tool") {
          return {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: message.content
            }]
          };
        }

        return { ...message };
      })
      .filter(message => {
        if (!message.content) return false;
        if (Array.isArray(message.content) && message.content.length === 0) return false;
        return true;
      });

    // Combine consecutive messages from the same author
    const combinedMessages = modifiedMessages.reduce((acc, message) => {
      if (acc.length === 0 || message.role !== acc[acc.length - 1].role) {
        acc.push({ ...message });
      } else {
        const lastMessage = acc[acc.length - 1];
        if (Array.isArray(lastMessage.content) && Array.isArray(message.content)) {
          lastMessage.content = [...lastMessage.content, ...message.content];
        } else if (Array.isArray(lastMessage.content)) {
          lastMessage.content.push({ type: 'text', text: message.content });
        } else if (Array.isArray(message.content)) {
          lastMessage.content = [{ type: 'text', text: lastMessage.content }, ...message.content];
        } else {
          lastMessage.content += "\n" + message.content;
        }
      }
      return acc;
    }, []);
  
    // Ensure an odd number of messages
    const finalMessages = combinedMessages.length % 2 === 0
      ? combinedMessages.slice(1)
      : combinedMessages;
  
    // Convert content items using the extended conversion function
    const claude4Messages = await Promise.all(
      finalMessages.map(async (message) => {
        const contentArray = Array.isArray(message.content) ? message.content : [message.content];
        const claude4Content = await Promise.all(contentArray.map(async item => {
          const convertedItem = await convertContentItemClaude4(item, this.getModelMaxImageSize(), this);
          
          // Track image count
          if (convertedItem?.type === 'image') {
            imageCount++;
            if (imageCount > maxImages) {
              logger.warn(`Maximum number of images (${maxImages}) exceeded - skipping additional images.`);
              return null;
            }
          }
          
          return convertedItem;
        }));
        return {
          role: message.role,
          content: claude4Content.filter(Boolean),
        };
      })
    );
  
    return {
      system,
      modifiedMessages: claude4Messages,
    };
  }

  // Override logging to handle document blocks
  logRequestData(data, responseData, prompt) {
    const { stream, messages, system } = data;
    if (system) {
      const { length, units } = this.getLength(system);
      logger.info(`[system messages sent containing ${length} ${units}]`);
      logger.verbose(`${this.shortenContent(system)}`);
    }

    if (messages && messages.length > 1) {
      logger.info(`[chat request sent containing ${messages.length} messages]`);
      let totalLength = 0;
      let totalUnits;
      messages.forEach((message, index) => {
        const content = Array.isArray(message.content)
          ? message.content.map((item) => {
              if (item.source && item.source.type === 'base64') {
                item.source.data = '* base64 data truncated for log *';
              }
              if (item.type === 'document') {
                return `{type: document, source: ${JSON.stringify(item.source)}}`;
              }
              return JSON.stringify(item);
            }).join(", ")
          : message.content;
        const { length, units } = this.getLength(content);
        const preview = this.shortenContent(content);

        logger.verbose(
          `message ${index + 1}: role: ${
            message.role
          }, ${units}: ${length}, content: "${preview}"`
        );
        totalLength += length;
        totalUnits = units;
      });
      logger.info(`[chat request contained ${totalLength} ${totalUnits}]`);
    } else {
      const message = messages[0];
      const content = Array.isArray(message.content)
        ? message.content.map((item) => {
            if (item.source && item.source.type === 'base64') {
              item.source.data = '* base64 data truncated for log *';
            }
            if (item.type === 'document') {
              return `{type: document, source: ${JSON.stringify(item.source)}}`;
            }
            return JSON.stringify(item);
          }).join(", ")
        : message.content;
      const { length, units } = this.getLength(content);
      logger.info(`[request sent containing ${length} ${units}]`);
      logger.verbose(`${this.shortenContent(content)}`);
    }

    if (stream) {
      logger.info(`[response received as an SSE stream]`);
    } else {
      const parsedResponse = this.parseResponse(responseData);
      
      if (typeof parsedResponse === 'string') {
          const { length, units } = this.getLength(parsedResponse);
          logger.info(`[response received containing ${length} ${units}]`);
          logger.verbose(`${this.shortenContent(parsedResponse)}`);
      } else {
          logger.info(`[response received containing object]`);
          logger.verbose(`${JSON.stringify(parsedResponse)}`);
      }
  }

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }

}

export default Claude4VertexPlugin;

