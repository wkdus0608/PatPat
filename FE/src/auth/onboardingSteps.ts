import type { OnboardingStep } from '../api/v2';

/** 첫 설정 단계(1~4)를 한 칸씩 옮긴다. 4단계를 마치면 5(설정 끝)로 가고, 1단계 앞으로는 가지 않는다. */
export function moveStep(step: OnboardingStep, delta: 1 | -1): OnboardingStep {
  return Math.max(1, Math.min(5, step + delta)) as OnboardingStep;
}
