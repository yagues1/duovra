export const LIMITS = {
  source: 65_536,
  nodes: 64,
  depth: 6,
  slots: 24,
  options: 12,
  datasets: 4,
  rows: 150,
  columns: 10,
  cells: 3_000,
  tableCells: 4_000,
  chartPoints: 384,
  points: 96,
  formulas: 64,
  number: 1_000_000_000,
  text: 512,
} as const;

export type Scalar = string | number | boolean;
export type ScalarType = 'string' | 'number' | 'boolean';
export interface Ref { ref: string }
export type Operand = Scalar | Ref;
export type Operator = 'add' | 'sub' | 'mul' | 'div' | 'eq' | 'gt' | 'gte' | 'and' | 'or';
export type Expression = Operand | { op: Operator; args: [Operand, Operand] };
export interface Choice { value: string; label: string }
export type Slot =
  | { type: 'text'; initial: string; maxLength: number; required: boolean }
  | { type: 'choice'; initial: string; options: Choice[] }
  | { type: 'boolean'; initial: boolean }
  | { type: 'number'; initial: number; min: number; max: number; step: number };
export interface Column { key: string; label: string }
export interface Dataset { columns: Column[]; rows: Scalar[][] }
export interface Filter { column: number; by: Ref; mode: 'equals' | 'contains'; all?: Scalar }
export interface DataQuery { data: string; filter?: Filter }
export type Aggregate = DataQuery & ({ op: 'count' } | { op: 'sum' | 'average'; column: number });
export type Series =
  | (DataQuery & { x: number; y: number })
  | { from: Expression; to: Expression; points: number; curve: 'linear' | 'quadratic' };
export type Action =
  | { type: 'reset' | 'validate' }
  | { type: 'toggle'; bind: string }
  | { type: 'set'; bind: string; value: Scalar };

export type Control = 'textInput' | 'numberInput' | 'select' | 'checkbox' | 'slider' | 'segmented';
export const CONTROL_SLOT = {
  textInput: 'text', numberInput: 'number', select: 'choice', checkbox: 'boolean',
  slider: 'number', segmented: 'choice',
} as const satisfies Record<Control, Slot['type']>;
export type WidgetNode = { showIf?: Expression } & (
  | { type: 'section' | 'card'; title?: string; layout: 'stack' | 'grid'; children: WidgetNode[] }
  | { type: 'text'; value: Expression }
  | { type: 'metric'; label: string; value: Expression | Aggregate; digits: number; unit?: string }
  | { type: 'status'; label: string; tone: 'neutral' | 'success' | 'warning' | 'error' }
  | { type: Control; label: string; bind: string }
  | { type: 'button'; label: string; action: Action }
  | ({ type: 'table'; id: string; label: string; sortable: boolean; selectable: boolean } & DataQuery)
  | { type: 'chart'; label: string; style: 'bar' | 'line'; series: Series; domain?: { min: number; max: number } }
);

export interface WidgetDefinition {
  version: 1;
  title: string;
  state: Record<string, Slot>;
  data: Record<string, Dataset>;
  body: WidgetNode[];
}

export function acceptsValue(slot: Slot, value: Scalar): boolean {
  switch (slot.type) {
    case 'boolean': return typeof value === 'boolean';
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < slot.min || value > slot.max) return false;
      const steps = Math.round((value - slot.min) / slot.step);
      const aligned = slot.min + steps * slot.step;
      const tolerance = Math.max(slot.step * 0.000001, Number.EPSILON * 4 * Math.max(Math.abs(slot.min), Math.abs(value)));
      return Math.abs(aligned - value) <= tolerance;
    }
    case 'text': return typeof value === 'string' && value.length <= slot.maxLength;
    case 'choice': return typeof value === 'string' && slot.options.some((option) => option.value === value);
  }
}
