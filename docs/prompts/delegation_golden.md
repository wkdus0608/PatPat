# PatPat v2 골든 하니스 위임과 검증

## 작업 범위

> 중간평가 지침에 맞춰 정상, 경계, 금지 사례를 YAML에 두고 각 사례의 AC 번호와 실제 기대값을 적는다. 테스트는 YAML을 읽어 PatPat API를 실행하고 응답의 상태와 사실을 기대값과 대조한다. 실제 API 응답을 복사한 뒤 결함을 넣어 같은 단언이 실패하는지 확인한다.

[v2 골든 케이스](../../tests/harness/golden_cases.yaml) 9건은 AC1~AC5와 AC7을 다룬다. [pytest 하니스](../../tests/test_patpat_golden.py)는 임시 SQLite와 가상 교사·아동을 사용한다. 알림장 사례는 v2 세션·알림장 API를 호출하고, 상태 확인 사례는 `GET /health`를 호출한다. 앞서 설계한 [골든 케이스](../golden_cases.yaml)의 입력·출력 계약은 5-3절의 설계 기록으로 보존한다.

## 결함 주입 결과

같은 하니스로 정상 API 출력이 통과함을 확인한 뒤, 그 출력의 한 필드를 바꿔 재검사했다.

| 파일 | 바꾼 값 | 검출된 실패 |
|---|---|---|
| `tests/test_patpat_golden.py` | 교사 확인 전 초안 건수를 0에서 1로 바꿈 | GC-V2-06의 `flow.notices_before_answer`가 실패 |
| `tests/test_patpat_golden.py` | 임시 저장 상태를 검토중에서 완료로 바꿈 | GC-V2-07의 `action.status`가 실패 |

저장소 루트의 테스트 환경에서 `python -m pytest -q tests/test_patpat_golden.py`를 실행했다. 골든 사례 9건과 결함 주입 검증 2건이 모두 통과했다.
