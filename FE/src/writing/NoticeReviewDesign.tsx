import type { ComponentProps } from 'react';
import { StyleSheet, type TextStyle, type ViewStyle } from 'react-native';
import { WorkButton } from '../ui/WorkFields';
import { colors } from '../ui/theme';

export type NoticeReviewDesign = 'cards' | 'list' | 'focus';

type DesignStyles = {
  sectionHeading: ViewStyle;
  sectionTitle: TextStyle;
  records: ViewStyle;
  record: ViewStyle;
  confirmedRecord: ViewStyle;
  name: TextStyle;
  body: TextStyle;
  actions: ViewStyle;
  primary: ViewStyle;
  primaryText: TextStyle & { color: string };
  secondary: ViewStyle;
  secondaryText: TextStyle & { color: string };
};

export const noticeDesigns: Record<NoticeReviewDesign, DesignStyles> = {
  cards: StyleSheet.create({
    sectionHeading: { gap: 8, paddingBottom: 4 },
    sectionTitle: { fontSize: 24, fontWeight: '800', color: '#49372C', letterSpacing: -0.5 },
    records: { gap: 12 },
    record: { backgroundColor: '#FFF8EA', borderColor: '#E8D8BD', borderWidth: 1, borderRadius: 16, padding: 16, gap: 12 },
    confirmedRecord: { backgroundColor: '#F3F5ED', borderColor: '#D6DDCB' },
    name: { color: '#4A3025', fontSize: 19, fontWeight: '800' },
    body: { color: '#503C31', fontSize: 16, lineHeight: 26 },
    actions: { justifyContent: 'space-between', marginTop: 2 },
    primary: { backgroundColor: '#7C442D' },
    primaryText: { color: '#FFFFFF' },
    secondary: { backgroundColor: '#FFFCF5', borderColor: '#DCCAB2' },
    secondaryText: { color: '#654636' },
  }),
  list: StyleSheet.create({
    sectionHeading: { gap: 8, paddingBottom: 4 },
    sectionTitle: { fontSize: 23, fontWeight: '800', color: '#302E27', letterSpacing: -0.45 },
    records: { borderTopColor: '#BFB5A5', borderTopWidth: 1 },
    record: { borderBottomColor: '#DCD4C5', borderBottomWidth: 1, paddingVertical: 12, gap: 8 },
    confirmedRecord: {},
    name: { color: '#332D25', fontSize: 17, fontWeight: '800' },
    body: { color: '#433A31', fontSize: 15, lineHeight: 23 },
    actions: { justifyContent: 'flex-end' },
    primary: { backgroundColor: colors.yellow, borderRadius: 8 },
    primaryText: { color: '#4F351C' },
    secondary: { backgroundColor: 'transparent', borderColor: 'transparent', borderRadius: 8, paddingHorizontal: 8 },
    secondaryText: { color: '#5F4936' },
  }),
  focus: StyleSheet.create({
    sectionHeading: { gap: 8, padding: 14, backgroundColor: '#EAF1E7', borderRadius: 14 },
    sectionTitle: { fontSize: 23, fontWeight: '800', color: '#254634', letterSpacing: -0.45 },
    records: { gap: 10 },
    record: { backgroundColor: '#FFFFFF', borderColor: '#CCD7C9', borderWidth: 1, borderRadius: 14, padding: 16, gap: 14 },
    confirmedRecord: { backgroundColor: '#F4F7F1' },
    name: { color: '#234634', fontSize: 21, fontWeight: '800' },
    body: { color: '#303C33', fontSize: 16, lineHeight: 27 },
    actions: { justifyContent: 'space-between', borderTopColor: '#DDE5DA', borderTopWidth: 1, paddingTop: 10 },
    primary: { backgroundColor: '#2D5C46', borderRadius: 8 },
    primaryText: { color: '#FFFFFF' },
    secondary: { backgroundColor: '#F4F7F1', borderColor: '#CEDBCF', borderRadius: 8 },
    secondaryText: { color: '#2D503E' },
  }),
};

export function NoticeReviewButton({ design, secondary, ...props }: Omit<ComponentProps<typeof WorkButton>, 'style' | 'textStyle' | 'indicatorColor'> & {
  design: NoticeReviewDesign;
}) {
  const theme = noticeDesigns[design];
  const textStyle = secondary ? theme.secondaryText : theme.primaryText;
  return <WorkButton {...props} secondary={secondary}
    style={[styles.button, secondary ? theme.secondary : theme.primary]}
    textStyle={textStyle} indicatorColor={textStyle.color} />;
}

const styles = StyleSheet.create({ button: { minHeight: 48, minWidth: 48 } });
