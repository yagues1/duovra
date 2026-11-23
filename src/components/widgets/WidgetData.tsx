import { memo, useMemo } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useStore } from 'zustand';
import type { Scalar, WidgetNode } from '../../lib/widgets/contract';
import { EMPTY_TABLE, evaluate, matchingRows, type WidgetSession } from '../../lib/widgets/model';
import { widgetText } from './widgetText';
import { fmt, tr } from '../../i18n';

type Table = Extract<WidgetNode, { type: 'table' }>;
type Chart = Extract<WidgetNode, { type: 'chart' }>;

const collation = () => fmt.collator({ numeric: true, sensitivity: 'base' });

function compare(a: Scalar, b: Scalar) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a !== typeof b) return typeof a < typeof b ? -1 : 1;
  return collation().compare(widgetText(a), widgetText(b));
}

export function WidgetTable({ node, session }: { node: Table; session: WidgetSession }) {
  const { definition } = session;
  const { columns } = definition.data[node.data];
  const value = useStore(session, (state) => node.filter && state.values[node.filter.by.ref]);
  const { sort, selected } = useStore(session, (state) => state.tables[node.id] ?? EMPTY_TABLE);
  const rows = useMemo(() => {
    const result = matchingRows(definition, node, value);
    if (!sort) return result;
    const { column, descending } = sort;
    return result.sort((a, b) => compare(a.cells[column], b.cells[column]) * (descending ? -1 : 1));
  }, [definition, node, value, sort]);

  return <div className="widget-data">
    <div className="widget-table-scroll" role="region" aria-label={node.label} tabIndex={0}>
      <table className="widget-table">
        <caption>{node.label}</caption>
        <thead><tr>
          {node.selectable && <th scope="col"><span className="sr-only">{tr('Selección')}</span></th>}
          {columns.map((column, index) => {
            const active = sort?.column === index;
            const order = active ? sort.descending ? 'descending' : 'ascending' : undefined;
            const Icon = active ? sort.descending ? ArrowDown : ArrowUp : ChevronsUpDown;
            return <th key={column.key} scope="col" aria-sort={order}>
              {node.sortable ? <button type="button" onClick={() => session.sort(node.id, index)}>
                {column.label}<Icon size={13} aria-hidden />
              </button> : column.label}
            </th>;
          })}
        </tr></thead>
        <tbody>
          {!rows.length && <tr><td colSpan={columns.length + Number(node.selectable)}>{tr('No hay filas que coincidan.')}</td></tr>}
          {rows.map(({ cells, index }) => <tr key={index}>
            {node.selectable && <td>
              <input type="checkbox" aria-label={'Seleccionar fila ' + (index + 1) + ' · ' + widgetText(cells[0])}
                checked={selected.includes(index)} onChange={(event) => session.selectRow(node.id, index, event.currentTarget.checked)} />
            </td>}
            {cells.map((cell, column) => <td key={columns[column].key}>{widgetText(cell)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    {(node.selectable || node.filter) && <p className="widget-table-status" role="status">
      {rows.length} {rows.length === 1 ? 'fila visible' : 'filas visibles'}
      {node.selectable && ' · ' + selected.length + (selected.length === 1 ? ' seleccionada' : ' seleccionadas')}
    </p>}
  </div>;
}

interface Point { label: string; value: number }

export function WidgetChart({ node, session }: { node: Chart; session: WidgetSession }) {
  const { series } = node;
  const first = useStore(session, ({ values }) => 'data' in series
    ? series.filter && values[series.filter.by.ref] : evaluate(series.from, values));
  const last = useStore(session, ({ values }) => 'to' in series ? evaluate(series.to, values) : undefined);
  const points = useMemo((): Point[] | null => {
    if ('data' in series) {
      return matchingRows(session.definition, series, first ?? undefined).map(({ cells }) => ({
        label: widgetText(cells[series.x]), value: Number(cells[series.y]),
      }));
    }
    if (typeof first !== 'number' || typeof last !== 'number') return null;
    return Array.from({ length: series.points }, (_, index) => {
      const fraction = index / (series.points - 1);
      const t = series.curve === 'linear' ? fraction : fraction * fraction;
      return { label: String(index + 1), value: first + (last - first) * t };
    });
  }, [series, first, last, session.definition]);

  return <figure className="widget-data widget-chart">
    <figcaption>{node.label}</figcaption>
    {points?.length ? <>
      <Plot points={points} style={node.style} domain={node.domain} />
      <details>
        <summary>{tr('Datos del gráfico')}</summary>
        <div className="widget-table-scroll" role="region" aria-label={tr('Datos de {label}', { label: node.label })} tabIndex={0}>
          <table className="widget-table">
            <caption className="sr-only">{node.label}</caption>
            <thead><tr><th scope="col">Muestra</th><th scope="col">Valor</th></tr></thead>
            <tbody>{points.map((point, index) => <tr key={index}>
              <td>{point.label}</td><td>{formatPoint(point.value)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </> : <p className="widget-text">{points ? tr('No hay datos para este filtro.') : tr('No se pudo calcular la serie con estos parámetros.')}</p>}
  </figure>;
}

const formatPoint = (value: number) => fmt.number(value, { maximumFractionDigits: 6 });

const Plot = memo(function Plot({ points, style, domain }: { points: Point[]; style: Chart['style']; domain: Chart['domain'] }) {
  const [width, height, inset] = [480, 156, 10];
  const [plotWidth, plotHeight] = [width - 2 * inset, height - 2 * inset];
  const values = points.map((point) => point.value);
  const min = domain?.min ?? Math.min(0, ...values);
  const max = domain?.max ?? Math.max(0, ...values);
  const span = max - min || 1;
  const step = plotWidth / points.length;
  const y = (value: number) => inset + (max - Math.max(min, Math.min(value, max))) / span * plotHeight;
  const x = (i: number) => inset + step * (i + 0.5);
  const baseline = y(0);
  const barWidth = Math.min(44, step * 0.68);
  return <>
    <div className="widget-axis" aria-hidden>{formatPoint(max)}</div>
    <svg className="widget-plot" viewBox={'0 0 ' + width + ' ' + height} aria-hidden="true" focusable="false">
      <line className="widget-baseline" x1={inset} x2={width - inset} y1={baseline} y2={baseline} />
      {style === 'bar' ? values.map((value, i) => <rect key={i} x={x(i) - barWidth / 2} y={Math.min(y(value), baseline)}
        width={barWidth} height={Math.max(1, Math.abs(y(value) - baseline))} rx={Math.min(3, barWidth / 3)} />)
      : values.length === 1 ? <circle cx={x(0)} cy={y(values[0])} r={4} />
      : <polyline points={values.map((value, i) => x(i) + ',' + y(value)).join(' ')} />}
    </svg>
    <div className="widget-axis" aria-hidden>{formatPoint(min)}</div>
    <div className="widget-axis widget-axis-labels" aria-hidden>
      <span>{points[0].label}</span>{points.length > 1 && <span>{points.at(-1)?.label}</span>}
    </div>
  </>;
});
