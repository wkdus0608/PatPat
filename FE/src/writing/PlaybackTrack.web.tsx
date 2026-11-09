import { playbackTime } from '../library/playbackTime';
import { colors } from '../ui/theme';
import type { PlaybackTrackProps } from './PlaybackTrack';

export function PlaybackTrack({ label, position, duration, disabled, onSeek }: PlaybackTrackProps) {
  return <input type="range" aria-label={label} aria-valuetext={playbackTime(position)}
    min={0} max={duration || 1} step={0.1} value={position} disabled={disabled}
    onChange={event => onSeek(event.currentTarget.valueAsNumber)}
    style={{ accentColor: colors.ink, width: '100%', height: 25, margin: 0 }} />;
}
