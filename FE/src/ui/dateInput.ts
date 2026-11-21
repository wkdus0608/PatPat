// 날짜를 달력 대신 직접 입력해 받는다(생년월일처럼 몇 년 전 날짜를 달력으로 넘기기 어려운 곳).
export type DateParse = { ok: true; date: string } | { ok: false; error: string };
export type DateBounds = { min?: string; max?: string };

const FORMAT_HINT = '2022-06-03처럼 연-월-일로 입력해 주세요.';

/** 2022-06-03, 2022.6.3, 2022/06/03, 20220603을 받아 YYYY-MM-DD로 바꾼다. 없는 날짜와 범위 밖 날짜는 오류로 돌려준다. */
export function parseDateInput(raw: string, bounds: DateBounds = {}): DateParse {
  const text = raw.trim();
  const parts = /^\d{8}$/.test(text)
    ? [text.slice(0, 4), text.slice(4, 6), text.slice(6, 8)]
    : text.split(/[.\-/\s]+/).filter(Boolean);
  if (parts.length !== 3 || !parts.every(part => /^\d+$/.test(part)) || parts[0].length !== 4) {
    return { ok: false, error: FORMAT_HINT };
  }
  const [year, month, day] = parts.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return { ok: false, error: '없는 날짜예요. ' + FORMAT_HINT };
  }
  const value = date.toISOString().slice(0, 10);
  if (bounds.min && value < bounds.min) return { ok: false, error: bounds.min + ' 이후 날짜를 입력해 주세요.' };
  if (bounds.max && value > bounds.max) return { ok: false, error: bounds.max + ' 이전 날짜를 입력해 주세요.' };
  return { ok: true, date: value };
}
