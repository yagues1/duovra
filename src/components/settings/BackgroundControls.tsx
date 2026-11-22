import { useId, type ChangeEvent, type ReactNode } from 'react';
import { ChevronRight, ImagePlus, Trash2 } from 'lucide-react';
import type { ImageSettings } from '../../lib/background';
import { BACKGROUND_IMAGE_ACCEPT } from '../../lib/backgroundImages';
import {
  BACKDROP_PATTERNS, BACKDROP_STYLES, DIRECTIONAL, PATTERN_LABEL, STYLE_LABEL,
  type BackdropColour, type PatternSettings,
} from '../../lib/backdrop';
import { Select, Slider, Switch } from '../ui/Controls';

/** Una fila del editor: etiqueta a la izquierda, control alineado a la derecha y valor legible. */
function Row({ label, hint, children, value }: { label: string; hint?: string; children: ReactNode; value?: string }) {
  return (
    <div className="bg-row">
      <div className="bg-row-text">
        <span className="bg-row-label">{label}</span>
        {hint && <span className="bg-row-hint">{hint}</span>}
      </div>
      <div className="bg-row-control">
        {children}
        {value !== undefined && <span className="bg-row-value" aria-hidden>{value}</span>}
      </div>
    </div>
  );
}

function Level({ label, hint, value, onChange, max = 100, unit = ' %', text }: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  max?: number;
  unit?: string;
  text?: (value: number) => string;
}) {
  const shown = text ? text(value) : `${value}${unit}`;
  return (
    <Row label={label} hint={hint} value={shown}>
      <Slider label={label} value={value} max={max} valueText={shown} onChange={onChange} />
    </Row>
  );
}

const HUE_TRACK = 'linear-gradient(90deg, hsl(0 70% 55%), hsl(60 70% 55%), hsl(120 70% 50%), hsl(180 70% 50%), hsl(240 70% 62%), hsl(300 70% 58%), hsl(360 70% 55%))';
const motionText = (v: number) => (v === 0 ? 'Quieto' : `${v} %`);

/**
 * Los controles de un patrón de fondo. La primera vista muestra lo esencial (patrón, tratamiento,
 * intensidad, movimiento, extensión y color); el resto queda en «Ajustes avanzados».
 */
export function PatternControls({ pattern, onChange }: { pattern: PatternSettings; onChange: (pattern: PatternSettings) => void }) {
  const set = (patch: Partial<PatternSettings>) => onChange({ ...pattern, ...patch });
  const directional = DIRECTIONAL.includes(pattern.pattern);
  return (
    <>
      <Level label="Intensidad" value={pattern.amount} onChange={(amount) => set({ amount })} />
      <Level label="Movimiento" value={pattern.speed} text={motionText} onChange={(speed) => set({ speed })} />
      <Row label="Color">
        <Select label="Color" value={pattern.colour} onChange={(colour) => set({ colour: colour as BackdropColour })} options={[
          { value: 'agent', label: 'Agente' },
          { value: 'mono', label: 'Mono' },
          { value: 'custom', label: 'Propio' },
        ]} />
      </Row>
      {pattern.colour === 'custom' && (
        <>
          <Row label="Matiz" value={`${pattern.hue}°`}>
            <Slider label="Matiz" value={pattern.hue} max={360} track={HUE_TRACK} valueText={`${pattern.hue} grados`} onChange={(hue) => set({ hue })} />
          </Row>
          <Level label="Saturación" value={pattern.saturation} onChange={(saturation) => set({ saturation })} />
        </>
      )}
      <Advanced>
        <Row label="Patrón">
          <Select label="Patrón" value={pattern.pattern} onChange={(value) => set({ pattern: value as PatternSettings['pattern'] })}
            options={BACKDROP_PATTERNS.map((value) => ({ value, label: PATTERN_LABEL[value] }))} />
        </Row>
        <Row label="Tratamiento">
          <Select label="Tratamiento" value={pattern.style} onChange={(value) => set({ style: value as PatternSettings['style'] })}
            options={BACKDROP_STYLES.map((value) => ({ value, label: STYLE_LABEL[value] }))} />
        </Row>
        <Level label="Extensión" hint="Al máximo, la luz se reparte por todo el fondo." value={pattern.reach} onChange={(reach) => set({ reach })} />
        <Level label="Detalle" hint="Tamaño de las celdas: de grueso a fino." value={pattern.detail} onChange={(detail) => set({ detail })} />
        {directional && <Level label="Dirección" value={pattern.angle} max={180} unit="°" onChange={(angle) => set({ angle })} />}
        {pattern.reach < 100 && <>
          <Level label="Foco horizontal" value={Math.round(pattern.focus.x * 100)} onChange={(x) => set({ focus: { ...pattern.focus, x: x / 100 } })} />
          <Level label="Foco vertical" value={Math.round(pattern.focus.y * 100)} onChange={(y) => set({ focus: { ...pattern.focus, y: y / 100 } })} />
        </>}
        <Row label="Reaccionar" hint="La luz responde al puntero, al enviar y a la actividad de los agentes.">
          <Switch label="Reaccionar al puntero y a la actividad" checked={pattern.react} onChange={(react) => set({ react })} />
        </Row>
      </Advanced>
    </>
  );
}

function Advanced({ children, title = 'Ajustes avanzados' }: { children: ReactNode; title?: string }) {
  return (
    <details className="bg-advanced">
      <summary>
        <ChevronRight size={14} className="bg-advanced-chev" aria-hidden />
        {title}
      </summary>
      <div className="bg-advanced-body">{children}</div>
    </details>
  );
}

/** La imagen personal: importación validada en Rust, encuadre, oscurecimiento, opacidad, desenfoque y tinte. */
export function ImageControls({ image, busy, inputError, onFile, onChange, onRemove }: {
  image: ImageSettings;
  busy: boolean;
  inputError: string | null;
  onFile: (file: File) => void;
  onChange: (image: ImageSettings) => void;
  onRemove: () => void;
}) {
  const hint = useId();
  const set = (patch: Partial<ImageSettings>) => onChange({ ...image, ...patch });
  const selectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (file) onFile(file);
  };
  return (
    <>
      <div className="bg-row">
        <div className="bg-row-text">
          <span className="bg-row-label">Imagen</span>
          <span id={hint} className="bg-row-hint">PNG, JPEG o WebP. Hasta 8 MB, 4096 px por lado y 12 MP.</span>
        </div>
        <div className="bg-row-control bg-image-actions">
          <label className="btn background-file" data-disabled={busy || undefined}>
            <ImagePlus size={14} aria-hidden /> {image.id ? 'Sustituir' : 'Elegir imagen'}
            <input type="file" name="background-image" className="sr-only" accept={BACKGROUND_IMAGE_ACCEPT}
              aria-invalid={inputError ? true : undefined} aria-describedby={`${hint}${inputError ? ` ${hint}-error` : ''}`}
              disabled={busy} onChange={selectFile} />
          </label>
          {image.id && <button type="button" className="btn-icon" aria-label="Quitar imagen del fondo" data-tip="Quitar imagen del fondo" onClick={onRemove} disabled={busy}><Trash2 size={14} aria-hidden /></button>}
        </div>
      </div>
      {inputError && <p id={`${hint}-error`} className="background-error" role="alert">{inputError}</p>}
      {image.id && (
        <>
          <Level label="Intensidad" value={image.opacity} onChange={(opacity) => set({ opacity })} />
          <Advanced>
            <Row label="Encuadre">
              <Select label="Encuadre" value={image.fit} onChange={(fit) => set({ fit: fit as ImageSettings['fit'] })} options={[
                { value: 'cover', label: 'Cubrir' },
                { value: 'contain', label: 'Ajustar' },
              ]} />
            </Row>
            <Level label="Oscurecer" value={image.dim} onChange={(dim) => set({ dim })} />
            <Level label="Desenfoque" value={image.blur} onChange={(blur) => set({ blur })} />
            <Level label="Posición horizontal" value={image.x} onChange={(x) => set({ x })} />
            <Level label="Posición vertical" value={image.y} onChange={(y) => set({ y })} />
            <Level label="Tinte del acento" value={image.tint} onChange={(tint) => set({ tint })} />
          </Advanced>
        </>
      )}
    </>
  );
}
