import { useEffect, useRef, useState } from 'react';

export function PerformanceMonitor() {
  const [fps, setFps] = useState<number | null>(null);
  const frameTimesRef = useRef<number[]>([]);
  const rafRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(performance.now());

  useEffect(() => {
    function tick(now: number) {
      const delta = now - lastTimeRef.current;
      lastTimeRef.current = now;

      if (delta > 0) {
        const times = frameTimesRef.current;
        times.push(delta);
        if (times.length > 30) times.shift();
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        setFps(Math.round(1000 / avg));
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  const fpsClass =
    fps === null ? 'unknown' : fps >= 55 ? 'good' : fps >= 30 ? 'ok' : 'low';

  return (
    <div aria-label="performance monitor" className="perf-monitor">
      <span className={`perf-monitor-fps ${fpsClass}`}>{fps ?? '—'}</span>
      <span className="perf-monitor-label">fps</span>
    </div>
  );
}
