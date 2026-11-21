// 보관함 관찰일지는 날짜마다 한 쪽씩 가로로 넘긴다. 쪽 안의 세로 스크롤이 되려면 쪽 높이가 정해져 있어야 한다.
export type Box = { width: number; height: number };

export const hasRoom = (box: Box) => box.width > 0 && box.height > 0;

/** 쪽 하나의 크기. 높이를 목록 높이로 고정해야 안쪽 ScrollView가 넘치는 내용을 스크롤한다. */
export const pageSize = (box: Box) => ({ width: box.width, height: box.height });
