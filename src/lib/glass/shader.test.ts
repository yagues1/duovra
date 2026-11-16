import { expect, it } from 'vitest';
import { glassFunctions, glassLight, glassUniforms } from './shader';

it('la luz del cristal viene de arriba a la izquierda y el cursor la inclina con suavidad', () => {
  const rest = glassLight({ x: 0, y: 0, on: 0 }, 1440, 900);
  expect(rest[0]).toBeLessThan(0);
  expect(rest[1]).toBeLessThan(0);
  const right = glassLight({ x: 1440, y: 450, on: 1 }, 1440, 900);
  expect(right[0]).toBeGreaterThan(rest[0]);
  expect(Math.abs(right[0] - rest[0])).toBeLessThan(0.4);
});

it('el GLSL compartido es válido para ES 1.0 (aurora con WebGL 1) y para ES 3.0', () => {
  const src = glassUniforms(4) + glassFunctions(4);
  for (const banned of ['texture(', 'texelFetch', 'texture2D', ' in vec', 'layout(', '#version', '`']) expect(src).not.toContain(banned);
  expect(src).toContain('uniform vec4 uG0[4];');
  expect(src).toMatch(/Glass glassEval\(vec2 p\)/);
});
