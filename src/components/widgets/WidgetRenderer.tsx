import { useEffect, useId, useRef } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { useStore } from 'zustand';
import type { Action, Expression, WidgetNode } from '../../lib/widgets/contract';
import { evaluate, formErrors, summarize, type WidgetSession } from '../../lib/widgets/model';
import { WidgetControl } from './WidgetControl';
import { WidgetChart, WidgetTable } from './WidgetData';
import { widgetText } from './widgetText';
import './widget.css';
import { fmt, tr } from '../../i18n';

const statusIcon = { neutral: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };
const statusName = () => ({ neutral: tr('Información'), success: tr('Correcto'), warning: tr('Aviso'), error: tr('Error') });


export function WidgetRenderer({ session }: { session: WidgetSession }) {
  const root = useRef<HTMLDivElement>(null);
  const focusFrame = useRef<number | undefined>(undefined);
  const feedback = useStore(session, ({ validated, values }) => {
    if (!validated) return '';
    const errors = formErrors(session.definition, values);
    if (!errors.length) return tr('Los valores son válidos.');
    return errors.length === 1 ? tr('Queda un valor obligatorio por completar.') : tr('Quedan {n} valores obligatorios por completar.', { n: errors.length });
  });

  useEffect(() => () => {
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
  }, []);

  const focusAfterUpdate = (trigger: EventTarget, validate = false) => {
    if (!(trigger instanceof HTMLElement) || (!validate && document.activeElement !== trigger)) return;
    if (focusFrame.current !== undefined) cancelAnimationFrame(focusFrame.current);
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = undefined;
      const widget = root.current;
      const focused = document.activeElement;
      if (!widget || (focused !== trigger && focused !== document.body)) return;
      const invalid = validate ? widget.querySelector<HTMLInputElement>('[data-widget-required="true"][aria-invalid="true"]') : null;
      if (invalid) invalid.focus();
      else if (!trigger.isConnected) widget.focus({ preventScroll: true });
    });
  };

  const act = (action: Action, button: HTMLButtonElement) => {
    focusAfterUpdate(button, action.type === 'validate');
    session.dispatch(action);
  };
  return <div className="widget-ui" ref={root} tabIndex={-1} role="group" aria-label={session.definition.title}
    onChange={(event) => focusAfterUpdate(event.target)}>
    <NodeList nodes={session.definition.body} depth={0} session={session} act={act} />
    <p className="widget-feedback" role="status">{feedback}</p>
  </div>;
}

interface Input {
  session: WidgetSession;
  depth: number;
  act: (action: Action, button: HTMLButtonElement) => void;
}

function NodeList({ nodes, depth, session, act }: Input & { nodes: WidgetNode[] }) {
  return nodes.map((node, index) => <Item key={index} node={node} depth={depth} session={session} act={act} />);
}

function Item({ node, depth, session, act }: Input & { node: WidgetNode }) {
  const shown = useStore(session, ({ values }) => node.showIf === undefined || evaluate(node.showIf, values) === true);
  if (!shown) return null;
  switch (node.type) {
    case 'section':
    case 'card':
      return <Group node={node} depth={depth} session={session} act={act} />;
    case 'button':
      return <div><button className="widget-button" type="button" onClick={(event) => act(node.action, event.currentTarget)}>{node.label}</button></div>;
    case 'text':
      return <WidgetText session={session} expression={node.value} />;
    case 'metric':
      return <Metric session={session} node={node} />;
    case 'status': {
      const Icon = statusIcon[node.tone];
      return <p className="widget-status" data-tone={node.tone}>
        <Icon size={15} aria-hidden /><span className="sr-only">{statusName()[node.tone]} · </span>{node.label}
      </p>;
    }
    case 'chart': return <WidgetChart node={node} session={session} />;
    case 'table': return <WidgetTable node={node} session={session} />;
    default: return <WidgetControl node={node} session={session} />;
  }
}

function Group({ node, depth, session, act }: Input & { node: Extract<WidgetNode, { children: WidgetNode[] }> }) {
  const id = useId();
  const Heading = depth === 0 ? 'h4' : 'h5';
  const contents = <>
    {node.title && <Heading id={id} className="widget-group-title">{node.title}</Heading>}
    <div className="widget-layout" data-layout={node.layout}>
      <NodeList nodes={node.children} depth={depth + 1} session={session} act={act} />
    </div>
  </>;
  return node.title ? <section className="widget-group" data-type={node.type} aria-labelledby={id}>{contents}</section>
    : <div className="widget-group" data-type={node.type}>{contents}</div>;
}

function WidgetText({ session, expression }: { session: WidgetSession; expression: Expression }) {
  const value = useStore(session, ({ values }) => evaluate(expression, values));
  return <p className="widget-text">{widgetText(value)}</p>;
}

function Metric({ node, session }: { node: Extract<WidgetNode, { type: 'metric' }>; session: WidgetSession }) {
  const { value } = node;
  const result = useStore(session, ({ values }) => {
    if (typeof value === 'object' && 'data' in value) {
      return summarize(session.definition, value, value.filter && values[value.filter.by.ref]);
    }
    return evaluate(value, values);
  });
  const formatted = typeof result === 'number'
    ? fmt.number(result, { maximumFractionDigits: node.digits }) : widgetText(result);
  return <div className="widget-metric">
    <span className="widget-metric-label">{node.label}</span>
    <output aria-label={node.label} aria-live={typeof value === 'object' && !('data' in value) ? 'polite' : 'off'}>
      {formatted}{node.unit && typeof result === 'number' && <span className="widget-unit"> {node.unit}</span>}
    </output>
  </div>;
}
