// 관찰일지 기간을 한 번에 고르는 버튼(이번 주, 이번 달)의 날짜 계산.
export type Range = { from: string; to: string };

const toDate = (value: string) => new Date(value + 'T00:00:00Z');
const iso = (date: Date) => date.toISOString().slice(0, 10);

function shift(value: string, days: number) {
  const date = toDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}

/** today가 든 주의 월요일부터 일요일까지. */
export function weekRange(today: string): Range {
  const from = shift(today, -((toDate(today).getUTCDay() + 6) % 7));
  return { from, to: shift(from, 6) };
}

/** today가 든 달의 1일부터 말일까지. */
export function monthRange(today: string): Range {
  const date = toDate(today);
  const from = iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)));
  const to = iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)));
  return { from, to };
}
