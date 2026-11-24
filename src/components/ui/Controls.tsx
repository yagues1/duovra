import { motion } from 'motion/react';
import * as RSelect from '@radix-ui/react-select';
import * as RSlider from '@radix-ui/react-slider';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { SPRING } from '../../lib/motion';

/**
 * Interruptor táctil: una pista hundida y un pomo con relieve que se desliza
 * con un muelle corto y, al pulsarlo, se estira hacia donde va.
 */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" data-on={checked || undefined} disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-knob" aria-hidden />
    </button>
  );
}

/**
 * Deslizador sobre Radix Slider (teclado, puntero y lector de pantalla), con pista fina,
 * relleno propio y pomo sólido que crece bajo el puntero. onCommit llega al soltar o al terminar una
 * pulsación de teclado; track pinta la pista (por ejemplo, el arco de matices).
 */
export function Slider({ value, onChange, onCommit, min = 0, max = 100, step = 1, label, valueText, track, disabled, className = '' }: {
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  valueText?: string;
  track?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <RSlider.Root className={`gslider ${className}`} value={[value]} min={min} max={max} step={step} disabled={disabled}
      data-track={track ? '' : undefined}
      onValueChange={(v) => onChange(v[0])} onValueCommit={onCommit ? (v) => onCommit(v[0]) : undefined}>
      <RSlider.Track className="gslider-track" style={track ? { background: track } : undefined}>
        <RSlider.Range className="gslider-range" />
      </RSlider.Track>
      <RSlider.Thumb className="gslider-thumb" aria-label={label} aria-valuetext={valueText} />
    </RSlider.Root>
  );
}

/** Control segmentado con cápsula que se desplaza (morphing) entre opciones. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  id,
  label,
  className = '',
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  id: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={`segmented ${className}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="segmented-opt" data-on={o.value === value || undefined} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="segmented-pill" transition={SPRING.pill} />}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Fila de ajuste: etiqueta y una línea de ayuda a la izquierda, control alineado a la derecha. */
export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <div className="setting-label">{label}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

/** Grupo de ajustes: título fuera de la tarjeta y las filas dentro. */
export function Card({ title, children, actions, description }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; description?: ReactNode }) {
  return (
    <section className="settings-group">
      {(title || actions) && (
        <header className="settings-group-head">
          <div className="min-w-0 flex-1">
            {title && <h3 className="settings-group-title">{title}</h3>}
            {description && <p className="settings-group-text">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="settings-card"><div className="settings-card-body">{children}</div></div>
    </section>
  );
}

/** Radix reserva el valor vacío: se traduce a un centinela solo dentro del componente. */
const EMPTY = '__duovra-empty__';
const enc = (v: string) => (v === '' ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? '' : v);

/**
 * Desplegable sobre Radix Select (teclado, lector de pantalla, foco, colisiones y
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
  /** `swatch`: fondo CSS de una muestra de color junto a la etiqueta (selector de colores). */
  options: { value: string; label: string; swatch?: string }[];
  label: string;
  id?: string;
  invalid?: boolean;
  className?: string;
  /** Alineación del menú con el disparador (los controles de Ajustes van a la derecha). */
  align?: 'start' | 'end';
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  return (
    <RSelect.Root
      value={enc(value)}
      onValueChange={(v) => onChange(dec(v))}
      onOpenChange={(next) => {
        if (next) setContainer(trigger.current?.closest('dialog') ?? null);
      }}
    >
      <RSelect.Trigger ref={trigger} id={id} className={`gselect ${className}`} aria-label={label} aria-invalid={invalid || undefined}>
        {current?.swatch && <span className="gselect-swatch" style={{ background: current.swatch }} aria-hidden />}
        <span className="gselect-value">
          <RSelect.Value>{current?.label ?? value}</RSelect.Value>
        </span>
        <RSelect.Icon className="gselect-chevron" aria-hidden>
          <ChevronDown size={13} strokeWidth={2} />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal container={container ?? undefined}>
        <RSelect.Content ref={content} className={`gselect-content surface-popup${current?.swatch ? ' gselect-content-swatches' : ''}`} position="popper" side="bottom" align={align} sideOffset={6} collisionPadding={10}>
          <RSelect.ScrollUpButton className="gselect-scroll"><ChevronUp size={13} /></RSelect.ScrollUpButton>
          <RSelect.Viewport className="gselect-viewport">
            {options.map((o) => (
              <RSelect.Item key={o.value} value={enc(o.value)} className="gselect-item">
                {o.swatch && <span className="gselect-swatch" style={{ background: o.swatch }} aria-hidden />}
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

