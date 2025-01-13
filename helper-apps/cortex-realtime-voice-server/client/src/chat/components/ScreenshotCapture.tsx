import { useCallback, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { ClientToServerEvents, ServerToClientEvents } from '../../../../src/realtime/socket';
import { logger } from '../../utils/logger';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB limit
const MAX_DIMENSION = 3840; // Max width/height
const COMPRESSION_QUALITY = 0.9; // Image quality (0.0 to 1.0)

type ScreenshotCaptureProps = {
  socket: Socket<ServerToClientEvents, ClientToServerEvents>;
};

export const ScreenshotCapture = ({ socket }: ScreenshotCaptureProps) => {
  const activeStreamRef = useRef<MediaStream | null>(null);

  const startScreenCapture = useCallback(async () => {
    logger.log('Starting screen capture...');
    try {
      // Request screen capture with friendly message and whole screen preference
      logger.log('Requesting display media...');
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { 
          frameRate: 1,
          displaySurface: 'monitor', // Prefer whole screen
          cursor: 'never' // Don't need cursor
        } as MediaTrackConstraints
      });
      
      // Store the stream reference
      activeStreamRef.current = stream;

      // Handle stream ending (user clicks "Stop Sharing")
      stream.getVideoTracks()[0].onended = () => {
        logger.log('Screen sharing stopped by user');
        activeStreamRef.current = null;
      };

      return stream;
    } catch (error) {
      logger.error('Error starting screen capture:', error);
      activeStreamRef.current = null;
      throw error;
    }
  }, []);

  const captureFrame = useCallback(async (stream: MediaStream) => {
    logger.log('Capturing frame from stream...');
    const track = stream.getVideoTracks()[0];
    
    // Create video element to capture frame
    const video = document.createElement('video');
    video.srcObject = stream;
    
    // Wait for video to load
    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => {
        logger.log('Video metadata loaded, playing...');
        video.play();
        resolve();
      };
    });
    
    // Create canvas and calculate dimensions
    let width = video.videoWidth;
    let height = video.videoHeight;
    
    // Scale down if dimensions exceed maximum
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const aspectRatio = width / height;
      if (width > height) {
        width = MAX_DIMENSION;
        height = Math.round(width / aspectRatio);
      } else {
        height = MAX_DIMENSION;
        width = Math.round(height * aspectRatio);
      }
    }
    
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Could not get canvas context');
    }
    
    // Draw the video frame with scaling if needed
    ctx.drawImage(video, 0, 0, width, height);
    
    // Try different compression levels if needed
    let imageData = canvas.toDataURL('image/jpeg', COMPRESSION_QUALITY);
    let attempts = 3;
    let currentQuality = COMPRESSION_QUALITY;
    
    while (imageData.length > MAX_IMAGE_SIZE && attempts > 0) {
      currentQuality *= 0.8; // Reduce quality by 20% each attempt
      imageData = canvas.toDataURL('image/jpeg', currentQuality);
      attempts--;
      logger.log(`Compressing image, attempt ${3 - attempts}, size: ${Math.round(imageData.length / 1024)}KB`);
    }
    
    if (imageData.length > MAX_IMAGE_SIZE) {
      throw new Error('Screenshot too large even after compression');
    }
    
    // Clean up
    video.remove();
    canvas.remove();
    
    return imageData;
  }, []);

  const handleScreenshotRequest = useCallback(async () => {
    try {
      // Use existing stream or request new one
      const stream = activeStreamRef.current || await startScreenCapture();
      
      // Capture frame from stream
      const imageData = await captureFrame(stream);
      
      logger.log(`Screenshot captured (size: ${Math.round(imageData.length / 1024)}KB)...`);
      
      // Split into ~500KB chunks
      const CHUNK_SIZE = 500 * 1024;
      const chunks: string[] = [];
      
      for (let i = 0; i < imageData.length; i += CHUNK_SIZE) {
        chunks.push(imageData.slice(i, i + CHUNK_SIZE));
      }
      
      // Send chunks
      chunks.forEach((chunk, index) => {
        logger.log(`Sending chunk ${index + 1}/${chunks.length}`);
        socket.emit('screenshotChunk', chunk, index);
      });
      
      // Signal completion
      socket.emit('screenshotComplete', chunks.length);
      
    } catch (error) {
      logger.error('Error handling screenshot request:', error);
      socket.emit('screenshotError', error instanceof Error ? error.message : 'Failed to capture screenshot');
    }
  }, [socket, startScreenCapture, captureFrame]);

  useEffect(() => {
    logger.log('Setting up screenshot request listener');
    socket.on('requestScreenshot', handleScreenshotRequest);

    return () => {
      logger.log('Cleaning up screenshot request listener');
      socket.off('requestScreenshot');
      // Clean up stream if component unmounts
      if (activeStreamRef.current) {
        activeStreamRef.current.getTracks().forEach(track => track.stop());
        activeStreamRef.current = null;
      }
    };
  }, [socket, handleScreenshotRequest]);

  return null; // This is a non-visual component
}; 