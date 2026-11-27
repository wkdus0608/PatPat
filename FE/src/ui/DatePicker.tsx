import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, layout, radius, typeScale } from './theme';
import { parseDateInput } from './dateInput';
import { WorkButton, WorkField, workStyles } from './WorkFields';

const weekdays = ['일', '월', '화', '수', '목', '금', '토'];
const iso = (date: Date) => date.toISOString().slice(0, 10);
const utc = (value: string) => new Date(value + 'T00:00:00Z');

export function todayDate() {
  const now = new Date();
  return iso(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}

export function shiftDate(value: string, days: number) {
  const date = utc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

function displayDate(value: string, compact?: boolean) {
  const date = utc(value);
  if (!Number.isFinite(date.getTime())) return value;
  return compact
    ? `${date.getUTCFullYear()}. ${date.getUTCMonth() + 1}. ${date.getUTCDate()}. (${weekdays[date.getUTCDay()]})`
    : iso(date).replaceAll('-', '.');
}

export function DateArrow({ name, label, disabled, onPress }: {
  name: 'chevron-back' | 'chevron-forward' | 'chevron-up' | 'chevron-down';
  label: string; disabled?: boolean; onPress(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.arrow, disabled && workStyles.disabled, pressed && workStyles.pressed]}>
    <Ionicons accessible={false} name={name} size={18} color={colors.ink} />
  </Pressable>;
}

export function DatePicker({ label, value, onChange, min, max, disabled, compact, years, availableDates }: {
  label: string; value: string | null; onChange(date: string | null): void; min?: string; max?: string;
  disabled?: boolean; compact?: boolean; years?: boolean;
  availableDates?: ReadonlySet<string>;
}) {
  const [month, setMonth] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState<string | null>(null);
  const today = todayDate();
  const shown = utc(month ?? today);
  const year = shown.getUTCFullYear();
  const index = shown.getUTCMonth();
  const first = new Date(Date.UTC(year, index, 1));
  const count = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  const leading = first.getUTCDay();
  const unavailable = (date: string) => (!!min && date < min) || (!!max && date > max)
    || (!!availableDates && !availableDates.has(date));
  function changeMonth(offset: number) {
    const next = iso(new Date(Date.UTC(year, index + offset, 1)));
    if (min && next.slice(0, 7) < min.slice(0, 7)) setMonth(min.slice(0, 7) + '-01');
    else if (max && next.slice(0, 7) > max.slice(0, 7)) setMonth(max.slice(0, 7) + '-01');
    else setMonth(next);
  }
  function applyTyped() {
    const parsed = parseDateInput(typed, { min, max });
    if (!parsed.ok) { setTypedError(parsed.error); return; }
    if (availableDates && !availableDates.has(parsed.date)) { setTypedError('선택할 수 없는 날짜예요.'); return; }
    choose(parsed.date);
  }
  function open() {
    setTyped('');
    setTypedError(null);
    const initial = value ?? today;
    const withinBounds = min && initial < min ? min : max && initial > max ? max : initial;
    setMonth(withinBounds.slice(0, 7) + '-01');
  }
  function choose(date: string | null) {
    onChange(date);
    setMonth(null);
  }

  return <View style={workStyles.field}>
    {!compact && <Text style={workStyles.label}>{label}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: value ? displayDate(value, compact) : '미선택' }}
      aria-expanded={month !== null} disabled={disabled} onPress={open}
      style={({ pressed }) => [styles.trigger, disabled && workStyles.disabled, pressed && workStyles.pressed]}>
      <Ionicons accessible={false} name="calendar-outline" size={16} color={colors.muted} />
      <Text style={[value ? workStyles.label : workStyles.hint, styles.triggerText]}>
        {value ? displayDate(value, compact) : '날짜 선택'}
      </Text>
    </Pressable>
    {month !== null && <Modal transparent animationType="fade" onRequestClose={() => setMonth(null)}>
      <View style={styles.overlay}>
        <Pressable accessible={false} focusable={false} importantForAccessibility="no"
          style={StyleSheet.absoluteFill} onPress={() => setMonth(null)} />
        <View accessibilityViewIsModal style={styles.calendar}>
          <View style={workStyles.between}>
            <DateArrow name="chevron-back" label="이전 달" onPress={() => changeMonth(-1)}
              disabled={!!min && month.slice(0, 7) <= min.slice(0, 7)} />
            <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={workStyles.title}>{year}년 {index + 1}월</Text>
            <DateArrow name="chevron-forward" label="다음 달" onPress={() => changeMonth(1)}
              disabled={!!max && month.slice(0, 7) >= max.slice(0, 7)} />
          </View>
          {years && <View style={styles.yearRow}>
            <WorkButton label="이전 해" secondary onPress={() => changeMonth(-12)} />
            <WorkButton label="다음 해" secondary onPress={() => changeMonth(12)}
              disabled={!!max && month.slice(0, 7) >= max.slice(0, 7)} />
          </View>}
          <View style={styles.grid}>
            {weekdays.map(day => <View key={day} style={[styles.cell, styles.weekday]}><Text style={workStyles.hint}>{day}</Text></View>)}
            {Array.from({ length: leading }, (_, i) => <View key={'blank' + i} style={styles.cell} />)}
            {Array.from({ length: count }, (_, i) => {
              const date = iso(new Date(Date.UTC(year, index, i + 1)));
              const disabledDay = unavailable(date);
              return <Pressable key={date} accessibilityRole="button" accessibilityLabel={date}
                accessibilityHint={date === today ? '오늘' : undefined}
                accessibilityState={{ selected: date === value, disabled: disabledDay }} disabled={disabledDay}
                onPress={() => choose(date)}
                style={({ pressed }) => [styles.cell, date === today && styles.today, date === value && styles.selected,
                  disabledDay && workStyles.disabled, pressed && workStyles.pressed]}>
                <Text style={styles.dayNumber}>{i + 1}</Text>
              </Pressable>;
            })}
          </View>
          {years && <>
            <WorkField label="날짜 직접 입력" value={typed} onChangeText={text => { setTyped(text); setTypedError(null); }}
              placeholder="2022-06-03" maxLength={12} onSubmitEditing={applyTyped} />
            {typedError && <Text accessibilityRole="alert" style={workStyles.hint}>{typedError}</Text>}
            <View style={styles.yearRow}><WorkButton label="입력한 날짜로 선택" secondary disabled={!typed.trim()} onPress={applyTyped} /></View>
          </>}
          <View style={styles.yearRow}>
            {compact && today !== value && !unavailable(today) && <WorkButton label="오늘" secondary onPress={() => choose(today)} />}
            {!compact && value !== null && <WorkButton label="선택 지우기" secondary onPress={() => choose(null)} />}
            <WorkButton label="닫기" secondary onPress={() => setMonth(null)} />
          </View>
        </View>
      </View>
    </Modal>}
  </View>;
}

const styles = StyleSheet.create({
  arrow: { minWidth: layout.touch, minHeight: layout.touch, borderRadius: radius.control, backgroundColor: colors.paper,
    borderWidth: 1, borderColor: colors.controlLine, alignItems: 'center', justifyContent: 'center' },
  trigger: { minHeight: layout.touch, borderWidth: 1, borderColor: colors.controlLine, borderRadius: radius.control,
    backgroundColor: colors.paper, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, gap: 8 },
  triggerText: { fontVariant: ['tabular-nums'], flexShrink: 1 },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.scrim, padding: 12 },
  calendar: { width: '100%', maxWidth: 360, borderRadius: radius.panel, backgroundColor: colors.paper, padding: 16, gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '14.2857%', minHeight: layout.touch, justifyContent: 'center', alignItems: 'center', borderRadius: radius.control },
  weekday: { minHeight: 32 },
  today: { borderWidth: 1, borderColor: colors.amberInk },
  selected: { backgroundColor: colors.yellow },
  dayNumber: { ...typeScale.label, color: colors.ink, fontVariant: ['tabular-nums'] },
  yearRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8 },
});
