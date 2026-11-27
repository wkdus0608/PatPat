import type { ComponentProps } from 'react';
import { StyleSheet } from 'react-native';
import { WorkButton } from '../ui/WorkFields';

const paper = '#FEFDF9';
const line = '#E3DED4';
const ink = '#26221D';
const secondaryInk = '#61584D';
export const annotationInk = '#754C20';

export function ReviewButton({ secondary, ...props }: Omit<ComponentProps<typeof WorkButton>, 'style' | 'textStyle' | 'icon'>) {
  return <WorkButton {...props} secondary={secondary} textStyle={reviewStyles.buttonText}
    style={[reviewStyles.button, secondary && reviewStyles.secondaryButton]} />;
}

export const reviewStyles = StyleSheet.create({
  section: { gap: 16 },
  heading: { gap: 8 },
  title: { color: ink, fontSize: 26, lineHeight: 32, fontWeight: '500', flexShrink: 1 },
  meta: { color: secondaryInk, fontSize: 13, lineHeight: 20, fontVariant: ['tabular-nums'] },
  toolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  entries: { backgroundColor: paper, borderColor: line, borderWidth: 1, borderRadius: 16 },
  entryDivider: { borderTopColor: line, borderTopWidth: 1 },
  entry: { padding: 16, gap: 12 },
  name: { color: ink, fontSize: 18, lineHeight: 24, fontWeight: '600', flexShrink: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusMarker: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: secondaryInk },
  completeMarker: { backgroundColor: '#52715C', borderColor: '#52715C' },
  body: { color: ink, fontSize: 16, lineHeight: 26 },
  annotation: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
  annotationText: { color: annotationInk, fontSize: 13, lineHeight: 20, flexShrink: 1 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  secondaryActions: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, flexShrink: 1 },
  button: { borderRadius: 8, minHeight: 44, minWidth: 44, paddingHorizontal: 12, paddingVertical: 8 },
  secondaryButton: { backgroundColor: paper, borderColor: '#D9D1C3' },
  buttonText: { color: ink, fontSize: 14, fontWeight: '600' },
});
