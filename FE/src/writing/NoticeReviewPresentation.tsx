import { StyleSheet } from 'react-native';
import { colors, radius, typeScale } from '../ui/theme';
import { workStyles } from '../ui/WorkFields';

export const reviewStyles = StyleSheet.create({
  section: { gap: 16 },
  heading: { gap: 8 },
  title: { ...workStyles.heading, flexShrink: 1 },
  meta: { ...workStyles.hint, fontVariant: ['tabular-nums'] },
  entries: { backgroundColor: colors.paper, borderColor: colors.line, borderWidth: 1, borderRadius: radius.panel },
  entryDivider: { borderTopColor: colors.line, borderTopWidth: 1 },
  entry: { padding: 16, gap: 12 },
  name: { ...workStyles.title, flexShrink: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusMarker: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: colors.muted },
  completeMarker: { backgroundColor: colors.greenInk, borderColor: colors.greenInk },
  annotation: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  annotationText: { ...typeScale.meta, color: colors.amberInk, flexShrink: 1 },
  secondaryActions: { ...workStyles.row, flexShrink: 1 },
});
