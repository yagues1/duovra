import { motion } from 'motion/react';
import * as RSelect from '@radix-ui/react-select';
import * as RSlider from '@radix-ui/react-slider';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SPRING } from '../../lib/motion';

/** Interruptor con pomo elástico. */
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className="switch" data-on={checked || undefined} onClick={() => onChange(!checked)}>
      <motion.span className="switch-knob" layout transition={{ type: 'spring', stiffness: 700, damping: 32 }} />
    </button>
  );
}

/** Control segmentado con cápsula que se desplaza (morphing) entre opciones. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  id: string;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className="segmented-opt" data-on={o.value === value || undefined} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="segmented-pill" transition={SPRING.pill} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-relaxed faint">{hint}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="settings-card">
      {(title || actions) && (
        <div className="flex items-center gap-2 px-4 pb-1 pt-3.5">
          <h3 className="m-0 flex-1 text-[14px] font-semibold" style={{ color: 'var(--text-strong)' }}>
            {title}
          </h3>
          {actions}
        </div>
      )}
      <div className="px-4 pb-2">{children}</div>
    </section>
  );
}

/** Radix reserva el valor vacío: se traduce a un centinela solo dentro del componente. */
const EMPTY = '__duovra-empty__';
const enc = (v: string) => (v === '' ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? '' : v);

/**
 * Desplegable Liquid Glass sobre Radix Select (teclado, lector de pantalla, foco, colisiones y
 * scroll). Sustituye al `<select>` nativo, cuyo menú del sistema rompía el material.
 * Dentro de un `<dialog>` modal el menú se porta al propio diálogo para quedar en la capa superior.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  id,
  invalid,
  className = '',
  align = 'end',
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
  id?: string;
  invalid?: boolean;
  className?: string;
  /** Alineación del menú con el disparador (los controles de Ajustes van a la derecha). */
  align?: 'start' | 'end';
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const current = options.find((o) => o.value === value);
  return (
    <RSelect.Root
      value={enc(value)}
      onValueChange={(v) => onChange(dec(v))}
      onOpenChange={(open) => open && setContainer(trigger.current?.closest('dialog') ?? null)}
    >
      <RSelect.Trigger ref={trigger} id={id} className={`gselect ${className}`} aria-label={label} aria-invalid={invalid || undefined}>
        <span className="gselect-value">
          <RSelect.Value>{current?.label ?? value}</RSelect.Value>
        </span>
        <RSelect.Icon className="gselect-chevron" aria-hidden>
          <ChevronDown size={13} strokeWidth={2} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal container={container ?? undefined}>
        <RSelect.Content className="gselect-content mat-float" position="popper" side="bottom" align={align} sideOffset={6} collisionPadding={10}>
          <RSelect.ScrollUpButton className="gselect-scroll"><ChevronUp size={13} /></RSelect.ScrollUpButton>
          <RSelect.Viewport className="gselect-viewport">
            {options.map((o) => (
              <RSelect.Item key={o.value} value={enc(o.value)} className="gselect-item">
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
                <RSelect.ItemIndicator className="gselect-check">
                  <Check size={13} strokeWidth={2.2} />
                </RSelect.ItemIndicator>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
          <RSelect.ScrollDownButton className="gselect-scroll"><ChevronDown size={13} /></RSelect.ScrollDownButton>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'error' | 'neutral'; children: ReactNode }) {
  return (
    <span className="badge" data-tone={tone}>
      <span className="badge-dot" aria-hidden />
      {children}
    </span>
  );
}

/**
 * Deslizador Liquid Glass sobre Radix Slider (ratón, táctil y teclado; valores acotados).
 * Durante el arrastre solo se llama a `onPreview` (como mucho una vez por fotograma), que actualiza
 * la vista sin escribir en disco; el valor se guarda una vez con `onChange` al soltar.
 */
export function Slider({
  value,
  onChange,
  onPreview,
  min,
  max,
  step,
  label,
  format,
}: {
  value: number;
  onChange: (v: number) => void;
  onPreview?: (v: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  format: (v: number) => string;
}) {
  const [live, setLive] = useState<number | null>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const v = Math.min(max, Math.max(min, live ?? value));
  return (
    <div className="slider">
      <RSlider.Root
        className="gslider"
        min={min}
        max={max}
        step={step}
        value={[v]}
        onValueChange={([x]) => {
          setLive(x);
          if (!onPreview) return;
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(() => onPreview(x));
        }}
        onValueCommit={([x]) => {
          cancelAnimationFrame(frame.current);
          setLive(null);
          onChange(x);
        }}
      >
        <RSlider.Track className="gslider-track">
          <RSlider.Range className="gslider-range" />
        </RSlider.Track>
        <RSlider.Thumb className="gslider-thumb" aria-label={label} aria-valuetext={format(v)} />
      </RSlider.Root>
      <span className="slider-value tabular-nums">{format(v)}</span>
    </div>
  );
}

/** Selector de paletas con muestras de color (radiogroup). */
export function Swatches<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; colors: string[] }[];
  label: string;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className="swatch"
          data-on={o.value === value || undefined}
          data-tip={o.label}
          onClick={() => onChange(o.value)}
        >
          <span className="swatch-orb" style={{ background: `conic-gradient(from 210deg, ${o.colors.join(', ')}, ${o.colors[0]})` }} aria-hidden />
          <span className="swatch-label">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
