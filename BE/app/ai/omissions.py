"""아이가 하지 않았거나 못 한 일(불참, 안 먹음, 안 잠, 거부)이 입력에 있는지 찾는다.

알림장만 읽는 보호자는 ‘왜 안 먹었는지’, ‘그 시간에 무엇을 했는지’를 궁금해한다. 입력에 이유와 대신 한 일이 없으면
교사에게 묻는다(규칙 '역질문 정책'의 '하지 않은 일 확인'). 문제가 없었다는 뜻의 부정(울지 않음, 다투지 않음)은 찾지 않는다.
"""
import re

SENTENCE = re.compile(r"[^.!?\n]+")

# ~지 않다·~지 못하다, 안·못 + 동사, 싫다고, 거부·거절·불참, 남겼다
NEGATION = re.compile(
    r"(?P<stem>[가-힣]+)지\s*(?:를\s*)?(?:않|못)"
    r"|(?<![가-힣])(?:안|못)\s+(?P<verb>[가-힣]+)"
    r"|싫다고|싫어(?:했|함)|거부|거절|불참|남겼"
)
# 하지 않은 것이 오히려 좋은 일(울지 않음, 다투지 않음, 다치지 않음)이면 묻지 않는다.
PROBLEM_STEMS = ("울", "다투", "싸우", "때리", "밀", "던지", "넘어지", "다치", "떼쓰", "소리", "깨물", "물", "부딪", "화내", "아프", "아팠", "힘들어하")
# 이유나 대신 한 일이 입력에 이미 있다는 표지
REASON = re.compile(
    r"때문|니까|으니|보건실|쉬었|쉬고|쉬는|대신|졸려|졸렸|배불러|배가 (?:불|안)|열이|감기|기침|설사|구토|아파"
    r"|(?:싫어|무서워|피곤해|힘들어|불러|배고파|낯설어|귀찮아|부끄러워|어색해|졸려|아파)서"  # 이유를 뜻하는 말만(‘앉아서’ 같은 순차는 제외)
)


def _is_problem(text: str) -> bool:
    return any(text.startswith(stem) or text.endswith(stem) for stem in PROBLEM_STEMS)


def find_omissions(text: str) -> list[dict]:
    """하지 않은 일이 적힌 문장과, 입력 전체에 이유·대신 한 일이 이미 있는지를 돌려준다."""
    has_reason = bool(REASON.search(text))
    found = []
    for raw in SENTENCE.findall(text or ""):
        sentence = raw.strip()
        if not sentence:
            continue
        for match in NEGATION.finditer(sentence):
            token = match.group("stem") or match.group("verb")
            if token and _is_problem(token):
                continue
            found.append({"sentence": sentence, "has_reason": has_reason})
            break
    return found
