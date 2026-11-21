/** 초안을 만드는 동안 얼마나 지났는지 알려 주는 짧은 글(화면이 멈춘 것이 아니라는 표시). */
export function elapsedText(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return minutes > 0 ? `${minutes}분 ${total % 60}초째` : `${total}초째`;
}
