import { useCallback, useEffect, useRef } from 'react';
import { Socket } from 'socket.io-client';
import { ClientToServerEvents, ServerToClientEvents } from '../../../../src/realtime/socket';
import { logger } from '../../utils/logger';

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
    
    // Create canvas and draw video frame
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    
    if (!ctx) {
      throw new Error('Could not get canvas context');
    }
    
    // Draw the video frame
    ctx.drawImage(video, 0, 0);
    
    // Convert to base64
    const imageData = canvas.toDataURL('image/png');
    
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
      
      logger.log('Sending screenshot data to server...');
      socket.emit('screenshotCaptured', imageData);
      
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