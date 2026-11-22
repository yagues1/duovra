import { useId, useState } from 'react';
import { useStore } from 'zustand';
import { acceptsValue, type Control, type Slot, type WidgetNode } from '../../lib/widgets/contract';
import type { WidgetSession } from '../../lib/widgets/model';

type Node = Extract<WidgetNode, { type: Control }>;

export function WidgetControl({ node, session }: { node: Node; session: WidgetSession }) {
  const id = useId();
  const { bind, label } = node;
  const slot = session.definition.state[bind];
  const value = useStore(session, (state) => state.values[bind]);
  const attempted = useStore(session, (state) => node.type === 'textInput' && state.validated);
  const update = (next: string | number | boolean) => session.setValue(bind, next);

  if (slot.type === 'text') {
    const empty = slot.required && !String(value).trim();
    const invalid = attempted && empty;
    return <div className="widget-control">
      <label htmlFor={id}>{label}{slot.required && <span aria-hidden="true"> *</span>}</label>
      <input id={id} type="text" value={String(value)} maxLength={slot.maxLength} required={slot.required}
        autoComplete="off" spellCheck={false} data-widget-required={empty || undefined}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? id + '-error' : undefined}
        onChange={(event) => update(event.currentTarget.value)} />
      {invalid && <span className="widget-error" id={id + '-error'}>Completa este campo.</span>}
    </div>;
  }
  if (slot.type === 'boolean') {
    return <label className="widget-checkbox">
      <input type="checkbox" checked={Boolean(value)} onChange={(event) => update(event.currentTarget.checked)} />
      <span>{label}</span>
    </label>;
  }
  if (slot.type === 'number') {
    if (node.type === 'slider') return <div className="widget-control">
      <label htmlFor={id}>{label}</label>
      <div className="widget-range">
        <input id={id} type="range" min={slot.min} max={slot.max} step={slot.step} value={Number(value)}
          onChange={(event) => update(event.currentTarget.valueAsNumber)} />
        <span aria-hidden="true">{Number(value).toLocaleString('es-ES', { maximumFractionDigits: 8 })}</span>
      </div>
    </div>;
    return <NumberInput id={id} label={label} slot={slot} value={Number(value)} update={update} />;
  }
  if (node.type === 'segmented') {
    return <fieldset className="widget-segments">
      <legend>{label}</legend>
      <div className="widget-choices">{slot.options.map((option) => <label key={option.value}>
        <input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => update(option.value)} />
        <span>{option.label}</span>
      </label>)}</div>
    </fieldset>;
  }
  return <div className="widget-control">
    <label htmlFor={id}>{label}</label>
    <select id={id} value={String(value)} onChange={(event) => update(event.currentTarget.value)}>
      {slot.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </div>;
}

function NumberInput({ id, label, slot, value, update }: {
  id: string;
  label: string;
  slot: Extract<Slot, { type: 'number' }>;
  value: number;
  update: (value: number) => void;
}) {
  const [draft, setDraft] = useState<{ text: string; valid: boolean }>();
  const [restored, setRestored] = useState(false);
  const invalid = draft?.valid === false;
  const help = 'Introduce un número de ' + slot.min + ' a ' + slot.max + ' con paso ' + slot.step + '.';
  return <div className="widget-control">
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" min={slot.min} max={slot.max} step={slot.step} value={draft?.text ?? value}
      autoComplete="off" aria-invalid={invalid || undefined} aria-describedby={invalid || restored ? id + '-error' : undefined}
      onChange={(event) => {
        const input = event.currentTarget;
        const next = input.valueAsNumber;
        const valid = acceptsValue(slot, next);
        setDraft({ text: input.value.slice(0, 48), valid });
        setRestored(false);
        if (valid) update(next);
      }}
      onBlur={() => {
        if (invalid) setRestored(true);
        setDraft(undefined);
      }} />
    {invalid || restored ? <span className="widget-error" id={id + '-error'}>
      {restored && 'Se restauró el último valor válido. '}{help}
    </span> : null}
  </div>;
}
