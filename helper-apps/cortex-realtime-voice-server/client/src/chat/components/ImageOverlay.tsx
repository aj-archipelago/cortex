import { useEffect, useState, useCallback } from 'react';

type ImageOverlayProps = {
  imageUrls: string[];
  onComplete?: () => void;
};

export const ImageOverlay = ({ imageUrls, onComplete }: ImageOverlayProps) => {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  
  // Track remaining time to handle pausing
  const [remainingTime, setRemainingTime] = useState(20000);
  
  const startTimers = useCallback(() => {
    if (isPaused) return;

    // Schedule fade out
    const fadeOutTimer = setTimeout(() => {
      setIsVisible(false);
    }, remainingTime); 

    // Schedule next image or completion
    const completionTimer = setTimeout(() => {
      if (currentIndex < imageUrls.length - 1) {
        setCurrentIndex(currentIndex + 1);
        setRemainingTime(20000); // Reset timer for next image
      } else {
        onComplete?.();
      }
    }, remainingTime + 1000); // Add 1s for fade out

    return { fadeOutTimer, completionTimer };
  }, [currentIndex, imageUrls.length, onComplete, isPaused, remainingTime]);

  useEffect(() => {
    if (imageUrls.length === 0) return;

    // Reset state when new images arrive
    setCurrentIndex(0);
    setRemainingTime(20000);
    setIsVisible(true);
    
    const timers = startTimers();
    
    let interval: NodeJS.Timeout | null = null;
    if (!isPaused) {
      interval = setInterval(() => {
        setRemainingTime(prev => Math.max(0, prev - 1000));
      }, 1000);
    }

    return () => {
      if (timers) {
        clearTimeout(timers.fadeOutTimer);
        clearTimeout(timers.completionTimer);
      }
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [imageUrls, isPaused, startTimers]);

  const handleMouseEnter = () => {
    setIsPaused(true);
  };

  const handleMouseLeave = () => {
    setIsPaused(false);
  };
  
  if (!imageUrls.length) return null;
  
  return (
    <div 
      className="absolute inset-0 flex items-center justify-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div 
        className={`absolute inset-0 bg-gray-900 transition-opacity duration-1000 ${
          isVisible ? 'opacity-50' : 'opacity-0'
        }`}
      />
      <img
        src={imageUrls[currentIndex]}
        alt="AI Generated"
        className={`relative z-10 w-full h-full object-contain transition-opacity duration-1000 ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      />
    </div>
  );
}; 