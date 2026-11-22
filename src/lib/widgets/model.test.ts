import { describe, expect, it } from 'vitest';
import { createWidgetSession, evaluate, formErrors, matchingRows, summarize } from './model';
import { parseWidget } from './validate';

const filter = { column: 'group', by: { ref: 'query' }, mode: 'contains' };
const schema = {
  version: 1, title: 'Métricas',
  state: {
    n: { type: 'number', min: 0, max: 10, initial: 2, step: 0.5 },
    query: { type: 'text', initial: '', required: true },
    show: { type: 'boolean', initial: false },
  },
  data: {
    samples: {
      columns: [{ key: 'group', label: 'Grupo' }, { key: 'value', label: 'Valor' }],
      rows: [['Norte', 4], ['Sur', 6]],
    },
  },
  body: [
    { type: 'metric', label: 'Total', value: { op: 'sum', data: 'samples', column: 'value', filter } },
    { type: 'table', label: 'Muestras', id: 'samples', data: 'samples', filter },
  ],
};

describe('modelo declarativo v1', () => {
  it('resuelve referencias, restringe valores y aplica una única acción local', () => {
    const { definition } = parseWidget(JSON.stringify(schema));
    expect(definition).toBeDefined();
    const session = createWidgetSession(definition!);
    const values = () => session.getState().values;
    expect(formErrors(definition!, values())).toEqual(['query']);
    session.setValue('n', 4.5);
    session.setValue('n', 999);
    session.setValue('n', 4.4);
    session.setValue('__proto__', 'texto');
    expect(evaluate({ op: 'mul', args: [{ ref: 'n' }, 2] }, values())).toBe(9);
    expect(evaluate({ op: 'div', args: [{ ref: 'n' }, 0] }, values())).toBeNull();
    expect(evaluate({ op: 'mul', args: [1e9, 1e9] }, values())).toBeNull();
    session.dispatch({ type: 'toggle', bind: 'show' });
    session.dispatch({ type: 'set', bind: 'query', value: 'Norte' });
    session.dispatch({ type: 'validate' });
    expect(session.getState()).toMatchObject({ validated: true, values: { show: true } });
    expect(formErrors(definition!, values())).toEqual([]);
    session.dispatch({ type: 'reset' });
    expect(values()).toEqual({ n: 2, query: '', show: false });
  });

  it('filtra conservando índices, calcula agregados y mantiene selección y orden locales', () => {
    const definition = parseWidget(JSON.stringify(schema)).definition!;
    const table = definition.body[1];
    const metric = definition.body[0];
    if (table.type !== 'table' || metric.type !== 'metric' || typeof metric.value !== 'object' || !('data' in metric.value)) throw new Error('Fixture inválido');
    expect(matchingRows(definition, table, 'SUR').map((row) => row.index)).toEqual([1]);
    expect(summarize(definition, metric.value, 'SUR')).toBe(6);
    expect(summarize(definition, metric.value, 'este')).toBe(0);
    const session = createWidgetSession(definition);
    session.sort('samples', 1);
    session.sort('samples', 1);
    session.selectRow('samples', 1, true);
    session.selectRow('samples', 1, true);
    expect(session.getState().tables.samples).toEqual({ sort: { column: 1, descending: true }, selected: [1] });
    expect(createWidgetSession(definition).getState().tables.samples).toBeUndefined();
  });

  it('devuelve errores legibles de sintaxis, versión y datos fuera de contrato', () => {
    expect(parseWidget('{"body"').error).toMatch(/JSON/);
    expect(parseWidget(JSON.stringify({ ...schema, version: 3 })).error).toMatch(/versión/);
    expect(parseWidget(JSON.stringify({ ...schema, data: null })).error).toMatch(/data/);
    expect(parseWidget(JSON.stringify({ ...schema, onClick: 'reset' })).error).toMatch(/desconocidas/);
  });
});
