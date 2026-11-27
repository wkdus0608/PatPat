import { useEffect, useState, type ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Block } from '../api/v2';
import { DatePicker, shiftDate } from '../ui/DatePicker';
import { parseDateInput } from '../ui/dateInput';
import { WorkField } from '../ui/WorkFields';

const designs = {
  week: { label: '한 주', ground: '#eef3ef', sheet: '#fcfdfb', ink: '#17372d', quiet: '#486357', line: '#c6d6ce', accent: '#205a45', selected: '#dcece2', radius: 12 },
  month: { label: '월간 달력', ground: '#f7f1e5', sheet: '#fffcf5', ink: '#392b1c', quiet: '#675640', line: '#dbccae', accent: '#78501e', selected: '#f2dfb7', radius: 4 },
  focus: { label: '한 명씩', ground: '#eeedf5', sheet: '#fdfbff', ink: '#322645', quiet: '#615774', line: '#d5cde2', accent: '#5b3d7e', selected: '#e9dff5', radius: 16 },
} as const;

export type NoticeDesign = keyof typeof designs;
export type NoticePalette = (typeof designs)[NoticeDesign];
export const noticePalette = (design: NoticeDesign) => designs[design];
export const noticeWidth = 1056;
const keys = Object.keys(designs) as NoticeDesign[];
const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const dayOfWeek = (value: string) => new Date(value + 'T00:00:00Z').getUTCDay();
const dateParts = (value: string) => value.split('-').map(Number);
const formatDay = (value: string) => {
  const [, month, date] = dateParts(value);
  return month + '월 ' + date + '일 ' + weekdays[dayOfWeek(value)] + '요일';
};
const monthStart = (value: string, offset = 0) => {
  const [year, month] = dateParts(value);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
};

export function NoticeControl({ palette, label, icon, onlyIcon, primary, selected, disabled, onPress }: {
  palette: NoticePalette; label: string; icon?: ComponentProps<typeof Ionicons>['name'];
  onlyIcon?: boolean; primary?: boolean; selected?: boolean; disabled?: boolean; onPress(): void;
}) {
  const color = primary ? '#fff' : palette.accent;
  const glyph = icon ? <Ionicons name={icon} size={19} color={color} accessible={false} /> : null;
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.control, onlyIcon && s.iconButton, {
      backgroundColor: primary ? palette.accent : selected || pressed ? palette.selected : palette.sheet,
      borderColor: primary || selected ? palette.accent : palette.line, borderRadius: palette.radius,
      opacity: disabled ? 0.5 : pressed && primary ? 0.84 : 1,
    }]}>
    {icon !== 'chevron-forward' && glyph}
    {!onlyIcon && <Text style={[s.buttonText, { color }]}>{label}</Text>}
    {icon === 'chevron-forward' && glyph}
  </Pressable>;
}

export function NoticeDesigns({ design, onChange }: { design: NoticeDesign; onChange(value: NoticeDesign): void }) {
  const palette = designs[design];
  return <View accessibilityLabel="작성 화면 시안" style={s.wrap}>
    {keys.map(key => <NoticeControl key={key} palette={palette} label={designs[key].label}
      selected={design === key} onPress={() => onChange(key)} />)}
  </View>;
}

export function NoticeDates({ design, day, today, disabled, wide, onChange }: {
  design: NoticeDesign; day: string; today: string; disabled: boolean; wide: boolean; onChange(value: string): void;
}) {
  const palette = designs[design];
  const start = shiftDate(day, -((dayOfWeek(day) + 6) % 7));
  const previous = shiftDate(day, -1);
  const next = shiftDate(day, 1);
  if (design === 'month') return <NoticeMonth palette={palette}
    day={day} today={today} disabled={disabled} wide={wide} onChange={onChange} />;

  return <View style={[s.datePanel, { backgroundColor: palette.sheet, borderColor: palette.line, borderRadius: palette.radius }]}>
    <View style={s.between}>
      <View>
        <Text style={[s.caption, { color: palette.quiet }]}>{day === today ? '오늘' : dateParts(day)[0] + '년'}</Text>
        <Text accessibilityRole="header" style={[s.dateTitle, { color: palette.ink }]}>{formatDay(day)}</Text>
      </View>
      <View style={s.wrap}>
        {day !== today && <NoticeControl palette={palette} label="오늘" disabled={disabled} onPress={() => onChange(today)} />}
        <DatePicker label="날짜 선택" iconOnly value={day}
          onChange={value => value && onChange(value)} disabled={disabled} compact directInput />
      </View>
    </View>
    {design === 'week' ? <View style={s.calendarRow}>
      {Array.from({ length: 7 }, (_, index) => {
        const key = shiftDate(start, index);
        const selected = key === day;
        return <Pressable key={key} accessibilityRole="button" accessibilityLabel={formatDay(key)}
          accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => onChange(key)}
          style={({ pressed }) => [s.weekDay, { backgroundColor: selected ? palette.accent : pressed ? palette.selected : palette.sheet,
            borderRadius: palette.radius, opacity: disabled ? 0.5 : 1 }]}>
          <Text style={[s.caption, { color: selected ? '#fff' : palette.quiet }]}>{weekdays[dayOfWeek(key)]}</Text>
          <Text style={[s.weekNumber, { color: selected ? '#fff' : palette.ink }]}>{dateParts(key)[2]}</Text>
        </Pressable>;
      })}
    </View> : <View style={s.between}>
      <NoticeControl palette={palette} label={'전날 · ' + dateParts(previous)[2] + '일'} icon="chevron-back" disabled={disabled} onPress={() => onChange(previous)} />
      <NoticeControl palette={palette} label={'다음 날 · ' + dateParts(next)[2] + '일'} icon="chevron-forward" disabled={disabled} onPress={() => onChange(next)} />
    </View>}
  </View>;
}

function NoticeMonth({ palette, day, today, disabled, wide, onChange }: {
  palette: NoticePalette; day: string; today: string; disabled: boolean; wide: boolean; onChange(value: string): void;
}) {
  const [month, setMonth] = useState(() => monthStart(day));
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [direct, setDirect] = useState(false);
  const [opened, setOpened] = useState(true);
  useEffect(() => { setMonth(monthStart(day)); }, [day]);
  const [year, number] = dateParts(month);
  const leading = (dayOfWeek(month) + 6) % 7;
  const count = new Date(Date.UTC(year, number, 0)).getUTCDate();
  function choose(key: string) {
    if (!wide) setOpened(false);
    if (key === day) setMonth(monthStart(key));
    else onChange(key);
  }
  function apply() {
    const parsed = parseDateInput(typed);
    if (!parsed.ok) { setError(parsed.error); return; }
    choose(parsed.date);
    setTyped('');
    setError('');
    setDirect(false);
  }

  const panel = [s.datePanel, { backgroundColor: palette.sheet, borderColor: palette.line, borderRadius: palette.radius }];
  if (!wide && !opened) return <View style={[...panel, s.between]}>
    <Text accessibilityRole="header" style={[s.dateTitle, { color: palette.ink }]}>{formatDay(day)}</Text>
    <NoticeControl palette={palette} label="달력 펼치기" icon="calendar-outline" onlyIcon disabled={disabled}
      onPress={() => { setMonth(monthStart(day)); setOpened(true); }} />
  </View>;

  return <View style={panel}>
    <View style={s.between}>
      <NoticeControl palette={palette} label="이전 달" icon="chevron-back" onlyIcon disabled={disabled} onPress={() => setMonth(monthStart(month, -1))} />
      <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={[s.dateTitle, { color: palette.ink }]}>{year}년 {number}월</Text>
      <NoticeControl palette={palette} label="다음 달" icon="chevron-forward" onlyIcon disabled={disabled} onPress={() => setMonth(monthStart(month, 1))} />
    </View>
    <View style={s.monthGrid}>
      {[...weekdays.slice(1), weekdays[0]].map(name =>
        <Text key={name} style={[s.cell, s.weekLabel, { color: palette.quiet }]}>{name}</Text>)}
      {Array.from({ length: leading }, (_, index) => <View key={'empty-' + index} style={s.cell} />)}
      {Array.from({ length: count }, (_, index) => {
        const key = shiftDate(month, index);
        const selected = key === day;
        return <Pressable key={key} accessibilityRole="button" accessibilityLabel={formatDay(key) + (key === today ? ', 오늘' : '')}
          accessibilityState={{ selected, disabled }} disabled={disabled} onPress={() => choose(key)}
          style={({ pressed }) => [s.cell, s.monthDay, { borderRadius: palette.radius,
            backgroundColor: selected ? palette.accent : pressed || key === today ? palette.selected : palette.sheet }]}>
          <Text style={[s.dayNumber, { color: selected ? '#fff' : palette.ink }]}>{index + 1}</Text>
        </Pressable>;
      })}
    </View>
    <View style={s.between}>
      <NoticeControl palette={palette} label="오늘" disabled={disabled} onPress={() => choose(today)} />
      <NoticeControl palette={palette} label="날짜 입력" icon="keypad-outline" selected={direct}
        disabled={disabled} onPress={() => { setDirect(value => !value); setError(''); }} />
    </View>
    {direct && <View style={s.direct}>
      <WorkField label="날짜 직접 입력" placeholder="2026-11-27" value={typed} maxLength={12} editable={!disabled}
        onChangeText={value => { setTyped(value); setError(''); }} onSubmitEditing={apply} />
      {error ? <Text accessibilityRole="alert" style={s.error}>{error}</Text> : null}
      <NoticeControl palette={palette} label="날짜로 이동" disabled={disabled || !typed.trim()} onPress={apply} />
    </View>}
  </View>;
}

export function NoticeSubjects({ design, blocks, selected, disabled, onSelect }: {
  design: NoticeDesign; blocks: Block[]; selected: Block; disabled: boolean; onSelect(id: string): void;
}) {
  const palette = designs[design];
  const present = blocks.filter(block => !block.is_common && !block.absent);
  const written = present.filter(block => block.text.trim()).length;
  return <View style={[s.subjects, { borderColor: palette.line }]}>
    <View style={s.between}>
      <Text accessibilityRole="header" style={[s.sectionTitle, { color: palette.ink }]}>
        {design === 'focus' ? '누구의 메모를 쓸까요?' : '관찰 메모'}
      </Text>
      {present.length > 0 && <Text style={[s.caption, { color: palette.quiet }]}>{written}/{present.length}명 작성</Text>}
    </View>
    <View style={[s.wrap, design === 'focus' && s.focusSubjects]} accessibilityLabel="메모 대상">
      {blocks.map(block => {
        const name = block.is_common ? '반 전체' : block.child_name ?? '아동';
        const status = block.is_common ? '' : block.absent ? '결석' : block.text.trim() ? '작성' : '미작성';
        const active = selected.block_id === block.block_id;
        return <Pressable key={block.block_id} accessibilityRole="button" accessibilityLabel={status ? name + ', ' + status : name}
          accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={() => onSelect(block.block_id)}
          style={({ pressed }) => [s.subject, design === 'focus' && s.focusSubject, {
            borderRadius: palette.radius, borderColor: active ? palette.accent : palette.line,
            backgroundColor: active || pressed ? palette.selected : palette.sheet,
          }]}>
          <Text style={[s.buttonText, { color: palette.ink }]}>{name}</Text>
          {status && <Text style={[s.caption, { color: palette.quiet }]}>{status}</Text>}
        </Pressable>;
      })}
    </View>
  </View>;
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  control: { flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 11, paddingVertical: 8, minHeight: 44, borderWidth: 1, maxWidth: '100%' },
  iconButton: { width: 44, paddingHorizontal: 0 },
  buttonText: { fontSize: 15, fontWeight: '700', flexShrink: 1 },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: '600' },
  datePanel: { gap: 14, borderWidth: 1, padding: 12 },
  dateTitle: { fontSize: 22, fontWeight: '800', letterSpacing: -0.7 },
  calendarRow: { flexDirection: 'row', alignItems: 'stretch' },
  weekDay: { flex: 1, minHeight: 55, paddingVertical: 6, alignItems: 'center', justifyContent: 'center', gap: 2 },
  weekNumber: { fontSize: 19, fontWeight: '800', fontVariant: ['tabular-nums'] },
  monthGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { flexBasis: '14.285%', maxWidth: '14.285%' },
  weekLabel: { textAlign: 'center', fontSize: 14, fontWeight: '700', paddingVertical: 6 },
  monthDay: { alignItems: 'center', justifyContent: 'center', minHeight: 44, paddingVertical: 4 },
  dayNumber: { fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  direct: { gap: 8 },
  error: { color: '#902f35', fontSize: 14 },
  subjects: { gap: 10, paddingBottom: 13, borderBottomWidth: 1 },
  sectionTitle: { fontSize: 21, fontWeight: '800', letterSpacing: -0.4, flexShrink: 1 },
  focusSubjects: { alignItems: 'stretch', gap: 8 },
  focusSubject: { flexGrow: 1, flexBasis: '40%', minWidth: 0, alignItems: 'center', minHeight: 55 },
  subject: { minHeight: 46, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5, justifyContent: 'center', gap: 1, maxWidth: '100%' },
});
