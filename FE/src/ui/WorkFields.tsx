import { Ionicons } from '@expo/vector-icons';
import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import { errorMessage } from '../api/client';
import { colors, layout, radius, typeScale } from './theme';

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

export function WorkButton({ label, onPress, disabled, secondary, busy, icon, destructive }: {
  label: string; onPress(): void; disabled?: boolean; secondary?: boolean; busy?: boolean; destructive?: boolean;
  icon?: ComponentProps<typeof Ionicons>['name'];
}) {
  const foreground = destructive ? colors.white : colors.ink;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }} onPress={onPress} disabled={disabled || busy}
      style={({ pressed }) => [workStyles.button, icon && workStyles.iconButton, secondary && workStyles.secondary,
        destructive && workStyles.destructive,
        (disabled || busy) && workStyles.disabled, pressed && workStyles.pressed]}>
      {icon ? <Ionicons name={icon} size={18} color={foreground} accessible={false} style={busy && workStyles.busyContent} />
        : <Text style={[workStyles.buttonText, destructive && workStyles.destructiveText, busy && workStyles.busyContent]}>{label}</Text>}
      {busy && <View pointerEvents="none" style={[StyleSheet.absoluteFill, workStyles.spinner]}>
        <ActivityIndicator color={foreground} />
      </View>}
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
      style={({ pressed }) => [workStyles.choice, selected && workStyles.choiceSelected,
        disabled && workStyles.disabled, pressed && workStyles.pressed]}>
      {checkbox && <Ionicons accessible={false} name={selected ? 'checkbox-outline' : 'square-outline'}
        size={16} color={selected ? colors.amberInk : colors.muted} />}
      <Text style={[workStyles.choiceText, selected && workStyles.choiceTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function WorkField({ label, inputAccessory, ...props }: TextInputProps & { label: string; inputAccessory?: ReactNode }) {
  const input = <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted}
    {...props} style={[workStyles.input, props.multiline && workStyles.multiline, props.style]} />;
  return (
    <View style={workStyles.field}>
      <Text style={workStyles.label}>{label}</Text>
      {inputAccessory ? <View>{input}{inputAccessory}</View> : input}
    </View>
  );
}

export function WorkMessage({ children, error }: { children: ReactNode; error?: boolean }) {
  return <Text accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite"
    style={error ? workStyles.error : workStyles.hint}>{children}</Text>;
}

export const workStyles = StyleSheet.create({
  content: { paddingHorizontal: layout.gutter, paddingTop: 12, paddingBottom: 24, gap: 16 },
  panel: { backgroundColor: colors.paper, padding: 16, borderWidth: 1, borderColor: colors.line, borderRadius: radius.panel, gap: 12 },
  raised: { zIndex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  heading: { ...typeScale.heading, color: colors.ink },
  title: { ...typeScale.section, color: colors.ink },
  label: { ...typeScale.label, color: colors.ink },
  body: { ...typeScale.body, color: colors.ink },
  hint: { ...typeScale.meta, color: colors.muted },
  error: { ...typeScale.meta, color: colors.rose },
  field: { gap: 4 },
  input: { ...typeScale.body, minHeight: layout.touch, paddingHorizontal: 12, paddingVertical: 8,
    borderWidth: 1, borderColor: colors.controlLine, borderRadius: radius.control, backgroundColor: colors.paper, color: colors.ink },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  button: { minHeight: layout.touch, minWidth: layout.touch, backgroundColor: colors.yellow, paddingHorizontal: 12,
    paddingVertical: 8, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' },
  iconButton: { width: layout.touch, paddingHorizontal: 0, paddingVertical: 0 },
  buttonText: { ...typeScale.label, color: colors.ink, textAlign: 'center' },
  secondary: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.controlLine },
  destructive: { backgroundColor: colors.rose, borderColor: colors.rose },
  destructiveText: { color: colors.white },
  busyContent: { opacity: 0 },
  spinner: { alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.78 },
  choice: { minHeight: layout.touch, paddingHorizontal: 12, paddingVertical: 8, borderRadius: radius.control,
    backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.controlLine, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: '100%' },
  choiceSelected: { backgroundColor: colors.yellowLight, borderColor: colors.amberInk },
  choiceText: { ...typeScale.meta, color: colors.ink, flexShrink: 1 },
  choiceTextSelected: { fontWeight: '600' },
});
