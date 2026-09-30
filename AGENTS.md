# AGENTS.md — PatPat

## 1. 제품 맥락

교사가 확인한 메모를 아동·활동별로 구조화하고, 공통 활동과 아동별 사실을 근거와 연결해 알림장·일지 초안으로 만든다. 최종 기록은 교사가 검토·수정·확정한다.

왜 만드는가는 `docs/PROBLEM.md`, 무엇을 만드는가는 `docs/SPEC.md`, 도메인 구조는 `docs/ontology.yaml`이 정본이다. 판정 데이터는 `docs/golden_cases.yaml`을 따른다. 작업 전 해당 문서를 읽고 용어·범위·AC를 맞춘다.

## 2. 도메인 용어집

전체 설명·근거·관계·타입은 온톨로지를 참조한다. 아래는 작업마다 필요한 최소 어휘다.

- Teacher: `recall_strategies`, `review_focus`. 관찰 사실과 최종 기록을 판단하는 교사.
- Child: `participation_expression`, `individual_characteristics`. `child_id`는 가명 코드.
- Guardian: `information_needs`, `sensitive_contexts`. 전달 맥락의 당사자이며 v1의 직접 사용자·발송 대상 API는 없음.
- Activity: `activity_scope`. 활동 이름이 같다고 모든 아동의 참여를 추론하지 않음.
- Observation: `scope`(common/individual/joint/unresolved), `content_kind`(관찰/배움 읽기/놀이 지원/지원 계획), `evidence_text`, `needs_confirmation`.
- EvidenceSource: `source_type`, `use_purpose`, `availability_effect`. 교사가 확인한 원문과 관찰을 연결하는 근거원.
- WritingSession: `start_time`, `child_count`, `duration_minutes`, `work_context`, `writing_mode`, `delay_reasons`.
- ChildcareRecord: `record_type`(알림장/일지), `content_sections`, `missing_sections`, `individualization_mode`, `completion_criteria`, `editing_tool`, `status`(작성중/검토중/완료/지연).

`evidence`는 조사 근거 참조이며 실제 관찰 입력의 클래스 EvidenceSource와 다르다. `observation_ids`는 생성 문장에서 관찰로 연결하는 식별자다. common은 공통 활동, joint는 명시된 여러 아동의 실제 공동 사건이다. unresolved는 확인 전까지 생성 근거로 사용하지 않는다.

## 3. 절대 규칙

1. 입력에 없는 사실을 생성하지 않고 필수 사실의 의미를 보존한다. 미래 계획을 이미 수행한 행동으로 바꾸지 않는다. (AC2, AC6)
2. 아동별 사실을 다른 아동에게 옮기지 않는다. 공통 관찰만 있는 아동에게 개별 행동을 만들지 않고, 모호한 주체는 확인 대상으로 남긴다. (AC3~AC5, AC11)
3. 생성한 모든 사실 문장에 존재하는 관찰 근거를 연결한다. 올바른 번호뿐 아니라 그 원문이 해당 주장을 뒷받침해야 한다. (AC1, AC11)
4. 민감 사건의 당사자·상황·부위·정도·조치를 보존하고 특이사항으로 분리한다. 일지 미입력 항목을 지어내어 채우지 않는다. (AC7, AC13)
5. 교사 확정 전 완료·외부 발송을 하지 않는다. 확정 후에도 외부 발송은 구현하지 않는다. 교사 수정문은 그대로 저장하고 임시저장·조회·실패 과정에서 저장본을 보존한다. (AC8, AC10, AC12, AC15)

## 4. 금지 사항

- 테스트·골든 케이스·AC·판정 기준을 에이전트 판단만으로 완화하거나 변경하지 않는다. 사용자가 명시적으로 지시한 수정은 그 범위 안에서 수행하고 이유를 기록한다.
- 실패를 숨기기 위해 케이스 삭제, skip, xfail, 비활성화, 기대값 변경을 하지 않는다.
- enabled를 통과로, YAML 문법 확인을 제품 테스트 통과로, 실험 계획을 측정 결과로 보고하지 않는다.
- 실명·기관명·실제 아동 사진·식별 가능한 음성을 저장소·테스트에 넣지 않는다. 가상 데이터와 가명 코드를 사용한다.
- 사진 분석, 발달 진단, 외부 플랫폼 연동, 보호자 발송, 추가 문서 유형을 임의로 구현하지 않는다.
- 로그의 근거와 제품 설계 가정을 혼동하지 않는다. 새 클래스·속성·규칙에는 근거 또는 설계 이유를 명시하고 정본 문서부터 수정한다.

## 5. 코딩 컨벤션

- 기술 스택은 구현 전에 정한다. API 필드명은 SPEC의 snake_case, 도메인 클래스명은 온톨로지의 대표어를 따른다.
- 요청·응답의 타입, 필수값, enum, null, ID 참조를 경계에서 검증한다. 타입 정의를 중복해 만들지 않는다.
- 전사·모델 호출·저장 같은 부수효과를 분리하고, 실패 응답과 기존 저장본 보존을 테스트한다.
- 생성 결과와 교사 최종 수정문을 구분해 저장한다. 조회·확정 과정에서 모델을 다시 호출하지 않는다.
- 출력 순서는 요청 child_ids 순서, 원문 등장 순서로 고정한다. 문자열 다양성을 아동별 사실 정확성으로 대체하지 않는다.
- 구현 검증은 골든 케이스의 구조 검사와 의미 판정을 함께 따른다. 같은 입력을 재실행했을 때 결과·설정·변동을 기록한다.

## 6. 완료의 정의

문서 작업은 YAML 구문, AC↔케이스, 근거 번호, 클래스·관계 대상, 문서 간 계약을 확인하고 변경 이유를 설명할 수 있어야 완료다.

제품 구현은 해당 기능의 활성 케이스 실행, 구조 검사, 필요한 사람 의미 판정, 실패 경로 검증을 모두 마쳐야 완료다. 실행 하니스·사람 판정·음성 준비물이 없으면 미검증으로 보고한다. 스파이크는 측정값·실제 출력·오류·판정·SPEC 반영을 남겨야 완료이며, 성공할 때만 완료되는 것은 아니다.

## 7. 운영 정보

### 현재 사용할 수 있는 점검 명령

저장소 루트에서 실행한다.

```sh
ruby -ryaml -e 'ARGV.each { |path| YAML.load_file(path); puts "#{path}: YAML OK" }' docs/ontology.yaml docs/golden_cases.yaml
git diff --check
```

위 명령은 YAML 구문과 변경의 공백 오류만 확인한다. 참조·계약은 문서를 대조해야 하며 제품 AC 통과를 뜻하지 않는다.

### 개발 환경과 테스트 명령

언어·프레임워크·패키지 설치 명령·서버 시작 명령·제품 테스트 명령은 아직 없다. 스택과 실행 하니스를 만든 뒤 실제 실행한 명령만 이 절에 추가한다. 존재하지 않는 `pytest`, `npm test` 등을 현재 명령으로 적지 않는다.

### 디렉터리

- `docs/research/interviews.md`: 조사 로그·관찰·Job Story
- `docs/PROBLEM.md`, `docs/SPEC.md`: 문제와 개발 계약
- `docs/ontology.yaml`: 도메인 정본
- `docs/golden_cases.yaml`: 판정 데이터 정본. 하니스가 다른 위치를 요구하더라도 복제본을 만들지 말고 정본 경로를 함께 변경한다.
- `docs/spikes/`: 기술 가정별 실험 기록
- `docs/REVIEW_CHANGES.md`: 이번 보완의 전후 차이와 팀 설명 자료

진행 상태는 SPEC의 검증 상태와 해당 스파이크 기록을 참조한다. 이 파일에 측정 성과나 진행률을 복제하지 않는다.
