import { useEffect, useRef } from 'react';

type MicrophoneVisualizerProps = {
  audioContext: AudioContext | null;
  sourceNode: MediaStreamAudioSourceNode | null;
};

export const MicrophoneVisualizer = ({ audioContext, sourceNode }: MicrophoneVisualizerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const animationRef = useRef<number>();

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
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 3;
      ctx.arc(canvas.width / 2, canvas.height / 2, 28, 0, Math.PI * 2);
      ctx.stroke();

      // Draw volume indicator
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${210 + normalizedVolume * 30}, 100%, 80%, ${0.6 + normalizedVolume * 0.4})`;
      ctx.lineWidth = 3;
      ctx.arc(canvas.width / 2, canvas.height / 2, 28, 0, Math.PI * 2 * normalizedVolume);
      ctx.stroke();

      // Enhanced glow effect
      ctx.shadowBlur = 15;
      ctx.shadowColor = `hsla(${210 + normalizedVolume * 30}, 100%, 70%, ${0.8})`;

      // Optional: Add a second glow pass for more intensity
      ctx.beginPath();
      ctx.strokeStyle = `hsla(${210 + normalizedVolume * 30}, 100%, 90%, ${0.3 + normalizedVolume * 0.7})`;
      ctx.lineWidth = 2;
      ctx.arc(canvas.width / 2, canvas.height / 2, 29, 0, Math.PI * 2 * normalizedVolume);
      ctx.stroke();

      animationRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [audioContext, sourceNode]);

  return (
    <canvas 
      ref={canvasRef} 
      width="64" 
      height="64" 
      className="w-16 h-16"
    />
  );
}; 