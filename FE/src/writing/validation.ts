import type { SavedRecording } from '../recording/storage';
import type {
  ContentKind, DraftSentence, EditableJournal, Observation, PreparedObservations, WritingDraft,
} from './types';

export class WritingInputError extends Error {}

function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WritingInputError(message);
}

function object(value: unknown): Record<string, unknown> {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), '관찰일지 응답 형식을 확인해 주세요.');
  return value as Record<string, unknown>;
}

export function nonblank(value: unknown): string {
  requireInput(typeof value === 'string' && value.trim().length > 0, '비어 있는 본문이나 식별 정보가 있어요.');
  return value;
}

function strings(value: unknown, allowEmpty = false): string[] {
  requireInput(Array.isArray(value), '관찰 연결 목록 형식을 확인해 주세요.');
  const result = Array.from(value, nonblank);
  requireInput(allowEmpty || result.length > 0, '연결된 관찰이나 아동이 없어요.');
  requireInput(new Set(result).size === result.length, '중복된 관찰이나 아동 정보가 있어요.');
  return result;
}

const kinds: ContentKind[] = ['관찰', '배움 읽기', '놀이 지원', '지원 계획'];

/** Verify local preparation against exactly the selected files. Paths never
 * become observation IDs, nor do recording dates become observation dates. */
export function readPrepared(value: unknown, selected: readonly SavedRecording[]): PreparedObservations {
  const input = object(value);
  requireInput(input.privacyVerified === true, '가명 처리 확인 전에는 초안을 요청할 수 없어요.');
  const recordingUris = strings(input.recordingUris);
  requireInput(recordingUris.length === selected.length && selected.every((file) => recordingUris.includes(file.uri)),
    '선택한 녹음과 연결된 관찰 정보를 다시 확인해 주세요.');
  const childIds = strings(input.childIds);
  requireInput(Array.isArray(input.observations) && input.observations.length > 0, '선택한 녹음에 연결된 관찰이 없어요.');
  const seen = new Set<string>();
  const observations: Observation[] = Array.from(input.observations, (value) => {
    const row = object(value);
    const observation_id = nonblank(row.observation_id);
    requireInput(!seen.has(observation_id), '같은 관찰이 중복되어 있어요.');
    seen.add(observation_id);
    const child_ids = strings(row.child_ids, true);
    const scope = row.scope;
    requireInput(scope === 'common' || scope === 'individual' || scope === 'joint' || scope === 'unresolved', '관찰 분류를 확인해 주세요.');
    requireInput(scope === 'unresolved' ? child_ids.length === 0 : child_ids.length > 0, '관찰 대상 아동을 확인해 주세요.');
    requireInput(scope !== 'individual' || child_ids.length === 1, '개별 관찰의 대상 아동을 확인해 주세요.');
    requireInput(scope !== 'joint' || child_ids.length >= 2, '공동 관찰의 대상 아동을 확인해 주세요.');
    // Ontology examples are not a fixed observation_type enumeration.
    const observation_type = strings(row.observation_type, true);
    requireInput(typeof row.sensitive === 'boolean', '민감 관찰 표시를 확인해 주세요.');
    return { observation_id, child_ids, scope, observation_type, sensitive: row.sensitive,
      activity: nonblank(row.activity), text: nonblank(row.text) };
  });
  return { recordingUris, childIds, observations, privacyVerified: true };
}

function initialText(sentences: DraftSentence[]): string {
  // Section labels describe supplied content only. Do not synthesize missing stages.
  return sentences.map((sentence, index) =>
    (index === 0 || sentences[index - 1].contentKind !== sentence.contentKind ? sentence.contentKind + '\n' : '')
    + sentence.text).join('\n\n');
}

export function readDraft(value: unknown, context: PreparedObservations): WritingDraft {
  const input = object(value);
  requireInput(typeof input.common_text === 'string' && Array.isArray(input.records), '초안 본문 형식을 확인해 주세요.');
  requireInput(input.records.length === context.childIds.length, '요청한 아동별 초안이 모두 도착하지 않았어요.');
  const observations = new Map(context.observations.map((row) => [row.observation_id, row]));
  const recordIds = new Set<string>();
  const records: EditableJournal[] = Array.from(input.records, (value, index) => {
    const row = object(value);
    const recordId = nonblank(row.record_id);
    const childId = nonblank(row.child_id);
    requireInput(childId === context.childIds[index], '요청한 아동 순서와 초안 대상이 일치하지 않아요.');
    requireInput(!recordIds.has(recordId), '초안 기록이 중복되어 있어요.');
    recordIds.add(recordId);
    requireInput(row.status === '작성중' || row.status === '검토중', '교사 확정 전 완료된 초안은 사용할 수 없어요.');
    requireInput(typeof row.missing_evidence === 'boolean' && Array.isArray(row.individual_sentences), '아동별 초안 항목을 확인해 주세요.');
    requireInput(Array.isArray(row.special_notes) && row.special_notes.length === 0, '관찰일지의 민감 관찰도 관찰 본문에 포함되어야 해요.');
    const hasEvidence = context.observations.some((observation) =>
      (observation.scope === 'individual' || observation.scope === 'joint') && observation.child_ids.includes(childId));
    requireInput(row.missing_evidence === !hasEvidence, '아동의 개별 근거 표시가 일치하지 않아요.');
    requireInput(!row.missing_evidence || row.individual_sentences.length === 0, '근거가 없는 아동의 개별 초안은 사용할 수 없어요.');
    const sentences: DraftSentence[] = Array.from(row.individual_sentences, (value) => {
      const sentence = object(value);
      const contentKind = sentence.content_kind as ContentKind;
      requireInput(kinds.includes(contentKind), '관찰일지의 항목 종류를 확인해 주세요.');
      const observationIds = strings(sentence.observation_ids);
      const linked = observationIds.map((id) => observations.get(id));
      requireInput(linked.every((observation) => observation && observation.scope !== 'unresolved'
        && observation.child_ids.includes(childId)), '선택하지 않은 관찰이나 다른 아동의 근거가 포함되어 있어요.');
      requireInput(linked.some((observation) => observation?.scope !== 'common'), '공통 활동만으로 개별 문장을 만들 수 없어요.');
      return { text: nonblank(sentence.text), observationIds, contentKind };
    });
    requireInput(!hasEvidence || sentences.length > 0, '관찰 근거에 대한 아동별 본문이 누락되어 있어요.');
    const text = initialText(sentences);
    return { recordId, childId, sentences, missingEvidence: row.missing_evidence,
      initialText: text, editedText: text, prompt: '', version: 0, candidate: null, confirmedText: null };
  });
  return { commonText: input.common_text, context, records };
}

export function readCandidate(value: unknown): string {
  return nonblank(object(value).text);
}

export function requireConfirmed(value: unknown): void {
  requireInput(object(value).status === '완료', '관찰일지 저장 완료를 확인하지 못했어요. 다시 시도해 주세요.');
}
