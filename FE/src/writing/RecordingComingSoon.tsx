import { StyleSheet, Text, View } from 'react-native';
import { workStyles } from '../ui/WorkFields';
import { colors } from '../ui/theme';

export function RecordingComingSoon() {
  return (
    <View style={[workStyles.panel, workStyles.between, styles.recording]}>
      <Text style={workStyles.label}>녹음 선택</Text>
      <Text style={styles.badge}>개발 중</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  recording: { backgroundColor: colors.background },
  badge: { backgroundColor: colors.disabled, color: colors.muted, paddingHorizontal: 9, paddingVertical: 5,
    borderRadius: 10, fontSize: 12, fontWeight: '700' },
});
