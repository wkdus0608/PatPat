export const colors = {
  background: '#FFFDF7',
  paper: '#FEFDF9',
  raised: '#F4F1EB',
  white: '#FFFFFF',
  ink: '#26221D',
  muted: '#61584D',
  line: '#E3DED4',
  controlLine: '#D9D1C3',
  yellow: '#FDE79B',
  yellowLight: '#F9F0D8',
  amberInk: '#754C20',
  green: '#EEF3EC',
  greenInk: '#405E49',
  pink: '#F8EAE6',
  rose: '#8B3C37',
  blue: '#EDF1F1',
  blueInk: '#40565C',
  disabled: '#EDE9E1',
  scrim: '#26221D66',
} as const;

export const radius = { control: 8, panel: 16 } as const;
export const layout = { gutter: 20, screenWidth: 640, touch: 44 } as const;

export const typeScale = {
  heading: { fontSize: 26, lineHeight: 32, fontWeight: '500' },
  section: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 26 },
  meta: { fontSize: 13, lineHeight: 20 },
  caption: { fontSize: 12, lineHeight: 18 },
} as const;
