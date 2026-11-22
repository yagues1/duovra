import { createStore } from 'zustand/vanilla';
import {
  acceptsValue, LIMITS, type Action, type Aggregate, type DataQuery, type Expression, type Filter,
  type Operand, type Scalar, type WidgetDefinition,
} from './contract';

export type Values = Readonly<Record<string, Scalar>>;
export type TableState = {
  sort?: { column: number; descending: boolean };
  selected: readonly number[];
};

interface Interaction {
  values: Values;
  tables: Readonly<Record<string, TableState>>;
  validated: boolean;
}

export const EMPTY_TABLE: TableState = { selected: [] };
const EMPTY_TABLES: Interaction['tables'] = Object.create(null);

export function createWidgetSession(definition: WidgetDefinition) {
  const initial = Object.fromEntries(Object.entries(definition.state).map(([id, slot]) => [id, slot.initial]));
  const store = createStore<Interaction>(() => ({ values: initial, tables: EMPTY_TABLES, validated: false }));
  const setValue = (id: string, value: Scalar) => {
    const slot = definition.state[id];
    if (slot && acceptsValue(slot, value) && store.getState().values[id] !== value) {
      store.setState(({ values }) => ({ values: { ...values, [id]: value } }));
    }
  };
  const dispatch = (action: Action) => {
    switch (action.type) {
      case 'reset': store.setState({ values: initial, tables: EMPTY_TABLES, validated: false }); break;
      case 'validate': store.setState({ validated: true }); break;
      case 'set': setValue(action.bind, action.value); break;
      case 'toggle': setValue(action.bind, !store.getState().values[action.bind]); break;
    }
  };
  const updateTable = (id: string, update: (table: TableState) => TableState) => {
    store.setState(({ tables }) => ({ tables: { ...tables, [id]: update(tables[id] ?? EMPTY_TABLE) } }));
  };
  return {
    definition,
    subscribe: store.subscribe,
    getState: store.getState,
    getInitialState: store.getInitialState,
    setValue,
    dispatch,
    sort(id: string, column: number) {
      updateTable(id, (table) => ({ ...table, sort: { column, descending: table.sort?.column === column && !table.sort.descending } }));
    },
    selectRow(id: string, row: number, selected: boolean) {
      updateTable(id, (table) => ({ ...table,
        selected: selected ? [...new Set([...table.selected, row])] : table.selected.filter((index) => index !== row),
      }));
    },
  };
}

export type WidgetSession = ReturnType<typeof createWidgetSession>;

function resolve(operand: Operand, values: Values): Scalar {
  return typeof operand === 'object' ? values[operand.ref] : operand;
}

function arithmeticResult(value: number): number | null {
  return Number.isFinite(value) && Math.abs(value) <= LIMITS.number ? value : null;
}

export function evaluate(expression: Expression, values: Values): Scalar | null {
  if (typeof expression !== 'object' || 'ref' in expression) return resolve(expression, values);
  const left = resolve(expression.args[0], values);
  const right = resolve(expression.args[1], values);
  switch (expression.op) {
    case 'add': return arithmeticResult(Number(left) + Number(right));
    case 'sub': return arithmeticResult(Number(left) - Number(right));
    case 'mul': return arithmeticResult(Number(left) * Number(right));
    case 'div': return arithmeticResult(Number(left) / Number(right));
    case 'eq': return left === right;
    case 'gt': return Number(left) > Number(right);
    case 'gte': return Number(left) >= Number(right);
    case 'and': return Boolean(left && right);
    case 'or': return Boolean(left || right);
  }
}

function includesText(value: Scalar, search: Scalar) {
  return String(value).toLowerCase().includes(String(search).trim().toLowerCase());
}

export function matchingRows(definition: WidgetDefinition, query: DataQuery, value?: Scalar) {
  const rows = definition.data[query.data].rows.map((cells, index) => ({ cells, index }));
  const filter = query.filter;
  if (!filter || value === undefined || value === filter.all) return rows;
  return rows.filter(({ cells }) => matches(filter, cells[filter.column], value));
}

function matches(filter: Filter, cell: Scalar, value: Scalar) {
  return filter.mode === 'equals' ? cell === value : includesText(cell, value);
}

export function summarize(definition: WidgetDefinition, query: Aggregate, value?: Scalar): number | null {
  const rows = matchingRows(definition, query, value);
  if (query.op === 'count') return rows.length;
  const total = rows.reduce((sum, row) => sum + Number(row.cells[query.column]), 0);
  return query.op === 'sum' ? arithmeticResult(total) : arithmeticResult(total / rows.length);
}

export function formErrors(definition: WidgetDefinition, values: Values): string[] {
  return Object.entries(definition.state).filter(([id, slot]) =>
    slot.type === 'text' && slot.required && !String(values[id]).trim(),
  ).map(([id]) => id);
}
