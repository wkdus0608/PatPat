export interface RecordingFileName {
  dateKey: string;
  fileName: string;
  startTime: string;
}

/** Same-minute recordings get `_2`, `_3`… so a new take never replaces or blocks an older one. */
export const MAX_RECORDINGS_PER_MINUTE = 99;

const twoDigits = (value: number) => String(value).padStart(2, '0');

export function formatDateKey(date: Date): string {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError('유효하지 않은 녹음 시작 시각이에요.');
  }
  return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export function describeRecording(startedAt: Date, sequence = 1): RecordingFileName {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_RECORDINGS_PER_MINUTE) {
    throw new RangeError('유효하지 않은 녹음 순번이에요.');
  }
  const dateKey = formatDateKey(startedAt);
  const hour = twoDigits(startedAt.getHours());
  const minute = twoDigits(startedAt.getMinutes());
  return {
    dateKey,
    fileName: `${dateKey}_${hour}-${minute}${sequence > 1 ? `_${sequence}` : ''}.m4a`,
    startTime: `${hour}:${minute}`,
  };
}

/** 1 for the first take of a minute, 2+ for later takes in the same minute. */
export function recordingSequence(fileName: string): number {
  const match = /_(\d{1,2})\.m4a$/.exec(fileName);
  return match && /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}_/.test(fileName) ? Number(match[1]) : 1;
}

/** Newest first: date, start minute, then take number within the minute. */
export function compareRecordings(
  a: { dateKey: string; startTime: string; fileName: string },
  b: { dateKey: string; startTime: string; fileName: string },
): number {
  return b.dateKey.localeCompare(a.dateKey) || b.startTime.localeCompare(a.startTime)
    || recordingSequence(b.fileName) - recordingSequence(a.fileName);
}

/** Display label for lists and the player title. */
export function recordingLabel(recording: { startTime: string; fileName: string }): string {
  const sequence = recordingSequence(recording.fileName);
  return sequence > 1 ? `${recording.startTime} 녹음 ${sequence}` : `${recording.startTime} 녹음`;
}

/** Only completed files in their matching start-date folder are recordings. */
export function parseRecordingFileName(
  fileName: string,
  folderDate: string,
): RecordingFileName | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:_([2-9]|[1-9]\d))?\.m4a$/.exec(fileName);
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

/** Native directory URIs end with `/`; file URIs never do. Compare them without it. */
export function trimTrailingSlashes(uri: string): string {
  return uri.replace(/\/+$/, '');
}
