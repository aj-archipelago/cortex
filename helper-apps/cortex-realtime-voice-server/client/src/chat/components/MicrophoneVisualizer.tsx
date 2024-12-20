import { useEffect, useRef } from 'react';

type MicrophoneVisualizerProps = {
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  size?: 'small' | 'large';
};

export const MicrophoneVisualizer = ({ 
  audioContext, 
  sourceNode,
  size = 'large' 
}: MicrophoneVisualizerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>();

  const dimensions = size === 'small' ? 48 : 64;
  const ringRadius = size === 'small' ? 21 : 28;

  useEffect(() => {
    if (!audioContext || !sourceNode || !canvasRef.current) return;

    const analyzer = audioContext.createAnalyser();
    analyzerRef.current = analyzer;
    
    analyzer.fftSize = 256;
    analyzer.smoothingTimeConstant = 0.7;
    
    sourceNode.connect(analyzer);

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas || !analyzer) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const bufferLength = analyzer.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyzer.getByteFrequencyData(dataArray);

      // Calculate average volume
      const average = dataArray.reduce((a, b) => a + b) / bufferLength;
      const normalizedVolume = Math.min(average / 128, 1);

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Draw background ring
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = size === 'small' ? 3 : 4;
      ctx.arc(canvas.width / 2, canvas.height / 2, ringRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Draw volume indicator with increased brightness
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${210 + normalizedVolume * 30}, 100%, 90%, 1.0)`;
      ctx.lineWidth = size === 'small' ? 3 : 4;
      ctx.arc(canvas.width / 2, canvas.height / 2, ringRadius, 0, Math.PI * 2 * normalizedVolume);
      ctx.stroke();

      // Subtle glow effect
      ctx.shadowBlur = 10;
      ctx.shadowColor = `hsla(${210 + normalizedVolume * 30}, 100%, 70%, ${0.6})`;

      // Simpler second pass
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${210 + normalizedVolume * 30}, 100%, 95%, ${0.4 + normalizedVolume * 0.4})`;
      ctx.lineWidth = 2;
      ctx.arc(canvas.width / 2, canvas.height / 2, ringRadius + 1, 0, Math.PI * 2 * normalizedVolume);
      ctx.stroke();

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [audioContext, sourceNode, size, ringRadius]);

  return (
    <canvas 
      ref={canvasRef} 
      width={dimensions} 
      height={dimensions} 
      className={size === 'small' ? 'w-12 h-12' : 'w-16 h-16'}
    />
  );
}; 