import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { playbackTime } from '../library/playbackTime';
import { colors } from '../ui/theme';

export type PlaybackTrackProps = {
  label: string;
  position: number;
  duration: number;
  disabled: boolean;
  onSeek(seconds: number): void;
};

export function PlaybackTrack({ label, position, duration, disabled, onSeek }: PlaybackTrackProps) {
  const [width, setWidth] = useState(0);
  const progress = duration > 0 ? position / duration : 0;
  const seek = (seconds: number) => {
    if (!disabled) onSeek(Math.max(0, Math.min(seconds, duration)));
  };

  return <Pressable accessibilityRole="adjustable" accessibilityLabel={label}
    accessibilityState={{ disabled }}
    accessibilityValue={{ min: 0, max: duration, now: position, text: playbackTime(position) }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
    onAccessibilityAction={event => seek(position + (event.nativeEvent.actionName === 'increment' ? 5 : -5))}
    disabled={disabled} onLayout={event => setWidth(event.nativeEvent.layout.width)}
    onPress={event => { if (width) seek(event.nativeEvent.locationX / width * duration); }} style={styles.touch}>
    <View pointerEvents="none" style={styles.track}>
      <View style={[styles.fill, { width: width * progress }]} />
    </View>
  </Pressable>;
}

const styles = StyleSheet.create({
  touch: { minHeight: 32, justifyContent: 'center' },
  track: { height: 6, backgroundColor: colors.line, borderRadius: 4, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.ink, borderRadius: 4 },
});
