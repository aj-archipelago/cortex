import { useCallback, useEffect, useRef, useState } from 'react';

const FADE_DURATION = 300; // milliseconds
const DISPLAY_DURATION = 10000; // milliseconds (10 seconds)

type ImageOverlayProps = {
  imageUrls: string[];
  onComplete?: () => void;
  isAudioPlaying?: boolean;
};

export function ImageOverlay({ imageUrls, onComplete, isAudioPlaying = false }: ImageOverlayProps) {
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [shownImages, setShownImages] = useState<Set<string>>(new Set());
  const [isVisible, setIsVisible] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const previousAudioPlaying = useRef(isAudioPlaying);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const displayStartTimeRef = useRef<number | null>(null);
  
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Start display timer when image becomes visible
  useEffect(() => {
    if (isVisible && currentIndex >= 0) {
      displayStartTimeRef.current = Date.now();
    }
  }, [isVisible, currentIndex]);

  // Handle image transitions when audio stops and minimum time has passed
  useEffect(() => {
    if (previousAudioPlaying.current && !isAudioPlaying && currentIndex >= 0) {
      const timeElapsed = displayStartTimeRef.current ? Date.now() - displayStartTimeRef.current : 0;
      const remainingTime = Math.max(0, DISPLAY_DURATION - timeElapsed);

      clearTimer();
      
      if (remainingTime > 0) {
        // If minimum display time hasn't elapsed, wait for the remaining time
        timerRef.current = setTimeout(() => {
          const currentUrl = imageUrls[currentIndex];
          setIsVisible(false);
          setTimeout(() => {
            setShownImages(prev => new Set(Array.from(prev).concat([currentUrl])));
            setCurrentIndex(-1);
          }, FADE_DURATION);
        }, remainingTime);
      } else {
        // If minimum time has elapsed, start fade immediately
        const currentUrl = imageUrls[currentIndex];
        setIsVisible(false);
        setTimeout(() => {
          setShownImages(prev => new Set(Array.from(prev).concat([currentUrl])));
          setCurrentIndex(-1);
        }, FADE_DURATION);
      }
    }
    previousAudioPlaying.current = isAudioPlaying;
  }, [isAudioPlaying, currentIndex, imageUrls, clearTimer]);

  // Start timer when new image is shown
  useEffect(() => {
    if (currentIndex >= 0 && !isAudioPlaying) {
      clearTimer();
      timerRef.current = setTimeout(() => {
        const currentUrl = imageUrls[currentIndex];
        setIsVisible(false);
        setTimeout(() => {
          setShownImages(prev => new Set(Array.from(prev).concat([currentUrl])));
          setCurrentIndex(-1);
        }, FADE_DURATION);
      }, DISPLAY_DURATION);

      return () => clearTimer();
    }
  }, [currentIndex, imageUrls, isAudioPlaying, clearTimer]);

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

  const handleImageSelect = (index: number) => {
    clearTimer();
    displayStartTimeRef.current = Date.now();
    setCurrentIndex(index);
    // Start with image invisible for manual selection too
    setIsVisible(false);
    setTimeout(() => setIsVisible(true), 50);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  if (!imageUrls.length) {
    return null;
  }

  return (
    <div 
      className="absolute inset-0 flex items-center justify-center"
      onMouseEnter={() => {
        setShowControls(true);
      }}
      onMouseLeave={() => {
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