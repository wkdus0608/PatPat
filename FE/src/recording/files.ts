export interface RecordingFileName {
  dateKey: string;
  fileName: string;
  startTime: string;
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

export function formatDateKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('유효하지 않은 녹음 시작 시각이에요.');
  }
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export function describeRecording(startedAt: Date): RecordingFileName {
  const dateKey = formatDateKey(startedAt);
  const hour = twoDigits(startedAt.getHours());
  const minute = twoDigits(startedAt.getMinutes());
  return {
    dateKey,
    fileName: `${dateKey}_${hour}-${minute}.m4a`,
    startTime: `${hour}:${minute}`,
  };
}

/** Only completed files in their matching start-date folder are recordings. */
export function parseRecordingFileName(
  fileName: string,
  folderDate: string,
): RecordingFileName | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})\.m4a$/.exec(fileName);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  const dateKey = `${year}-${month}-${day}`;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    dateKey !== folderDate ||
    formatDateKey(date) !== dateKey ||
    Number(hour) > 23 ||
    Number(minute) > 59
  ) return null;
  return { dateKey, fileName, startTime: `${hour}:${minute}` };
}

export function isDateFolder(name: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return false;
  return parseRecordingFileName(`${name}_00-00.m4a`, name) !== null;
}

export function joinFileUri(parent: string, name: string): string {
  return `${parent.replace(/\/$/, '')}/${name}`;
}
