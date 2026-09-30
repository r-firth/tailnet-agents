import { useEffect, useRef } from 'react';

// Ordered (Bayer 4×4) dithering, used ONLY as light flavouring: the app mark,
// empty and loading states. Never applied to anything the user needs to read.

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function cssColor(v: string): [number, number, number] {
  const s = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) { const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  const r = s.match(/rgba?\(([^)]+)\)/);
  if (r) { const [a, b, c] = r[1].split(',').map((x) => parseFloat(x)); return [a, b, c]; }
  return [255, 122, 69];
}

export type DitherFn = (u: number, v: number, t: number) => number;

export const shapes: Record<string, DitherFn> = {
  mark: (u, v) => { const d = Math.hypot(u - 0.55, v - 0.45); return d < 0.5 ? Math.max(0, 1 - d * 1.7) : 0; },
  wave: (u, v, t) => Math.max(0, 1 - Math.abs(v - 0.5 - 0.3 * Math.sin(u * 7 + t)) * 3) * (1 - u * 0.6),
  glow: (u, v, t) => { const d = Math.hypot(u - 0.5, (v - 0.5) * 0.56); return Math.max(0, 0.62 - d * 1.25) * (0.75 + 0.25 * Math.sin(u * 9 + v * 4 + t)); },
  orbit: (u, v, t) => { const a = Math.atan2(v - 0.5, u - 0.5); const d = Math.hypot(u - 0.5, v - 0.5); return Math.max(0, 1 - Math.abs(d - 0.3) * 7) * (0.5 + 0.5 * Math.sin(a * 2 - t * 2)); },
};

interface Props {
  w: number;
  h: number;
  shape: keyof typeof shapes;
  color?: string; // css var name
  bg?: string | null; // css var name or null for transparent
  alpha?: number;
  animate?: boolean;
  className?: string;
  theme?: string; // pass to redraw on theme change
}

export function Dither({ w, h, shape, color = '--agent', bg = null, alpha = 255, animate = false, className, theme }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const col = cssColor(color);
    const bgc = bg ? cssColor(bg) : null;
    const fn = shapes[shape];
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0, t = 0, last = 0;
    const draw = () => {
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const val = fn(x / w, y / h, t);
        const on = val * 16 > BAYER[(y & 3) * 4 + (x & 3)] + 0.5;
        const i = (y * w + x) * 4;
        if (on) { img.data[i] = col[0]; img.data[i + 1] = col[1]; img.data[i + 2] = col[2]; img.data[i + 3] = alpha; }
        else if (bgc) { img.data[i] = bgc[0]; img.data[i + 1] = bgc[1]; img.data[i + 2] = bgc[2]; img.data[i + 3] = 255; }
      }
      ctx.putImageData(img, 0, 0);
    };
    draw();
    if (animate && !reduce) {
      const loop = (ts: number) => { if (ts - last > 120) { last = ts; t += 0.12; draw(); } raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);
    }
    return () => cancelAnimationFrame(raf);
  }, [w, h, shape, color, bg, alpha, animate, theme]);
  return <canvas ref={ref} width={w} height={h} className={className} aria-hidden="true" style={{ imageRendering: 'pixelated' }} />;
}
