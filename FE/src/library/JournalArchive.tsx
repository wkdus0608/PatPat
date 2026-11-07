import { useMemo, useRef, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { JournalArchiveEntry } from '../api/v2';
import { DateArrow } from '../ui/DatePicker';
import { WorkMessage, workStyles } from '../ui/WorkFields';

type Page = { date: string; records: JournalArchiveEntry[] };

export function JournalArchive({ records }: { records: JournalArchiveEntry[] }) {
  const pages = useMemo(() => {
    const groups = new Map<string, JournalArchiveEntry[]>();
    for (const record of records) {
      const group = groups.get(record.observed_date);
      if (group) group.push(record);
      else groups.set(record.observed_date, [record]);
    }
    return Array.from(groups, ([date, items]) => ({ date, records: items }));
  }, [records]);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState(pages.length - 1);
  const list = useRef<FlatList<Page>>(null);
  const move = (next: number) => list.current?.scrollToOffset({ offset: next * width, animated: true });

  return <View style={styles.fill}>
    <View style={styles.dateRow}>
      <DateArrow name="chevron-back" label="이전 관찰일지 날짜" disabled={!width || index === 0}
        onPress={() => move(index - 1)} />
      <View style={styles.dateLabel} accessibilityLiveRegion="polite">
        <Text style={workStyles.title}>{pages[index].date}</Text>
        <Text style={workStyles.hint}>{index + 1} / {pages.length}</Text>
      </View>
      <DateArrow name="chevron-forward" label="다음 관찰일지 날짜" disabled={!width || index === pages.length - 1}
        onPress={() => move(index + 1)} />
    </View>
    <View style={styles.fill} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
      {width > 0 && <FlatList key={width} ref={list} style={styles.fill} data={pages}
        keyExtractor={page => page.date} horizontal pagingEnabled showsHorizontalScrollIndicator={false}
        initialScrollIndex={index} initialNumToRender={3} windowSize={5} scrollEventThrottle={16}
        getItemLayout={(_, position) => ({ length: width, offset: position * width, index: position })}
        onScroll={event => setIndex(Math.max(0, Math.min(pages.length - 1,
          Math.round(event.nativeEvent.contentOffset.x / width))))}
        testID="journal-archive-pages"
        renderItem={({ item, index: position }) => <ScrollView style={{ width }}
          aria-hidden={index !== position} accessibilityElementsHidden={index !== position}
          importantForAccessibility={index !== position ? 'no-hide-descendants' : 'auto'}
          contentContainerStyle={styles.page}>
          {item.records.map(record => {
            const metadata = [record.places.join(', '), record.times.join(', ')].filter(Boolean).join(' · ');
            return <View key={record.child_id} style={workStyles.panel}>
              <Text accessibilityRole="header" style={workStyles.title}>{record.child_name}</Text>
              {record.areas.length > 0 && <WorkMessage>관찰영역 · {record.areas.join(', ')}</WorkMessage>}
              {!!metadata && <WorkMessage>{metadata}</WorkMessage>}
              <Text selectable style={workStyles.body}>{record.content}</Text>
            </View>;
          })}
        </ScrollView>} />}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 24, gap: 10 },
  dateLabel: { alignItems: 'center' },
  page: { paddingHorizontal: 24, paddingTop: 14, paddingBottom: 28, gap: 12 },
});
