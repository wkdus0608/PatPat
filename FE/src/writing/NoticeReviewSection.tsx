import { useCallback, useState, type ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { NoticeSummary } from '../api/v2';
import { WorkMessage, workStyles } from '../ui/WorkFields';
import { NoticeReview } from './NoticeReview';
import { NoticeReviewButton, noticeDesigns } from './NoticeReviewDesign';

type ReviewProps = Omit<ComponentProps<typeof NoticeReview>, 'summary'>;

export function NoticeReviewSection({ classroom, notices, design, busy, bulkText, onConfirmAll, onDirty, ...reviewProps }: ReviewProps & {
  classroom: string;
  notices: NoticeSummary[];
  busy: boolean;
  bulkText: string | null;
  onConfirmAll(): void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dirtyIds, setDirtyIds] = useState<ReadonlySet<string>>(() => new Set());
  const trackDirty = useCallback((id: string, dirty: boolean) => {
    onDirty(id, dirty);
    setDirtyIds(current => {
      if (current.has(id) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, [onDirty]);
  const theme = noticeDesigns[design];
  const focus = design === 'focus';
  const selected = notices.find(notice => notice.notice_id === selectedId) ?? notices[0];
  const confirmed = notices.filter(notice => notice.status === '완료').length;
  const reviewing = notices.filter(notice => notice.status === '검토중').length;

  return <View style={styles.section}>
    <View style={theme.sectionHeading}>
      <Text accessibilityRole="header" style={theme.sectionTitle}>아이별 알림장</Text>
      <View style={workStyles.between}>
        <Text style={styles.progress}>{classroom}{notices.length > 0 && ` · ${notices.length}명 중 ${confirmed}명 확정`}</Text>
        {reviewing > 1 && <NoticeReviewButton label={`전체 확정 (${reviewing}명)`} design={design}
          secondary busy={busy} disabled={busy} onPress={onConfirmAll} />}
      </View>
    </View>
    {bulkText && <WorkMessage>{bulkText}</WorkMessage>}
    {focus && notices.length > 1 && <View accessibilityRole="radiogroup" accessibilityLabel="검토할 아이">
      <ScrollView horizontal keyboardShouldPersistTaps="handled" contentContainerStyle={styles.childPicker}>
        {notices.map(notice => {
          const active = notice.notice_id === selected?.notice_id;
          const status = dirtyIds.has(notice.notice_id) ? '수정 중' : notice.status;
          return <Pressable key={notice.notice_id} accessibilityRole="radio" aria-checked={active}
            accessibilityState={{ checked: active }} accessibilityLabel={`${notice.child_name}, ${status}`}
            onPress={() => setSelectedId(notice.notice_id)} style={({ pressed }) => [
              styles.childChoice, active && styles.childChoiceActive, pressed && workStyles.pressed,
            ]}>
            <Text style={styles.childName}>{notice.child_name}</Text>
            <Text style={styles.childStatus}>{status}</Text>
          </Pressable>;
        })}
      </ScrollView>
    </View>}
    <View style={theme.records}>
      {notices.map(notice => {
        const hidden = focus && notice.notice_id !== selected?.notice_id;
        return <View key={notice.notice_id} style={hidden && styles.hidden}
          accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}>
          <NoticeReview {...reviewProps} summary={notice} design={design} onDirty={focus ? trackDirty : onDirty} />
        </View>;
      })}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  section: { gap: 10 },
  progress: { color: '#625447', fontSize: 13, lineHeight: 19, flexShrink: 1 },
  childPicker: { gap: 8, paddingBottom: 4, flexGrow: 1 },
  childChoice: { minWidth: 76, flexGrow: 1, minHeight: 48, paddingVertical: 7, paddingHorizontal: 9,
    justifyContent: 'center', backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#CDDACF', borderRadius: 8 },
  childChoiceActive: { backgroundColor: '#E5F0E7', borderColor: '#40805D' },
  childName: { color: '#244733', fontSize: 14, fontWeight: '700' },
  childStatus: { color: '#3F5F4D', fontSize: 12, lineHeight: 17 },
  hidden: { display: 'none' },
});
