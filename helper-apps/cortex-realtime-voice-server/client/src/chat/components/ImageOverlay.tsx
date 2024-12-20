import { useCallback, useEffect, useRef, useState } from 'react';

const FADE_DURATION = 300; // milliseconds
const DISPLAY_DURATION = 10000; // milliseconds (10 seconds)

type ImageOverlayProps = {
  imageUrls: string[];
  onComplete?: () => void;
};

export function ImageOverlay({ imageUrls, onComplete }: ImageOverlayProps) {
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [shownImages, setShownImages] = useState<Set<string>>(new Set());
  const [isVisible, setIsVisible] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const remainingTimeRef = useRef<number>(DISPLAY_DURATION);
  const startTimeRef = useRef<number | null>(null);
  
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const scheduleNextImage = useCallback(() => {
    if (currentIndex >= 0 && !isPaused) {
      const currentUrl = imageUrls[currentIndex];
      
      clearTimer();
      timerRef.current = setTimeout(() => {
        setIsVisible(false);
        setTimeout(() => {
          setShownImages(prev => new Set(Array.from(prev).concat([currentUrl])));
          setCurrentIndex(-1);
          remainingTimeRef.current = DISPLAY_DURATION;
        }, FADE_DURATION);
      }, remainingTimeRef.current);

      // Set start time for pause tracking
      startTimeRef.current = Date.now();
    }
  }, [currentIndex, isPaused, imageUrls, clearTimer]);

  // Handle image transitions
  useEffect(() => {
    if (currentIndex === -1) {
      const nextIndex = imageUrls.findIndex(url => !shownImages.has(url));
      if (nextIndex !== -1) {
        setCurrentIndex(nextIndex);
        setIsVisible(true);
      } else if (shownImages.size > 0) {
        onComplete?.();
      }
    }
  }, [imageUrls, shownImages, currentIndex, onComplete]);

  // Handle pause/resume
  useEffect(() => {
    if (isPaused) {
      clearTimer();
      if (startTimeRef.current) {
        const elapsed = Date.now() - startTimeRef.current;
        remainingTimeRef.current = Math.max(0, remainingTimeRef.current - elapsed);
        startTimeRef.current = null;
      }
    } else {
      scheduleNextImage();
    }

    return () => clearTimer();
  }, [isPaused, clearTimer, scheduleNextImage]);

  const handleImageSelect = (index: number) => {
    clearTimer();
    setCurrentIndex(index);
    // Start with image invisible for manual selection too
    setIsVisible(false);
    setTimeout(() => setIsVisible(true), 50);
  };

  if (!imageUrls.length) {
    return null;
  }

  return (
    <div 
      className="absolute inset-0 flex items-center justify-center"
      onMouseEnter={() => {
        console.log('Mouse enter - pausing');
        setIsPaused(true);
        setShowControls(true);
      }}
      onMouseLeave={() => {
        console.log('Mouse leave - resuming');
        setIsPaused(false);
        setShowControls(false);
      }}
    >
      {currentIndex !== -1 && (
        <img
          src={imageUrls[currentIndex]}
          alt="Generated content"
          style={{ 
            opacity: isVisible ? 1 : 0,
            transition: 'opacity 500ms ease-in-out'
          }}
          className="max-w-full max-h-full object-contain"
        />
      )}
      
      {/* Image selection controls */}
      <div 
        className={`absolute bottom-4 left-1/2 transform -translate-x-1/2 flex gap-2 p-2 bg-black/50 rounded-full transition-opacity duration-200 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <button
          onClick={() => {
            clearTimer();
            setCurrentIndex(-1);
            setIsVisible(false);
          }}
          className={`w-3 h-3 rounded-full transition-all ${
            currentIndex === -1 ? 'bg-white scale-110' : 'bg-white/50 hover:bg-white/75'
          }`}
          title="Hide all images"
        />
        {imageUrls.map((_, index) => (
          <button
            key={index}
            onClick={() => handleImageSelect(index)}
            className={`w-3 h-3 rounded-full transition-all ${
              currentIndex === index ? 'bg-white scale-110' : 'bg-white/50 hover:bg-white/75'
            }`}
            title={`Show image ${index + 1}`}
          />
        ))}
      </div>
    </div>
  );
} 