import type React from 'react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';

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
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="segmented-pill" transition={{ type: 'spring', stiffness: 520, damping: 38 }} />}
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

export function Select({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; label: string }) {
  return (
    <select className="select" value={value} aria-label={label} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
 * Deslizador Liquid Glass: `<input type="range">` nativo (teclado, lector de pantalla y valores
 * acotados) con pista luminosa. El valor visible se describe con `format`.
 */
export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  label,
  format,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  format: (v: number) => string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <input
        type="range"
        className="slider-input"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format(value)}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="slider-value tabular-nums">{format(value)}</span>
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
