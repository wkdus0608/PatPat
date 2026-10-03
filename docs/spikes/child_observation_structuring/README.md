# SP-01 실행 키트

[SP-01 아동별 관찰 구조화](../child_observation_structuring.md) 실험을 실행하는 데이터, 라벨 시트, 실행 코드다. 실험 코드라 판정이 끝나면 버려도 된다. 남길 것은 문서 5·6절의 결과와 판단이다(강의 04 슬라이드 31, 작성지침 D절).

강의 04 작성지침에 따라 성공 조건과 정답 라벨은 사람이 정하고, 에이전트에게는 모델 출력 생성 같은 재료 만들기만 맡긴다. 메모 35건과 이 키트는 AI 초안이며 팀 검토 전이다.

## 순서

| 순서 | 할 일 | 누가 | 파일·명령 |
|---|---|---|---|
| 1 | 메모 35건을 검토하고 고친 뒤 `version`, `reviewed_by`를 채운다 | 팀 | `data/prep.yaml`, `data/eval.yaml` |
| 2 | 프롬프트 v1과 스키마를 검토하고 확정한다 | 팀 | `src/patpat/prompts/parse_query.md`, `src/patpat/schemas/observation.schema.json` |
| 3 | 기준 값을 확인하고 판정 단위를 골라 확정 칸을 채운다 | 팀 | `criteria.yaml` |
| 4 | 평가 메모 30건을 서로 보지 않고 각자 라벨한다 | 팀원 2명 | `labels/labeler_1.csv`, `labels/labeler_2.csv` |
| 5 | 두 라벨을 대조하고, 다른 메모만 원문을 함께 읽고 합의한다 | 팀원 2명 | `compare-labels` → `labels/consensus.csv` |
| 6 | 외부 모델 1개를 고르고 호출 함수와 API 키를 준비한다 | 팀 (함수는 Claude에게 요청 가능) | `spike.py`의 `PROVIDERS` |
| 7 | 준비용 5건으로 연결과 출력 형식을 확인한다 | 누구나 | `run --split prep` |
| 8 | 평가 30건을 메모마다 1회 실행한다 | 누구나 | `run --split eval` |
| 9 | 검토표에 통과·실패, 오류 유형, 치명 오류를 적는다 | 팀원 2명 | `review` → `runs/<실행>/review.csv` |
| 10 | 집계해 SP-01 문서 5·6절을 쓴다 | 팀 | `summarize` |

- 6시간과 1만 원 상한은 1~10 전체에 적용된다(문서 2절). 비용 상한은 `run`이 지키고, 작업 시간은 팀이 기록해 `summarize --hours`로 넣는다.
- 평가 메모와 정답은 프롬프트를 고치는 데 쓰지 않고, 프롬프트 최적화는 이 실험에 넣지 않는다(문서 4절). 7에서 형식 문제로 프롬프트를 고쳤다면 `prompt_version`을 올리고 변경 이력에 적은 뒤 8을 실행한다.
- 결과를 본 뒤에는 기준, 메모, 정답을 바꾸지 않는다. `review`는 실행 때와 기준이나 메모가 다르면 멈춘다.

## 라벨 작성 요령 (초안, 팀이 확정)

- 한 행이 관찰 하나다. 관찰이 여럿이면 같은 `memo_id`로 행을 추가한다.
- `child_ids`: 그 사실의 주인공인 요청 아동 코드. 여럿이면 `C01;C02`처럼 쓴다. 관찰이 하나도 없으면 `없음`.
- `text`: 그 사실이 담긴 메모 부분을 그대로 복사한다. 요약하거나 바꿔 쓰지 않는다.
- `activity`: 메모에 적힌 활동명. 없으면 비운다.
- 서로 다른 아동의 행동은 다른 관찰로, 여러 아동이 함께 한 한 사건은 관찰 하나로 나눈다.
- 누구의 일인지 메모로 알 수 없는 문장은 관찰로 만들지 않는다.
- `note`에는 판단이 애매했던 이유를 적는다. 대조에는 쓰지 않는다.

## 명령

Python 3.9 이상에서 `pip install pyyaml jsonschema` 후 저장소 루트에서 실행한다.

```sh
K=docs/spikes/child_observation_structuring
python3 $K/spike.py sheets            # 빈 라벨 시트. 라벨 작성 전에 메모를 고쳤다면 --force로 다시 만든다
python3 $K/spike.py compare-labels    # 라벨 대조. disagreements.csv, agreement.json, consensus.csv를 만든다
python3 $K/spike.py run --split prep --provider <공급자> --model <모델 ID> \
  --price-in-usd <입력 100만 토큰당 달러> --price-out-usd <출력 100만 토큰당 달러> --krw-per-usd <환율>
python3 $K/spike.py run --split eval --provider <공급자> --model <모델 ID> ...   # 7과 같은 인자
python3 $K/spike.py review --run $K/runs/<실행 폴더>
python3 $K/spike.py summarize --run $K/runs/<실행 폴더> --hours <팀 작업 시간>
```

- `run --split eval`은 기준 확정, 메모 검토, 합의 정답이 모두 있어야 실행된다. 정답이 모델 출력보다 먼저다.
- 아동 집합이 정답과 다르거나 호출·형식 오류가 난 메모는 `review`가 실패로 미리 적는다. 나머지 메모의 문장과 활동은 팀원 2명이 판정한다(문서 3절).
- `--provider mock`은 문장마다 가명 코드를 찾는 규칙 분할기다. 배관 점검용이라 준비용 메모에만 쓰고, 출력은 임시 폴더에 남기며 측정 결과로 쓰지 않는다.

## 실제 모델 연결

- `spike.py`의 `PROVIDERS`에 `call_mock`과 같은 형태의 함수를 하나 추가한다. 마커 사이 프롬프트를 system으로, 두 줄 메시지를 user로 보내고, 공급자가 구조화 출력을 지원하면 `observation.schema.json`을 넘긴다. 결과에 영향을 주는 설정은 `settings`에 적어 `meta.json`에 남긴다.
- API 키는 환경 변수로만 둔다. 저장소, 채팅, 실행 기록에 넣지 않는다. 외부 모델에는 가명 메모만 보낸다(SPEC 4절, AC10).
- Claude Code 클라우드 세션에서 실행하려면 프로젝트 설정의 클라우드 환경에 키를 환경 변수로 등록한다. GPT는 네트워크 허용 도메인에 `api.openai.com`도 추가해야 한다(2026-10-03 기본 환경에서 차단 확인).

## 출력

`run`은 `runs/<시각>_<split>_<공급자>/`에 두 파일을 쓴다. 평가 실행 폴더는 커밋해 문서 5절의 출력 위치로 쓴다.

- `outputs.jsonl`: 메모별 응답 원문, 관찰(`observation_id`는 코드가 부여), 원문 대조 결과, 토큰, 비용, 상태
- `meta.json`: 모델, 설정, `prompt_version`, 프롬프트·스키마·데이터 해시, 커밋, 실행 당시 기준, 시각, 비용, 중단 사유

## 지금까지 실행한 것 (2026-10-03)

- `sheets`로 빈 라벨 시트 두 장을 만들었다.
- `run --split prep --provider mock`으로 준비용 5건의 배관(프롬프트 읽기, 사용자 메시지, 스키마 검증, 원문 대조, 기록)을 확인했다. 측정이 아니다.
- 가짜 라벨과 가짜 모델로 `compare-labels`, `run --split eval`, `review`, `summarize`를 두 판정 단위에서 한 번씩 돌리고, 거부 조건(기준 미확정, 합의 전 평가 실행, 예산 상한, 실행 후 기준 변경, 잘못 채운 검토표)을 확인했다. 점검용 파일은 저장소에 넣지 않았다.
- 실제 모델 호출, 정답 라벨, 평가 실행은 하지 않았다.
