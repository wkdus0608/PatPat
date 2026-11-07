import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from './theme';
import { WorkButton, workStyles } from './WorkFields';

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

export function DateArrow({ name, label, disabled, onPress }: {
  name: 'chevron-back' | 'chevron-forward' | 'chevron-up' | 'chevron-down';
  label: string; disabled?: boolean; onPress(): void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled}
    onPress={onPress} style={[styles.arrow, disabled && workStyles.disabled]}>
    <Ionicons accessible={false} name={name} size={20} color={colors.ink} />
  </Pressable>;
}

export function DatePicker({ label, value, onChange, min, max, disabled, compact, years }: {
  label: string; value: string | null; onChange(date: string | null): void; min?: string; max?: string;
  disabled?: boolean; compact?: boolean; years?: boolean;
}) {
  const [month, setMonth] = useState<string | null>(null);
  const shown = utc(month ?? todayDate());
  const year = shown.getUTCFullYear();
  const index = shown.getUTCMonth();
  const first = new Date(Date.UTC(year, index, 1));
  const count = new Date(Date.UTC(year, index + 1, 0)).getUTCDate();
  const leading = first.getUTCDay();
  function changeMonth(offset: number) {
    const next = iso(new Date(Date.UTC(year, index + offset, 1)));
    if (min && next.slice(0, 7) < min.slice(0, 7)) setMonth(min.slice(0, 7) + '-01');
    else if (max && next.slice(0, 7) > max.slice(0, 7)) setMonth(max.slice(0, 7) + '-01');
    else setMonth(next);
  }
  function open() {
    const initial = value ?? todayDate();
    const withinBounds = min && initial < min ? min : max && initial > max ? max : initial;
    setMonth(withinBounds.slice(0, 7) + '-01');
  }
  function choose(date: string | null) {
    onChange(date);
    setMonth(null);
  }

  return <View style={workStyles.field}>
    {!compact && <Text style={workStyles.label}>{label}</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: value ?? '미선택' }}
      aria-expanded={month !== null} disabled={disabled} onPress={open}
      style={[styles.trigger, disabled && workStyles.disabled]}>
      <Ionicons accessible={false} name="calendar-outline" size={17} color={colors.muted} />
      <Text style={value ? workStyles.body : workStyles.hint}>{value ?? '날짜 선택'}</Text>
    </Pressable>
    {month !== null && <Modal transparent animationType="fade" onRequestClose={() => setMonth(null)}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="달력 닫기" style={StyleSheet.absoluteFill} onPress={() => setMonth(null)} />
        <View accessibilityViewIsModal style={styles.calendar}>
          <View style={workStyles.between}>
            <DateArrow name="chevron-back" label="이전 달" onPress={() => changeMonth(-1)}
              disabled={!!min && month.slice(0, 7) <= min.slice(0, 7)} />
            <Text style={workStyles.title}>{year}년 {index + 1}월</Text>
            <DateArrow name="chevron-forward" label="다음 달" onPress={() => changeMonth(1)}
              disabled={!!max && month.slice(0, 7) >= max.slice(0, 7)} />
          </View>
          {years && <View style={styles.yearRow}>
            <WorkButton label="이전 해" secondary onPress={() => changeMonth(-12)} />
            <WorkButton label="다음 해" secondary onPress={() => changeMonth(12)}
              disabled={!!max && month.slice(0, 7) >= max.slice(0, 7)} />
          </View>}
          <View style={styles.grid}>
            {weekdays.map(day => <View key={day} style={styles.cell}><Text style={workStyles.hint}>{day}</Text></View>)}
            {Array.from({ length: leading }, (_, i) => <View key={'blank' + i} style={styles.cell} />)}
            {Array.from({ length: count }, (_, i) => {
              const date = iso(new Date(Date.UTC(year, index, i + 1)));
              const unavailable = (!!min && date < min) || (!!max && date > max);
              return <Pressable key={date} accessibilityRole="button" accessibilityLabel={date}
                accessibilityState={{ selected: date === value, disabled: unavailable }} disabled={unavailable}
                onPress={() => choose(date)}
                style={[styles.cell, date === value && styles.selected, unavailable && workStyles.disabled]}>
                <Text style={workStyles.label}>{i + 1}</Text>
              </Pressable>;
            })}
          </View>
          <View style={styles.yearRow}>
            {!compact && value !== null && <WorkButton label="선택 지우기" secondary onPress={() => choose(null)} />}
            <WorkButton label="닫기" secondary onPress={() => setMonth(null)} />
          </View>
        </View>
      </View>
    </Modal>}
  </View>;
}

const styles = StyleSheet.create({
  arrow: { minWidth: 44, minHeight: 44, borderRadius: 11, backgroundColor: colors.white,
    borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  trigger: { minHeight: 44, borderWidth: 1, borderColor: colors.line, borderRadius: 11,
    backgroundColor: colors.white, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 11, gap: 8 },
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#49372C66', padding: 16 },
  calendar: { width: '100%', maxWidth: 346, borderRadius: 18, backgroundColor: colors.white, padding: 12, gap: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: { width: '14.2857%', minHeight: 40, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  selected: { backgroundColor: colors.green },
  yearRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: 7 },
});
