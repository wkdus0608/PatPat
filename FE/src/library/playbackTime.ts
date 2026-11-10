export function playbackTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = String(Math.floor(safeSeconds / 60) % 60).padStart(2, '0');
  const remaining = String(safeSeconds % 60).padStart(2, '0');
  return hours > 0
    ? [String(hours).padStart(2, '0'), minutes, remaining].join(':')
    : [minutes, remaining].join(':');
}
