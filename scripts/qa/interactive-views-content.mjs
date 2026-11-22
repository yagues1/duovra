const choice = (initial, ...options) => ({
  type: 'choice', initial, options: options.map(([value, label]) => ({ value, label })),
});
const number = (initial, min, max, step = 1) => ({ type: 'number', initial, min, max, step });
const bool = (initial) => ({ type: 'boolean', initial });
const control = (type, label, bind) => ({ type, label, bind });
const metric = (label, value, unit) => ({ type: 'metric', label, value, unit });
const ref = (name) => ({ ref: name });
const op = (op, a, b) => ({ op, args: [a, b] });
const widget = (title, state, body, data) => ({ version: 1, title, state, data, body });
const card = (title, children, layout = 'grid') => ({ type: 'card', title, children, layout });
const button = (label, type, bind) => ({ type: 'button', label, action: { type, bind } });
const dataset = (columns, rows) => ({ columns: columns.map(([key, label]) => ({ key, label })), rows });

const calculator = widget('Calculadora', {
  a: number(8, -10000, 10000, 0.01),
  b: number(2, -10000, 10000, 0.01),
  operation: choice('add', ['add', 'Sumar'], ['sub', 'Restar'], ['mul', 'Multiplicar'], ['div', 'Dividir']),
}, [
  card('Operandos', [control('numberInput', 'Primer número', 'a'), control('numberInput', 'Segundo número', 'b')]),
  control('segmented', 'Operación', 'operation'),
  ...['add', 'sub', 'mul', 'div'].map((operation) => ({
    ...metric('Resultado', op(operation, ref('a'), ref('b'))),
    showIf: op('eq', ref('operation'), operation),
  })),
  button('Restablecer cálculo', 'reset'),
]);

const area = { column: 'area', by: ref('area'), mode: 'equals', all: 'all' };
const dashboard = widget('Dashboard de entregas', {
  area: choice('all', ['all', 'Todas las áreas'], ['Norte', 'Norte'], ['Sur', 'Sur']),
}, [
  control('select', 'Área', 'area'),
  card('Resumen de abril', [
    metric('Entregas', { op: 'sum', data: 'weeks', column: 'deliveries', filter: area }),
    metric('Objetivo', { op: 'sum', data: 'weeks', column: 'goal', filter: area }),
    metric('Promedio semanal', { op: 'average', data: 'weeks', column: 'deliveries', filter: area }),
  ]),
  { type: 'chart', label: 'Entregas por semana y área', style: 'bar',
    series: { data: 'weeks', filter: area, x: 'week', y: 'deliveries' } },
], {
  weeks: dataset([['week', 'Semana'], ['area', 'Área'], ['deliveries', 'Entregas'], ['goal', 'Objetivo']], [
    ['1 · Norte', 'Norte', 44, 45], ['1 · Sur', 'Sur', 32, 35],
    ['2 · Norte', 'Norte', 51, 48], ['2 · Sur', 'Sur', 36, 38],
    ['3 · Norte', 'Norte', 58, 50], ['3 · Sur', 'Sur', 43, 40],
    ['4 · Norte', 'Norte', 65, 55], ['4 · Sur', 'Sur', 49, 45],
  ]),
});

const table = widget('Tabla de revisiones', {
  query: { type: 'text', initial: '', maxLength: 64 },
}, [
  control('textInput', 'Filtrar por proyecto', 'query'),
  { type: 'table', id: 'reviews', label: 'Revisiones pendientes', data: 'reviews', sortable: true, selectable: true,
    filter: { column: 'project', by: ref('query'), mode: 'contains' } },
  button('Borrar selección y filtro', 'reset'),
], {
  reviews: dataset([['project', 'Proyecto'], ['owner', 'Responsable'], ['pending', 'Pendientes']], [
    ['Brújula', 'Marta', 12], ['Atlas', 'Isabel', 3], ['Órbita', 'Luis', 7], ['Faro', 'Ana', 5],
  ]),
});

const form = widget('Configuración local', {
  name: { type: 'text', initial: '', maxLength: 48, required: true },
  format: choice('resumen', ['resumen', 'Resumen'], ['detallado', 'Detallado']),
  includeTotals: bool(false),
  showResults: bool(false),
}, [
  control('textInput', 'Nombre del informe', 'name'),
  control('select', 'Formato', 'format'),
  control('checkbox', 'Incluir totales', 'includeTotals'),
  button('Validar configuración', 'validate'),
  button('Mostrar u ocultar selección', 'toggle', 'showResults'),
  { ...card('Valores actuales', [
    metric('Nombre', ref('name')),
    metric('Formato seleccionado', ref('format')),
    metric('Totales', ref('includeTotals')),
  ]), showIf: ref('showResults') },
  { type: 'status', label: 'Se incluirán los totales', tone: 'success', showIf: ref('includeTotals') },
]);

const simulation = widget('Simulación de carga', {
  initial: number(14, 0, 100),
  target: number(62, 0, 100),
}, [
  card('Parámetros', [control('slider', 'Carga inicial', 'initial'), control('slider', 'Carga final', 'target')]),
  { type: 'chart', label: 'Progresión de la carga', style: 'line', domain: { min: 0, max: 100 },
    series: { from: ref('initial'), to: ref('target'), points: 18, curve: 'quadratic' } },
  metric('Variación', op('sub', ref('target'), ref('initial')), 'puntos'),
]);

export const examples = { calculator, dashboard, table, form, simulation };
export const deniedWidgetHost = 'duovra-widget-qa.invalid';
export const fence = (source, language = 'duovra-widget') => '\x60\x60\x60' + language + '\n' + source + '\n\x60\x60\x60\n';
export const definition = (example) => JSON.stringify(examples[example], null, 2);
export const calcBlock = fence(definition('calculator'));
export const firstChunk = calcBlock.slice(0, calcBlock.indexOf('"operation"') + 6);
export const throughFence = calcBlock.slice(firstChunk.length, -1);
export const followingText = '\nLa calculadora conserva sus valores mientras llega este texto.\n';
export const codexWidgetResponse = calcBlock + followingText;

const basic = (body, data, state) => JSON.stringify(widget('Prueba de aislamiento', state, body, data));
let nested = { type: 'text', value: 'Profundidad' };
for (let level = 0; level < 7; level++) nested = { type: 'section', children: [nested] };
const oversized = dataset([['n', 'Dato']], Array.from({ length: 151 }, (_, i) => [i]));
export const rejected = [
  ['Propiedad desconocida', basic([{ type: 'text', value: 'Texto', href: 'https://' + deniedWidgetHost }]), 'propiedades desconocidas'],
  ['Componente desconocido', basic([{ type: 'webview', label: 'Vista' }]), 'Componente no admitido'],
  ['JSON malformado', '{"version":1,"body":[', 'objeto JSON válido'],
  ['Anidación', basic([nested]), 'Demasiados niveles'],
  ['Filas', basic([{ type: 'table', id: 'rows', label: 'Filas', data: 'rows' }], { rows: oversized }), '0 a 150'],
  ['Número extremo', basic([{ type: 'metric', label: 'Extremo', value: 1e200 }]), 'Número fuera del intervalo'],
  ['Referencias circulares', basic([{ type: 'text', value: ref('x') }], {}, {
    x: { type: 'text', initial: ref('y') }, y: { type: 'text', initial: ref('x') },
  }), 'Se esperaba texto'],
  ['Operador no permitido', basic([metric('Resultado', op('script', 'marcador', 1))]), 'Opción no admitida'],
  ['URL externa', basic([{ type: 'text', value: 'https://' + deniedWidgetHost + '/widget' }]), 'URLs no están admitidas'],
  ['HTML adversario', basic([{ type: 'text', value: '<script>window.widgetQaExecuted = true</script>' }]), 'etiquetas HTML'],
  ['Acción privilegiada', basic([button('Invocar', 'invoke')]), 'Opción no admitida'],
];

export function interactiveResponse(tag) {
  switch (tag) {
    case 'HOLD-WIDGET-CODEX': return codexWidgetResponse;
    case 'WIDGET-CALCULATOR': return calcBlock;
    case 'WIDGET-CLAUDE':
      return ['dashboard', 'table', 'form', 'simulation'].map((example) => fence(definition(example))).join('\n')
        + '\n' + fence(definition('calculator'), 'json');
    case 'WIDGET-SECURITY': return rejected.map(([name, source]) => '### ' + name + '\n\n' + fence(source)).join('\n');
  }
}
