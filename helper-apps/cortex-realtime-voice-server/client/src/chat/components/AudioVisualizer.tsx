import { useEffect, useRef } from 'react';

type AudioVisualizerProps = {
  audioContext: AudioContext | null;
  analyserNode: AnalyserNode | null;
  width?: number;
  height?: number;
};

export function AudioVisualizer({ 
  audioContext, 
  analyserNode,
  width = 300,
  height = 300 
}: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotationRef = useRef(0);
  const colorShiftRef = useRef(0);
  const animationFrameRef = useRef<number>();

  useEffect(() => {
    if (!audioContext || !analyserNode || !canvasRef.current) return;

    // Update canvas size when width/height props change
    if (canvasRef.current) {
      canvasRef.current.width = width;
      canvasRef.current.height = height;
    }

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas || !analyserNode) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const bufferLength = analyserNode.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      analyserNode.getByteFrequencyData(dataArray);

      // Clear with fade effect
      ctx.fillStyle = 'rgba(17, 24, 39, 0.3)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const centerX = canvas.width / 2;
      const centerY = canvas.height / 2;
      const maxRadius = Math.min(centerX, centerY) - 10;

      // Draw outer circle
      ctx.beginPath();
      ctx.strokeStyle = `hsl(${210 + Math.sin(colorShiftRef.current) * 20}, 80%, 60%)`;
      ctx.lineWidth = 2;
      ctx.arc(centerX, centerY, maxRadius, 0, Math.PI * 2);
      ctx.stroke();

      // Define base colors with shifting hues
      const baseHue = 210 + Math.sin(colorShiftRef.current) * 20;
      const waveforms = [
        { 
          baseRadius: maxRadius * 0.4, 
          color: `hsl(${baseHue}, 90%, 70%)`,
          gradientColors: [`hsla(${baseHue}, 90%, 70%, 0.3)`, `hsla(${baseHue}, 90%, 50%, 0)`],
          rotation: rotationRef.current 
        },
        { 
          baseRadius: maxRadius * 0.6, 
          color: `hsl(${baseHue + 10}, 85%, 60%)`,
          gradientColors: [`hsla(${baseHue + 10}, 85%, 60%, 0.3)`, `hsla(${baseHue + 10}, 85%, 40%, 0)`],
          rotation: rotationRef.current + (Math.PI * 2 / 3) 
        },
        { 
          baseRadius: maxRadius * 0.8, 
          color: `hsl(${baseHue + 20}, 80%, 50%)`,
          gradientColors: [`hsla(${baseHue + 20}, 80%, 50%, 0.3)`, `hsla(${baseHue + 20}, 80%, 30%, 0)`],
          rotation: rotationRef.current + (Math.PI * 4 / 3) 
        }
      ];

      waveforms.forEach(({ baseRadius, color, gradientColors, rotation }) => {
        const points: [number, number][] = [];
        
        for (let i = 0; i <= bufferLength; i++) {
          const amplitude = dataArray[i % bufferLength] / 255.0;
          const angle = (i * 2 * Math.PI) / bufferLength + rotation;
          
          const radius = baseRadius + (maxRadius * 0.4 * amplitude);
          const x = centerX + Math.cos(angle) * radius;
          const y = centerY + Math.sin(angle) * radius;
          
          points.push([x, y]);
        }

        // Create gradient for fill
        const gradient = ctx.createRadialGradient(
          centerX, centerY, baseRadius * 0.8,
          centerX, centerY, baseRadius * 1.2
        );
        gradient.addColorStop(0, gradientColors[0]);
        gradient.addColorStop(1, gradientColors[1]);

        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        points.forEach(([x, y]) => {
          ctx.lineTo(x, y);
        });
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        ctx.beginPath();
        points.forEach(([x, y], i) => {
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.closePath();
        ctx.stroke();

        ctx.shadowBlur = 15;
        ctx.shadowColor = color;
      });

      rotationRef.current += 0.002;
      colorShiftRef.current += 0.005;
      
      animationFrameRef.current = requestAnimationFrame(draw);
    };

    draw();

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [audioContext, analyserNode, width, height]);

  return (
    <div className="w-full h-full flex items-center justify-center pointer-events-none">
      <div className="aspect-square w-full max-h-full">
        <canvas 
          ref={canvasRef} 
          width={width}
          height={height}
          className="bg-gray-900 rounded-lg w-full h-full object-contain pointer-events-none"
        />
      </div>
    </div>
  );
} 