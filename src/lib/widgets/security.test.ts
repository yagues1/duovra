import { describe, expect, it } from 'vitest';
import { LIMITS } from './contract';
import { parseWidget } from './validate';

const node = { type: 'text', value: 'Correcto' };
const schema = (body: unknown[], extras: object = {}) => JSON.stringify({ version: 1, title: 'Prueba', body, ...extras });

describe('límites y aislamiento del contrato v1', () => {
  it.each([
    ['propiedades DOM', { ...node, style: 'background:url(https://widget.invalid)' }],
    ['componente arbitrario', { type: 'iframe', src: 'https://widget.invalid' }],
    ['HTML', { ...node, value: '<svg onload="canary()"></svg>' }],
    ['URL', { ...node, value: 'https://widget.invalid' }],
    ['evento privilegiado', { type: 'button', label: 'Abrir', action: { type: 'invoke', command: 'bootstrap' } }],
    ['evento extra en acción permitida', { type: 'button', label: 'Abrir', action: { type: 'reset', onDone: 'bootstrap' } }],
    ['expresión codificada', { ...node, value: { op: 'eval', args: ['canary()', true] } }],
    ['expresión anidada', { ...node, value: { op: 'add', args: [{ op: 'add', args: [1, 2] }, 3] } }],
    ['referencia inexistente', { ...node, value: { ref: 'constructor' } }],
    ['extremo numérico', { ...node, value: { op: 'div', args: [1e99, 1] } }],
  ])('rechaza %s', (_name, invalid) => {
    expect(parseWidget(schema([invalid]))).toHaveProperty('error', expect.any(String));
  });

  it('rechaza esquemas gigantes o con referencias circulares antes de iniciar el motor', () => {
    expect(parseWidget(' '.repeat(LIMITS.source + 1)).error).toMatch(/límite/);
    let nested: unknown = node;
    for (let i = 0; i < LIMITS.depth; i++) nested = { type: 'section', children: [nested] };
    expect(parseWidget(schema([nested])).error).toMatch(/niveles/);
    expect(parseWidget(schema(Array.from({ length: LIMITS.nodes + 1 }, () => node))).error).toMatch(/lista/);
    expect(parseWidget(schema([node], { state: {
      a: { type: 'text', initial: { ref: 'b' } }, b: { type: 'text', initial: { ref: 'a' } },
    } })).error).toMatch(/texto/);
    expect(parseWidget('{"version":1,"title":"JSON","state":{"__proto__":{}},"body":[]}').error).toMatch(/Identificador/);
    expect(parseWidget('{"version":1,"title":"JSON","body":[{"type":"text","value":1e9999}]}').error).toMatch(/intervalo/);
  });

  it('limita filas, reutilización del mismo dataset y puntos acumulados', () => {
    const table = { type: 'table', id: 'table', label: 'Datos', data: 'x', selectable: true };
    const columns = Array.from({ length: 10 }, (_, i) => ({ key: 'col' + i, label: 'Columna ' + i }));
    const rows = Array.from({ length: LIMITS.rows }, () => columns.map(() => 1));
    const options = (rows: number[][]) => ({ data: { x: { columns, rows } } });
    expect(parseWidget(schema([table], options([...rows, rows[0]]))).error).toMatch(/0 a 150/);
    const tables = Array.from({ length: 3 }, (_, i) => ({ ...table, id: 'table' + i }));
    expect(parseWidget(schema(tables, options(rows))).error).toMatch(/celdas renderizadas/);
    const chart = { type: 'chart', label: 'Gráfico', style: 'line', series: { from: 0, to: 20, points: 96, curve: 'linear' } };
    expect(parseWidget(schema([{ ...chart, series: { ...chart.series, points: 97 } }])).error).toMatch(/intervalo/);
    expect(parseWidget(schema(Array.from({ length: 5 }, () => chart))).error).toMatch(/puntos de gráficos/);
  });

  it('acepta el siguiente esquema válido sin conservar datos inválidos', () => {
    expect(parseWidget(schema([{ type: 'openUrl' }])).definition).toBeUndefined();
    expect(parseWidget(schema([node])).definition?.body).toEqual([{ ...node, showIf: undefined }]);
  });
});
