import type { Activity } from '../../lib/activity';

type Pose = {
  lean: number;
  pitch?: number;
  yaw?: number;
  gaze?: readonly [x: number, y: number];
  eyes: string;
  mouth: string;
  prop?: string;
  mark?: string;
  arm?: string;
  hand?: string;
};

// Los trazos homólogos comparten comandos SVG para que ojos, boca y brazos puedan interpolarse.
const mouth = (curve: string, x: number, y: number) => `${curve}Q${x} ${y} ${x} ${y}Q${x} ${y} ${x} ${y}Q${x} ${y} ${x} ${y}`;
export const restingArms = 'M24 62Q17 67 19 72Q19 72 19 72M67 62Q74 67 72 72Q72 72 72 72';

export const poses: Record<Activity, Pose> = {
  idle: { lean: 0, eyes: 'M38 51Q38 53 38 55M54 51Q54 53 54 55', mouth: mouth('M43 65Q46 68 49 65', 49, 65) },
  thinking: {
    lean: -8, pitch: 6, yaw: -2, gaze: [-.4, -1.6],
    eyes: 'M37 50Q38 51.5 39 53M51 48Q52 49.5 53 51', mouth: mouth('M45 66Q47 66 49 66', 49, 66),
    hand: 'M64 64q-7 8-15 6l1-5', mark: 'M68 25h.1m6-5h.1m7-5h.1',
  },
  reading: {
    lean: -9, pitch: -6, yaw: -8, gaze: [-1.3, .8],
    eyes: 'M34 53Q35.5 54.5 37 56M50 53Q51.5 54.5 53 56', mouth: mouth('M43 67Q45 67 47 67', 47, 67),
    prop: 'M6 49l9 2 9-2v15l-9 2-9-2Zm9 2v15',
    mark: 'm9 54 3 .8m6-.8 3-.7', hand: 'M26 65q-6 2-9-4',
  },
  writing: {
    lean: -2, pitch: 1,
    eyes: 'M37 51Q37 53 37 55M53 51Q53 53 53 55', mouth: 'M42 64Q46 62 50 64Q49.5 66 49 68Q46 68 43 68Q42.5 66 42 64',
    prop: 'M61 8h23v13H73l-5 5v-5h-7z', mark: 'M66 13h13m-13 4h9',
    arm: 'M24 62Q16 66 18 72Q18 72 18 72M67 62Q71 64 75 66Q76.5 63 78 60',
  },
  coding: {
    lean: -5, pitch: -7, yaw: -4, gaze: [-.7, 1.2],
    eyes: 'M34 51Q36.5 52.5 39 54M53 51Q51 52.5 49 54', mouth: mouth('M43 68Q46 68 49 68', 49, 68),
    prop: 'm12 62-5 4 5 4m8-8 5 4-5 4m-2-9-4 10', hand: 'M28 66q-5 7-10 7m47-9q6 6 11 3',
  },
  tools: {
    lean: 4, pitch: 3, yaw: 8, gaze: [1.8, -.8],
    eyes: 'M38 50Q38 52 38 54M54 49Q54 51.5 54 54', mouth: mouth('M43 66Q46 69 49 66', 49, 66),
    prop: 'M65 9h22v16H65z', mark: 'm69 14 3 3-3 3m7 0h6',
    arm: 'M24 62Q16 66 18 72Q18 72 18 72M66 61Q75 56 77 48Q77 48 77 48',
  },
  waiting: {
    lean: 1, pitch: -2,
    eyes: 'M38 51Q38 52.5 38 54M54 51Q54 52.5 54 54', mouth: mouth('M44 66Q46 67 48 66', 48, 66),
    prop: 'M69 17h13l3 3v11H69z', mark: 'M77 21v3m0 4h.1',
    hand: 'M27 63q-7 2-12-3m-.5 0-.8-3m2.4 3 1.3-3',
  },
  done: {
    lean: -4, pitch: 4, yaw: 2,
    eyes: 'M35 54Q38 49 41 54M51 54Q54 49 57 54', mouth: mouth('M42 65Q46 71 50 65', 50, 65),
    mark: 'm70 23 4 4 9-10', arm: 'M24 62Q16 66 18 72Q18 72 18 72M66 62Q76 61 77 50Q77 50 77 50',
  },
  error: {
    lean: 9, pitch: -4, yaw: -4, gaze: [-.4, .6],
    eyes: 'M35 54Q37.5 53 40 52M51 52Q53.5 53 56 54', mouth: mouth('M42 69Q46 64 50 69', 50, 69),
    mark: 'M77 18v7m0 4h.1', hand: 'M63 65q-3 5-10 7',
  },
};
