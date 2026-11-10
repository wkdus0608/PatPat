import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import type { V2Api } from '../api/v2';
import { WorkButton, WorkMessage, useWorkAction, workStyles } from '../ui/WorkFields';
import { pickWordTemplate } from '../writing/wordFiles';

export function JournalTemplateField({ api, disabled, onBusy }: {
  api: V2Api; disabled: boolean; onBusy(busy: boolean): void;
}) {
  const [filename, setFilename] = useState<string | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const action = useWorkAction();
  useEffect(() => {
    let current = true;
    void api.journalTemplate().then(value => { if (current) setFilename(value.filename); })
      .catch(() => { if (current) action.setError('Word 양식을 불러오지 못했어요.'); });
    return () => { current = false; };
  }, [api, attempt]);
  useEffect(() => { onBusy(action.busy); return () => onBusy(false); }, [action.busy, onBusy]);

  return <View style={workStyles.field}>
    <Text style={workStyles.title}>Word 양식</Text>
    <WorkMessage>.docx, .doc, .dotx, .rtf, .odt 등 Word 호환 파일을 올릴 수 있어요.</WorkMessage>
    <WorkMessage>{filename ?? (filename === null ? '업로드된 Word 양식이 없어요.' : 'Word 양식을 불러오는 중이에요.')}</WorkMessage>
    <View style={workStyles.row}>
      <WorkButton label={filename ? 'Word 양식 교체' : 'Word 양식 업로드'} busy={action.busy}
        disabled={disabled || filename === undefined} onPress={() => { void action.run(async () => {
          const file = await pickWordTemplate();
          if (file) setFilename((await api.uploadJournalTemplate(file)).filename);
        }); }} />
      {!!filename && <WorkButton label="Word 양식 제거" secondary disabled={disabled || action.busy}
        onPress={() => { void action.run(async () => { await api.deleteJournalTemplate(); setFilename(null); }); }} />}
      {filename === undefined && !!action.error && <WorkButton label="다시 불러오기" secondary disabled={disabled}
        onPress={() => { action.setError(null); setAttempt(value => value + 1); }} />}
    </View>
    {action.error && <WorkMessage error>{action.error}</WorkMessage>}
  </View>;
}
