import { useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { errorMessage } from '../api/client';
import { colors } from './theme';

export function useWorkAction() {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function WorkButton({ label, onPress, disabled, secondary, busy }: {
  label: string; onPress(): void; disabled?: boolean; secondary?: boolean; busy?: boolean;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }} onPress={onPress} disabled={disabled || busy}
      style={({ pressed }) => [workStyles.button, secondary && workStyles.secondary,
        (disabled || busy) && workStyles.disabled, pressed && workStyles.pressed]}>
      {busy ? <ActivityIndicator color={colors.ink} /> : <Text style={workStyles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

export function WorkChoice({ label, selected, onPress, disabled, checkbox }: {
  label: string; selected: boolean; onPress(): void; disabled?: boolean; checkbox?: boolean;
}) {
  return (
    <Pressable accessibilityRole={checkbox ? 'checkbox' : 'radio'} accessibilityLabel={label} aria-checked={selected}
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled} onPress={onPress}
      style={[workStyles.choice, selected && workStyles.choiceSelected, disabled && workStyles.disabled]}>
      <Text style={[workStyles.choiceText, selected && workStyles.choiceTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function WorkField({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={workStyles.field}>
      <Text style={workStyles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted}
        {...props} style={[workStyles.input, props.multiline && workStyles.multiline, props.style]} />
    </View>
  );
}

export function WorkMessage({ children, error }: { children: ReactNode; error?: boolean }) {
  return <Text accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite"
    style={error ? workStyles.error : workStyles.hint}>{children}</Text>;
}

export const workStyles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 26, gap: 14 },
  panel: { backgroundColor: colors.white, padding: 16, borderWidth: 1, borderColor: colors.line, borderRadius: 18, gap: 11 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  heading: { color: colors.ink, fontSize: 22, fontWeight: '800' },
  title: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  label: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 22 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.rose, fontSize: 14, lineHeight: 21 },
  field: { gap: 5 },
  input: { minHeight: 44, paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: colors.line,
    borderRadius: 11, backgroundColor: colors.background, color: colors.ink, fontSize: 16 },
  multiline: { minHeight: 86, textAlignVertical: 'top' },
  button: { minHeight: 44, backgroundColor: colors.yellow, paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.ink, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  secondary: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.78 },
  choice: { minHeight: 36, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 11,
    backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, justifyContent: 'center' },
  choiceSelected: { backgroundColor: colors.green, borderColor: colors.greenInk },
  choiceText: { color: colors.ink, fontSize: 13 },
  choiceTextSelected: { color: colors.greenInk, fontWeight: '700' },
});
