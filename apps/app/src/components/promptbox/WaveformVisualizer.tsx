import { useEffect, useRef } from "react";
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";
import { cn } from "@bb/shared-ui/lib/utils";

interface WaveformVisualizerProps {
  stream: MediaStream | null;
  active: boolean;
  className?: string;
}

const BAR_WIDTH = 3;
const BAR_GAP = 2;
const BAR_PITCH = BAR_WIDTH + BAR_GAP;
const SAMPLE_EVERY_N_FRAMES = 2;
const NOISE_FLOOR = 0.006;
const AMPLITUDE_GAIN = 8;
const AMPLITUDE_GAMMA = 0.6;
const IDLE_AMPLITUDE = 0.06;

export function WaveformVisualizer({
  stream,
  active,
  className,
}: WaveformVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barsRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const layout = {
      color: "currentColor",
      cssWidth: 0,
      cssHeight: 0,
      barCount: 1,
      midY: 0,
      maxHalf: 0,
      edgeFade: 0,
    };

    const measure = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      layout.cssWidth = rect.width;
      layout.cssHeight = rect.height;
      canvas.width = Math.max(1, Math.round(layout.cssWidth * dpr));
      canvas.height = Math.max(1, Math.round(layout.cssHeight * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      layout.color = getComputedStyle(canvas).color || layout.color;
      ctx.strokeStyle = layout.color;
      ctx.lineCap = "round";
      ctx.lineWidth = BAR_WIDTH;
      layout.midY = layout.cssHeight / 2;
      layout.maxHalf = Math.max(0, (layout.cssHeight * 0.95 - BAR_WIDTH) / 2);
      layout.edgeFade = layout.cssWidth * 0.15;
      layout.barCount = Math.max(1, Math.floor(layout.cssWidth / BAR_PITCH));
      if (barsRef.current.length > layout.barCount) {
        barsRef.current = barsRef.current.slice(
          barsRef.current.length - layout.barCount,
        );
      }
    };

    const draw = () => {
      ctx.clearRect(0, 0, layout.cssWidth, layout.cssHeight);
      const bars = barsRef.current;
      for (let i = 0; i < bars.length; i++) {
        const amp = bars[bars.length - 1 - i];
        const cx = layout.cssWidth - BAR_WIDTH / 2 - i * BAR_PITCH;
        if (cx + BAR_WIDTH < 0) break;
        const half = amp * layout.maxHalf;
        ctx.globalAlpha =
          cx < layout.edgeFade
            ? Math.max(0.15, cx / layout.edgeFade)
            : 1;
        ctx.beginPath();
        ctx.moveTo(cx, layout.midY - half);
        ctx.lineTo(cx, layout.midY + half);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    const observeResize = (onResize: () => void): (() => void) | null => {
      if (typeof ResizeObserver === "undefined") return null;
      return observeSharedResize(canvas, {
        read: () => undefined,
        write: onResize,
      });
    };

    const redrawOnResize = () => {
      measure();
      draw();
    };

    measure();

    const audioTrack = stream?.getAudioTracks()[0] ?? null;
    const canAnimate =
      active &&
      audioTrack !== null &&
      typeof window.AudioContext !== "undefined";

    if (!canAnimate || audioTrack === null) {
      if (barsRef.current.length === 0) {
        barsRef.current = Array.from(
          { length: layout.barCount },
          () => IDLE_AMPLITUDE,
        );
      }
      draw();
      const unobserve = observeResize(redrawOnResize);
      return () => unobserve?.();
    }

    const audioCtx = new AudioContext();
    void audioCtx.resume().catch(() => {});
    const analysisTrack = audioTrack.clone();
    const source = audioCtx.createMediaStreamSource(
      new MediaStream([analysisTrack]),
    );
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const timeData = new Uint8Array(analyser.fftSize);
    const animationState = { frame: 0, rafId: 0 };

    const tick = () => {
      if (audioCtx.state === "suspended")
        void audioCtx.resume().catch(() => {});
      if (animationState.frame % SAMPLE_EVERY_N_FRAMES === 0) {
        analyser.getByteTimeDomainData(timeData);
        let sumSquares = 0;
        for (let i = 0; i < timeData.length; i++) {
          const centered = (timeData[i] - 128) / 128;
          sumSquares += centered * centered;
        }
        const rms = Math.sqrt(sumSquares / timeData.length);
        const boosted = Math.max(0, rms - NOISE_FLOOR) * AMPLITUDE_GAIN;
        const amp = Math.min(1, boosted ** AMPLITUDE_GAMMA);
        const bars = barsRef.current;
        bars.push(amp);
        if (bars.length > layout.barCount) bars.shift();
        draw();
      }
      animationState.frame++;
      animationState.rafId = requestAnimationFrame(tick);
    };

    const unobserve = observeResize(redrawOnResize);
    animationState.rafId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationState.rafId);
      unobserve?.();
      source.disconnect();
      analyser.disconnect();
      analysisTrack.stop();
      void audioCtx.close().catch(() => {});
    };
  }, [stream, active]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("block h-full w-full text-foreground", className)}
    />
  );
}
