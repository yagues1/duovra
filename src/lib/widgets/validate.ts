import {
  acceptsValue, CONTROL_SLOT, LIMITS, type Action, type Aggregate, type Control, type Dataset,
  type DataQuery, type Expression, type Filter, type Operand, type Operator, type Scalar, type ScalarType,
  type Series, type Slot, type WidgetDefinition, type WidgetNode,
} from './contract';

type ObjectData = Record<string, unknown>;
type Parsed = { definition: WidgetDefinition; error?: never } | { definition?: never; error: string };

class InvalidWidget extends Error {}

function invalid(path: string, message: string): never {
  throw new InvalidWidget(path + ' · ' + message);
}

function object(value: unknown, path: string, allowed?: string): ObjectData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(path, 'Se esperaba un objeto.');
  const data = value as ObjectData;
  if (allowed && Object.keys(data).some((key) => !allowed.split(' ').includes(key))) {
    invalid(path, 'Hay propiedades desconocidas.');
  }
  return data;
}

function array(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    invalid(path, 'Se esperaba una lista de ' + min + ' a ' + max + ' elementos.');
  }
  return value;
}

function key(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(value)
    || Object.hasOwn(Object.prototype, value) || value === 'prototype') invalid(path, 'Identificador inválido.');
  return value;
}

function text(value: unknown, path: string, max: number = LIMITS.text, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max) {
    invalid(path, 'Se esperaba texto de hasta ' + max + ' caracteres.');
  }
  if (/(?:<\s*(?:\/?[a-z][\w:-]*(?=[\s/>])|[!?])|(?:https?|ftp|javascript|vbscript|data|file|tauri|ipc)\s*:|(?:^|\s)\/\/\S)/i.test(value)) {
    invalid(path, 'Usa texto plano. Las etiquetas HTML y las URLs no están admitidas.');
  }
  return value;
}

function number(value: unknown, path: string, min = -LIMITS.number, max: number = LIMITS.number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    invalid(path, 'Número fuera del intervalo ' + min + ' a ' + max + '.');
  }
  return value;
}

function integer(value: unknown, path: string, min: number, max: number): number {
  const parsed = number(value, path, min, max);
  if (!Number.isInteger(parsed)) invalid(path, 'Se esperaba un número entero.');
  return parsed;
}

function option<const T extends readonly string[]>(value: unknown, options: T, path: string): T[number] {
  if (typeof value !== 'string' || !options.includes(value)) invalid(path, 'Opción no admitida. Opciones: ' + options.join(', ') + '.');
  return value;
}

function flag(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'Se esperaba true o false.');
  return value;
}

function scalar(value: unknown, path: string): Scalar {
  if (typeof value === 'string') return text(value, path, LIMITS.text, true);
  return typeof value === 'boolean' ? value : number(value, path);
}

function dictionary<T>(
  value: unknown, path: string, max: number, parse: (value: unknown, path: string) => T,
): Record<string, T> {
  const entries = Object.entries(object(value, path));
  if (entries.length > max) invalid(path, 'Se permiten hasta ' + max + ' entradas.');
  const result: Record<string, T> = Object.create(null);
  for (const [name, item] of entries) result[key(name, path)] = parse(item, path + '.' + name);
  return result;
}

function slot(value: unknown, path: string): Slot {
  const type = option(object(value, path).type, ['text', 'choice', 'number', 'boolean'], path);
  switch (type) {
    case 'boolean': {
      const { initial } = object(value, path, 'type initial');
      return { type, initial: flag(initial, path) };
    }
    case 'text': {
      const item = object(value, path, 'type initial maxLength required');
      const maxLength = item.maxLength === undefined ? LIMITS.text : integer(item.maxLength, path, 1, LIMITS.text);
      return { type, initial: text(item.initial, path, maxLength, true), maxLength,
        required: item.required === undefined ? false : flag(item.required, path) };
    }
    case 'choice': {
      const item = object(value, path, 'type initial options');
      const options = array(item.options, path, 1, LIMITS.options).map((entry) => {
        const choice = object(entry, path, 'value label');
        return { value: text(choice.value, path, 80), label: text(choice.label, path, 100) };
      });
      if (new Set(options.map((choice) => choice.value)).size !== options.length) invalid(path, 'Las opciones deben ser únicas.');
      const initial = option(item.initial, options.map((choice) => choice.value), path);
      return { type, initial, options };
    }
    case 'number': {
      const item = object(value, path, 'type initial min max step');
      const min = number(item.min, path);
      const max = number(item.max, path, min);
      if (min === max) invalid(path, 'max debe ser mayor que min.');
      const step = item.step === undefined ? Math.min(1, max - min) : number(item.step, path + '.step', 0.000001, Math.min(max - min, LIMITS.number));
      const initial = number(item.initial, path + '.initial', min, max);
      const result = { type, min, max, step, initial };
      if (!acceptsValue(result, initial)) invalid(path + '.initial', 'El valor inicial debe coincidir con un paso del control.');
      return result;
    }
  }
}

const SIGNATURES = {
  add: 'number', sub: 'number', mul: 'number', div: 'number', gt: 'number', gte: 'number',
  eq: 'any', and: 'boolean', or: 'boolean',
} as const satisfies Record<Operator, ScalarType | 'any'>;

class Validator {
  private nodes = 0;
  private cells = 0;
  private tableCells = 0;
  private chartPoints = 0;
  private formulas = 0;
  private tableIds = new Set<string>();
  private state: WidgetDefinition['state'] = Object.create(null);
  private data: WidgetDefinition['data'] = Object.create(null);

  parse(value: unknown): WidgetDefinition {
    const root = object(value, 'Widget', 'version title state data body');
    if (root.version !== 1) invalid('version', 'Esta versión del contrato no está soportada. Usa la versión 1.');
    const title = text(root.title, 'title', 100);
    this.state = dictionary(root.state === undefined ? {} : root.state, 'state', LIMITS.slots, slot);
    this.data = dictionary(root.data === undefined ? {} : root.data, 'data', LIMITS.datasets, this.dataset.bind(this));
    return { version: 1, title, state: this.state, data: this.data, body: this.children(root.body, 'body', 1) };
  }

  private dataset(value: unknown, path: string): Dataset {
    const data = object(value, path, 'columns rows');
    const columns = array(data.columns, path + '.columns', 1, LIMITS.columns).map((item) => {
      const column = object(item, path + '.columns', 'key label');
      return { key: key(column.key, path + '.columns'), label: text(column.label, path + '.columns', 80) };
    });
    if (new Set(columns.map((column) => column.key)).size !== columns.length) invalid(path, 'Las columnas deben ser únicas.');
    const rows = array(data.rows, path + '.rows', 0, LIMITS.rows);
    this.cells += rows.length * columns.length;
    if (this.cells > LIMITS.cells) invalid(path, 'Se ha superado el límite total de celdas.');
    return { columns, rows: rows.map((row, i) => {
      const at = path + '.rows[' + i + ']';
      return array(row, at, columns.length, columns.length).map((cell) => scalar(cell, at));
    }) };
  }

  private binding(value: unknown, path: string): string {
    const id = key(value, path);
    if (!this.state[id]) invalid(path, 'La referencia no existe en state.');
    return id;
  }

  private operand(value: unknown, path: string): { value: Operand; type: ScalarType } {
    if (value && typeof value === 'object') {
      const ref = this.binding(object(value, path, 'ref').ref, path);
      const type = this.state[ref].type;
      return { value: { ref }, type: type === 'text' || type === 'choice' ? 'string' : type };
    }
    const data = scalar(value, path);
    const type = typeof data as ScalarType;
    return { value: data, type };
  }

  private expression(value: unknown, path: string, expected?: ScalarType): Expression {
    let parsed: { value: Expression; type: ScalarType };
    if (value && typeof value === 'object' && Object.hasOwn(value, 'op')) {
      this.countFormula(path);
      const expression = object(value, path, 'op args');
      const op = option(expression.op, Object.keys(SIGNATURES) as Operator[], path);
      const [left, right] = array(expression.args, path + '.args', 2, 2);
      const a = this.operand(left, path + '.args[0]');
      const b = this.operand(right, path + '.args[1]');
      const signature = SIGNATURES[op];
      if (a.type !== b.type || (signature !== 'any' && a.type !== signature)) invalid(path, 'Los tipos de operandos no coinciden con la operación.');
      parsed = { value: { op, args: [a.value, b.value] }, type: /^(add|sub|mul|div)$/.test(op) ? 'number' : 'boolean' };
    } else parsed = this.operand(value, path);
    if (expected && parsed.type !== expected) invalid(path, 'Se esperaba un valor de tipo ' + expected + '.');
    return parsed.value;
  }

  private countFormula(path: string) {
    if (++this.formulas > LIMITS.formulas) invalid(path, 'Se ha superado el límite de operaciones.');
  }

  private column(data: Dataset, value: unknown, path: string, numeric = false): number {
    const id = key(value, path);
    const index = data.columns.findIndex((column) => column.key === id);
    if (index < 0) invalid(path, 'La columna no existe.');
    if (numeric && data.rows.some((row) => typeof row[index] !== 'number')) invalid(path, 'La columna debe ser numérica.');
    return index;
  }

  private filter(data: Dataset, value: unknown, path: string): Filter {
    const filter = object(value, path, 'column by mode all');
    const column = this.column(data, filter.column, path);
    const ref = this.binding(object(filter.by, path, 'ref').ref, path);
    const mode = option(filter.mode, ['equals', 'contains'], path);
    const slot = this.state[ref];
    if (mode === 'contains' && slot.type !== 'text' && slot.type !== 'choice') invalid(path, 'La búsqueda por texto requiere una referencia textual.');
    const all = filter.all === undefined ? undefined : scalar(filter.all, path);
    if (all !== undefined && !acceptsValue(slot, all)) invalid(path, 'El valor para mostrar todo no es válido para este parámetro.');
    return { column, by: { ref }, mode, all };
  }

  private query(item: ObjectData, path: string): DataQuery {
    const data = key(item.data, path + '.data');
    const dataset = this.data[data];
    if (!dataset) invalid(path, 'El conjunto de datos no existe.');
    return { data, filter: item.filter === undefined ? undefined : this.filter(dataset, item.filter, path + '.filter') };
  }

  private aggregate(value: unknown, path: string): Aggregate | undefined {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'op')) return undefined;
    const raw = object(value, path);
    if (raw.op !== 'sum' && raw.op !== 'count' && raw.op !== 'average') return undefined;
    this.countFormula(path);
    const op = raw.op;
    const item = object(value, path, op === 'count' ? 'op data filter' : 'op data filter column');
    const query = this.query(item, path);
    return op === 'count' ? { op, ...query } : { op, ...query, column: this.column(this.data[query.data], item.column, path + '.column', true) };
  }

  private series(value: unknown, path: string): Series {
    const raw = object(value, path);
    if (!Object.hasOwn(raw, 'data')) {
      const item = object(value, path, 'from to points curve');
      return { from: this.expression(item.from, path + '.from', 'number'), to: this.expression(item.to, path + '.to', 'number'),
        points: integer(item.points, path, 2, LIMITS.points), curve: option(item.curve, ['linear', 'quadratic'], path) };
    }
    const item = object(value, path, 'data filter x y');
    const query = this.query(item, path);
    const data = this.data[query.data];
    if (data.rows.length > LIMITS.points) invalid(path, 'Un gráfico admite hasta ' + LIMITS.points + ' puntos.');
    return { ...query, x: this.column(data, item.x, path + '.x'), y: this.column(data, item.y, path + '.y', true) };
  }

  private action(value: unknown, path: string): Action {
    const type = option(object(value, path).type, ['reset', 'validate', 'set', 'toggle'], path);
    if (type === 'reset' || type === 'validate') {
      object(value, path, 'type');
      return { type };
    }
    const action = object(value, path, type === 'toggle' ? 'type bind' : 'type bind value');
    const bind = this.binding(action.bind, path);
    const slot = this.state[bind];
    if (type === 'toggle') {
      if (slot.type !== 'boolean') invalid(path, 'Solo se puede alternar un valor booleano.');
      return { type, bind };
    }
    const next = scalar(action.value, path);
    if (!acceptsValue(slot, next)) invalid(path, 'El valor no es válido para este parámetro.');
    return { type, bind, value: next };
  }

  private children(value: unknown, path: string, depth: number): WidgetNode[] {
    if (depth > LIMITS.depth) invalid(path, 'Demasiados niveles de componentes.');
    return array(value, path, 1, LIMITS.nodes).map((item, i) => this.node(item, path + '[' + i + ']', depth));
  }

  private node(value: unknown, path: string, depth: number): WidgetNode {
    if (++this.nodes > LIMITS.nodes) invalid(path, 'Se ha superado el límite de componentes.');
    const raw = object(value, path);
    const type = raw.type;
    const showIf = raw.showIf === undefined ? undefined : this.expression(raw.showIf, path + '.showIf', 'boolean');
    const properties = (fields: string) => object(value, path, 'type showIf ' + fields);
    const label = () => text(raw.label, path + '.label', 100);
    switch (type) {
      case 'section':
      case 'card': {
        const item = properties('title children layout');
        const title = item.title === undefined ? undefined : text(item.title, path + '.title', 100);
        const layout = item.layout === undefined ? 'stack' : option(item.layout, ['stack', 'grid'], path + '.layout');
        return { type, showIf, title, layout, children: this.children(item.children, path + '.children', depth + 1) };
      }
      case 'text': return { type, showIf, value: this.expression(properties('value').value, path + '.value') };
      case 'metric': {
        const item = properties('label value digits unit');
        return { type, showIf, label: label(),
          value: this.aggregate(item.value, path + '.value') ?? this.expression(item.value, path + '.value'),
          unit: item.unit === undefined ? undefined : text(item.unit, path + '.unit', 24),
          digits: item.digits === undefined ? 2 : integer(item.digits, path + '.digits', 0, 6) };
      }
      case 'status': {
        const item = properties('label tone');
        return { type, showIf, label: label(), tone: option(item.tone, ['neutral', 'success', 'warning', 'error'], path + '.tone') };
      }
      case 'button': return { type, showIf, label: label(), action: this.action(properties('label action').action, path + '.action') };
      case 'table': {
        const item = properties('id label data filter sortable selectable');
        const id = key(item.id, path + '.id');
        if (this.tableIds.has(id)) invalid(path, 'Las tablas deben tener identificadores únicos.');
        this.tableIds.add(id);
        const query = this.query(item, path);
        const selectable = item.selectable === undefined ? false : flag(item.selectable, path + '.selectable');
        const data = this.data[query.data];
        this.tableCells += data.rows.length * (data.columns.length + Number(selectable));
        if (this.tableCells > LIMITS.tableCells) invalid(path, 'Se ha superado el límite de celdas renderizadas.');
        return { type, showIf, id, label: label(), ...query, selectable,
          sortable: item.sortable === undefined ? false : flag(item.sortable, path + '.sortable') };
      }
      case 'chart': {
        const item = properties('label style series domain');
        let domain: { min: number; max: number } | undefined;
        if (item.domain !== undefined) {
          const rawDomain = object(item.domain, path + '.domain', 'min max');
          const min = number(rawDomain.min, path + '.domain.min');
          const max = number(rawDomain.max, path + '.domain.max');
          if (min >= max) invalid(path + '.domain', 'max debe ser mayor que min.');
          domain = { min, max };
        }
        const series = this.series(item.series, path + '.series');
        this.chartPoints += 'data' in series ? this.data[series.data].rows.length : series.points;
        if (this.chartPoints > LIMITS.chartPoints) invalid(path, 'Se ha superado el límite total de puntos de gráficos.');
        return { type, showIf, label: label(), domain, style: option(item.style, ['line', 'bar'], path + '.style'), series };
      }
      default: {
        if (typeof type !== 'string' || !Object.hasOwn(CONTROL_SLOT, type)) invalid(path, 'Componente no admitido.');
        const control = type as Control;
        const bind = this.binding(properties('label bind').bind, path + '.bind');
        if (this.state[bind].type !== CONTROL_SLOT[control]) invalid(path, 'El parámetro no es compatible con este control.');
        return { type: control, showIf, label: label(), bind };
      }
    }
  }
}

export function parseWidget(source: string): Parsed {
  if (source.length > LIMITS.source) return { error: 'La definición supera el límite de ' + LIMITS.source + ' caracteres.' };
  try {
    return { definition: new Validator().parse(JSON.parse(source)) };
  } catch (error) {
    return { error: error instanceof InvalidWidget ? error.message : 'El bloque debe contener un objeto JSON válido.' };
  }
}
