from app.journal.interpretation import split_interpretation


def test_interpretation_sentences_are_separated_from_the_observation():
    text = "낙엽을 두 손 가득 모음. 자연물을 모아 가며 탐색하는 경험을 함. 친구에게 낙엽을 건넴."
    assert split_interpretation(text) == ("낙엽을 두 손 가득 모음. 친구에게 낙엽을 건넴.", "자연물을 모아 가며 탐색하는 경험을 함.")


def test_paragraphs_stay_separate_and_other_endings_are_kept():
    text = "블록을 쌓음. 균형을 맞추며 쌓아 보는 경험함.\n\n미끄럼틀을 탐. 차례를 기다리는 연습을 함."
    observed, interpreted = split_interpretation(text)
    assert observed == "블록을 쌓음.\n미끄럼틀을 탐."
    assert interpreted == "균형을 맞추며 쌓아 보는 경험함. 차례를 기다리는 연습을 함."


def test_text_without_interpretation_is_unchanged_and_all_interpretation_keeps_the_original():
    assert split_interpretation("낙엽을 모음.") == ("낙엽을 모음.", "")
    only = "함께 놀이하는 경험을 함."
    assert split_interpretation(only) == (only, "")
