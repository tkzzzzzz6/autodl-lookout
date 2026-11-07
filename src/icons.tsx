// 线条图标（24×24 网格，SF Symbols 风格），和 design/ 里的设计稿同源。
import type { CSSProperties } from "react";

const PATHS = {
  gpu: "<path d=\"M3 5.5v13\"/><rect x=\"5\" y=\"6.5\" width=\"16\" height=\"9.5\" rx=\"2\"/><circle cx=\"9.6\" cy=\"11.25\" r=\"2.9\"/><circle cx=\"16.4\" cy=\"11.25\" r=\"2.9\"/><circle cx=\"9.6\" cy=\"11.25\" r=\".7\" fill=\"C\"/><circle cx=\"16.4\" cy=\"11.25\" r=\".7\" fill=\"C\"/><path d=\"M8 16v2.2M10 16v2.2M12 16v2.2M14 16v2.2M16 16v2.2\"/>",
  gpu_s: "<rect x=\"2.5\" y=\"5.5\" width=\"19\" height=\"11.5\" rx=\"2.6\"/><circle cx=\"8.1\" cy=\"11.25\" r=\"3.4\"/><circle cx=\"15.9\" cy=\"11.25\" r=\"3.4\"/><path d=\"M8.5 17v2.6M12 17v2.6M15.5 17v2.6\"/>",
  chip: "<rect x=\"7\" y=\"7\" width=\"10\" height=\"10\" rx=\"2\"/><rect x=\"10\" y=\"10\" width=\"4\" height=\"4\" rx=\".8\" fill=\"C\"/><path d=\"M9.5 4v3M12 4v3M14.5 4v3M9.5 17v3M12 17v3M14.5 17v3M4 9.5h3M4 12h3M4 14.5h3M17 9.5h3M17 12h3M17 14.5h3\"/>",
  bell: "<path d=\"M12 4.2a5 5 0 0 0-5 5v3.3l-1.6 2.6h13.2L17 12.5V9.2a5 5 0 0 0-5-5z\"/><path d=\"M10.2 17.6a1.9 1.9 0 0 0 3.6 0\"/>",
  bell_fill: "<path d=\"M12 4.2a5 5 0 0 0-5 5v3.3l-1.6 2.6h13.2L17 12.5V9.2a5 5 0 0 0-5-5z\" fill=\"C\"/><path d=\"M10.2 17.6a1.9 1.9 0 0 0 3.6 0\"/>",
  server: "<rect x=\"4.5\" y=\"4.5\" width=\"15\" height=\"6.5\" rx=\"1.8\"/><rect x=\"4.5\" y=\"13\" width=\"15\" height=\"6.5\" rx=\"1.8\"/><circle cx=\"8\" cy=\"7.75\" r=\".9\" fill=\"C\"/><circle cx=\"8\" cy=\"16.25\" r=\".9\" fill=\"C\"/><path d=\"M11.5 7.75h5M11.5 16.25h5\"/>",
  pin: "<path d=\"M12 20.5s5.8-5.3 5.8-10.3a5.8 5.8 0 0 0-11.6 0c0 5 5.8 10.3 5.8 10.3z\"/><circle cx=\"12\" cy=\"10.2\" r=\"2.1\"/>",
  power: "<path d=\"M12 4v7.5\"/><path d=\"M7.6 7.2a6.6 6.6 0 1 0 8.8 0\"/>",
  plus_sq: "<rect x=\"4.5\" y=\"4.5\" width=\"15\" height=\"15\" rx=\"4\"/><path d=\"M12 8.5v7M8.5 12h7\"/>",
  plus: "<path d=\"M12 6v12M6 12h12\"/>",
  timer: "<circle cx=\"12\" cy=\"13.2\" r=\"6.6\"/><path d=\"M12 13.2V9.6M10 3.8h4M17.2 7.6l1.2-1.2\"/>",
  yen: "<path d=\"M7.5 5l4.5 6.5L16.5 5M12 11.5V19M8.5 12.5h7M8.5 15.5h7\"/>",
  cube: "<path d=\"M12 3.5l7.5 4.2v8.6L12 20.5l-7.5-4.2V7.7z\"/><path d=\"M12 12l7.5-4.3M12 12L4.5 7.7M12 12v8.5\"/>",
  number: "<path d=\"M10 4.5L8.3 19.5M15.7 4.5L14 19.5M5.5 9.5h13M5 14.5h13\"/>",
  calendar: "<rect x=\"4.5\" y=\"6\" width=\"15\" height=\"13.5\" rx=\"2.5\"/><path d=\"M4.5 10.5h15M8.5 4v4M15.5 4v4\"/>",
  text: "<path d=\"M6 6.5h12M12 6.5v12\"/>",
  refresh: "<path d=\"M18.5 12a6.5 6.5 0 1 1-2-4.7\"/><path d=\"M18.8 4.8v3.6h-3.6\"/>",
  list: "<path d=\"M9.5 7h10M9.5 12h10M9.5 17h10\"/><circle cx=\"5.5\" cy=\"7\" r=\"1\" fill=\"C\"/><circle cx=\"5.5\" cy=\"12\" r=\"1\" fill=\"C\"/><circle cx=\"5.5\" cy=\"17\" r=\"1\" fill=\"C\"/>",
  chev: "<path d=\"M9.5 6.5L15 12l-5.5 5.5\"/>",
  code: "<path d=\"M8.5 7L3.5 12l5 5M15.5 7l5 5-5 5\"/>",
  updown: "<path d=\"M8 9.5l4-4 4 4M8 14.5l4 4 4-4\"/>",
  wallet: "<rect x=\"4\" y=\"6.5\" width=\"16\" height=\"12\" rx=\"2.5\"/><path d=\"M4 9.5h16\"/><circle cx=\"16.3\" cy=\"14\" r=\"1\" fill=\"C\"/>",
  pulse: "<path d=\"M3.5 12h4l2-5 3.5 10 2-5h5.5\"/>",
  box: "<path d=\"M4.5 8l7.5-4 7.5 4v8l-7.5 4-7.5-4z\"/><path d=\"M4.5 8l7.5 4 7.5-4M12 12v8\"/>",
  doc: "<path d=\"M7 3.5h6.5l4 4V20.5H7z\"/><path d=\"M13.5 3.5v4h4M9.5 12h5M9.5 15.5h5\"/>",
  gear: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 3.8v2.4M12 17.8v2.4M3.8 12h2.4M17.8 12h2.4M6.2 6.2l1.7 1.7M16.1 16.1l1.7 1.7M6.2 17.8l1.7-1.7M16.1 7.9l1.7-1.7\"/>",
  x: "<path d=\"M7 7l10 10M17 7L7 17\"/>",
  trash: "<path d=\"M5 7h14M10 7V5h4v2M7 7l1 12.5h8L17 7\"/>",
  copy: "<rect x=\"8.5\" y=\"8.5\" width=\"11\" height=\"11\" rx=\"2.2\"/><path d=\"M15.5 8.5V6.2a1.7 1.7 0 0 0-1.7-1.7H6.2a1.7 1.7 0 0 0-1.7 1.7v7.6c0 .9.8 1.7 1.7 1.7h2.3\"/>",
  external: "<path d=\"M13.5 4.5h6v6M19.5 4.5L11 13\"/><path d=\"M17.5 13.5v4a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h4\"/>",
  terminal: "<rect x=\"3.5\" y=\"5\" width=\"17\" height=\"14\" rx=\"2.5\"/><path d=\"M7.5 10l2.5 2-2.5 2M12 15h4.5\"/>",
  key: "<circle cx=\"8.5\" cy=\"12\" r=\"3.8\"/><path d=\"M12.3 12h8M17.5 12v3M20.3 12v2.2\"/>",
  stop: "<rect x=\"6.5\" y=\"6.5\" width=\"11\" height=\"11\" rx=\"2.5\"/>",
  pause: "<path d=\"M9 6.5v11M15 6.5v11\"/>",
  play: "<path d=\"M8 5.8v12.4L18 12z\"/>",
  check: "<path d=\"M5.5 12.5l4 4 9-9\"/>",
  image: "<rect x=\"4\" y=\"5\" width=\"16\" height=\"14\" rx=\"2.5\"/><circle cx=\"9\" cy=\"10\" r=\"1.6\"/><path d=\"M4.5 17l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5\"/>",
  sparkle: "<path d=\"M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z\"/>",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, stroke = 1.7, className, style }: {
  name: IconName; size?: number; stroke?: number; className?: string; style?: CSSProperties;
}) {
  const html = (PATHS[name] as string).replace(/fill="C"/g, 'fill="currentColor" stroke="none"');
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={stroke}
      strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}
