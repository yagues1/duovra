import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../state/store';
import { asHue, HUES, type HueId } from '../../lib/hues';
import type { Activity } from '../../lib/activity';
import type { ActivityView } from '../../hooks/useActivity';
import type { Intensity } from '../../lib/types';
import { type FieldController, type FieldControls, mountField } from '../../lib/field/host';
import type { DitherTexture, DitherVariant, FieldBeat, Look } from '../../lib/field/field';
import { AMBIENT_SPEED, ambientMotion, FIELD_GAIN, fieldIntensity } from '../../lib/appearance';
import { BACKGROUND_KEY, readBackground, type BackgroundConfig, type FieldSettings, type ImageSettings } from '../../lib/background';
import { useBackgroundImage } from '../../lib/backgroundImages';
import { backdropCell, backdropStrength, DIRECTIONAL, type PatternSettings } from '../../lib/backdrop';
import type { AgentId } from '../../lib/types';
import { subscribeWindowPresence } from '../../lib/windowPresence';

const beats: Partial<Record<Activity, [FieldBeat, number]>> = {
  thinking: ['pulse', 0.28],
  reading: ['pulse', 0.32],
  coding: ['pulse', 0.44],
  tools: ['pulse', 0.48],
  writing: ['pulse', 0.30],
  waiting: ['pulse', 0.36],
  done: ['done', 0.66],
  error: ['fail', 0.56],
};
/** Matiz del agente activo: Claude Code cálido (paleta ember), Codex frío (cian de su identidad). */
const CODEX_HUE = 191;
/** Velocidad de deriva al trabajar: claramente por encima de cualquier deriva en reposo. */
const WORK_SPEED = 1.05;
const hues = { domino: 78, frio: 192, cian: 192, hielo: 215, violeta: 250, lavanda: 266, menta: 159, ambar: 34, rosa: 333 };
/**
 * El color de acento (Ajustes → Apariencia) como luz de un campo: matiz y saturación de la rampa
 * personalizada. Es la luz en reposo de todos los fondos integrados que siguen al acento; al trabajar,
 * los que reaccionan pasan al color del agente.
 */
export function accentLight(hue: HueId): { hue: number; sat: number } {
  const range = Math.max(...HUES[hue].hue) - Math.min(...HUES[hue].hue);
  return { hue: hues[hue], sat: hue === 'frio' ? 0.5 : Math.min(0.73, range / 110) };
}
const useAccent = () => useStore((s) => asHue(s.settings['appearance.hue']));
const FIELD_STYLES = {
  original: { variant: 'streak', texture: 'dots' },
  waves: { variant: 'streaks', texture: 'dither' },
  particles: { variant: 'aurora', texture: 'halftone' },
  ambient: { variant: 'aurora', texture: 'soft' },
} as const satisfies Record<string, { variant: DitherVariant; texture: DitherTexture }>;

interface SurfaceProps {
  view?: ActivityView;
  intensity: Intensity;
}

type FieldConfig = Exclude<BackgroundConfig, { kind: 'image' } | { kind: 'minimal' } | { kind: 'pattern' }>;

/**
 * El fondo de la conversación. Mientras se edita en Ajustes (superpuestos) pinta el borrador, así
 * que la conversación real detrás del diálogo es la vista previa principal. Nada se guarda aquí.
 */
export const Background = memo(function Background(props: SurfaceProps) {
  const chat = useStore((s) => s.view === 'chat');
  const raw = useStore((s) => s.settings[BACKGROUND_KEY]);
  const draft = useStore((s) => s.backgroundDraft);
  const saved = useMemo(() => readBackground(raw), [raw]);
  if (!chat) return null;
  return <BackgroundSurface config={draft?.config ?? saved?.active.config ?? null} {...props} />;
});

/** Tras un cambio del fondo en Ajustes, el campo de detrás se anima este tiempo para enseñar su movimiento. */
const LIVE_AFTER_CHANGE = 4000;

/**
 * Un diálogo cubre la conversación: el campo se queda quieto debajo sin seguir dibujando.
 * En Apariencia sigue siendo la vista previa: cada cambio se redibuja al instante y el campo se anima
 * unos segundos tras él o mientras se ve la conversación en la vista previa.
 */
function useCovered() {
  const drawer = useStore((s) => s.navDrawer);
  const open = useStore((s) => s.settingsOpen);
  const appearance = useStore((s) => s.settingsSection === 'appearance');
  const peek = useStore((s) => s.settingsPeek);
  const changedAt = useStore((s) => s.backgroundChangedAt);
  const [, wake] = useState(0);
  const left = LIVE_AFTER_CHANGE - (Date.now() - changedAt);
  useEffect(() => {
    if (!open || !appearance || peek || left <= 0) return;
    const timer = window.setTimeout(() => wake((n) => n + 1), left + 30);
    return () => window.clearTimeout(timer);
  }, [open, appearance, peek, left]);
  return drawer || (open && !(appearance && (peek || left > 0)));
}

/** Renderizador compartido por la conversación y la vista previa. Todo el fondo es decorativo. */
export function BackgroundSurface({ config, onImageError, surface = 'conversation', ...props }: SurfaceProps & {
  config: BackgroundConfig | null;
  onImageError?: (error: string | null) => void;
  /** `swatch`: miniatura de la galería, un único fotograma a escala reducida. */
  surface?: 'conversation' | 'preview' | 'swatch';
}) {
  if (config?.kind === 'minimal') {
    return <div className="chat-backdrop-minimal" data-background="minimal" data-legacy={config.legacy || undefined} aria-hidden="true" />;
  }
  if (config?.kind === 'image') return <ImageBackground settings={config.image} onError={onImageError} />;
  if (config?.kind === 'pattern') return <PatternBackground pattern={config.pattern} surface={surface} {...props} />;
  return <FieldBackground key={config?.kind ?? 'original'} config={config} still={surface !== 'conversation'} swatch={surface === 'swatch'} {...props} />;
}

const WORKING = new Set<Activity>(['thinking', 'reading', 'coding', 'tools', 'writing']);
/** Tiempo sin uso ni ejecuciones tras el que el patrón se asienta en un fotograma quieto. */
const REST_AFTER = 30_000;

function useFieldRest(animate: boolean, working: boolean) {
  const [resting, setResting] = useState(false);
  useEffect(() => {
    if (!animate || working) {
      setResting(false);
      return;
    }
    let lastInput = performance.now();
    let timer = 0;
    let asleep = false;
    let visible = false;
    const check = () => {
      const left = REST_AFTER - (performance.now() - lastInput);
      if (left > 0) timer = window.setTimeout(check, left);
      else {
        asleep = true;
        setResting(true);
      }
    };
    const poke = () => {
      if (!visible) return;
      lastInput = performance.now();
      if (!asleep) return;
      asleep = false;
      setResting(false);
      timer = window.setTimeout(check, REST_AFTER);
    };
    const off = subscribeWindowPresence((next) => {
      visible = next;
      window.clearTimeout(timer);
      if (!next) return;
      asleep = true;
      poke();
    });
    const inputs = ['pointermove', 'pointerdown', 'keydown', 'wheel'] as const;
    for (const type of inputs) window.addEventListener(type, poke, { passive: true, capture: true });
    return () => {
      off();
      window.clearTimeout(timer);
      for (const type of inputs) window.removeEventListener(type, poke, { capture: true });
    };
  }, [animate, working]);
  return resting && !working;
}

/**
 * Un patrón a pantalla completa bajo la conversación: ganancia y opacidad por intensidad, celda por detalle, foco y alcance,
 * dirección para Streaks y Tubes. Duovra añade su relación con los agentes: color de quien escribe,
 * ámbar quieto al esperar una autorización, más deriva y pulsos mientras trabaja.
 *
 * - conversation: la conversación (y su vista vacía).
 * - preview: la vista compacta cuando Ajustes se abre desde Proyectos.
 * - swatch: miniatura de un preset, un único fotograma.
 */
export function PatternBackground({ pattern, view, intensity, surface = 'conversation' }: SurfaceProps & {
  pattern: PatternSettings;
  surface?: 'conversation' | 'preview' | 'swatch';
}) {
  const covered = useCovered();
  const idleAgent = useStore((s) => (s.activeConversationId ? s.prefs[s.activeConversationId]?.agent : undefined)
    ?? (s.settings['defaults.agent'] === 'claude' ? 'claude' : 'codex')) as AgentId;
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<FieldController | null>(null);
  const swatch = surface === 'swatch';
  const activity: Activity = surface !== 'conversation' || view?.stopping ? 'idle' : view?.activity ?? 'idle';
  const runId = view?.runId;
  const reduced = intensity === 'reduced';
  const reacting = pattern.react && !reduced;
  const working = reacting && WORKING.has(activity);
  const waiting = reacting && activity === 'waiting';
  const failed = reacting && activity === 'error';
  const agent = view?.agent ?? idleAgent;
  const accent = useAccent();
  const amount = pattern.amount;
  const { gain, opacity } = backdropStrength(amount);
  const reactGain = Math.min(2.4, Math.max(1, 0.62 / opacity));
  const animate = !swatch && !reduced && !covered;
  const cell = swatch ? Math.max(2, Math.round(backdropCell(pattern.detail) * 0.5)) : backdropCell(pattern.detail);
  const resting = useFieldRest(amount > 0 && animate && (pattern.speed > 0 || pattern.react), working);

  const look = useMemo<Look>(() => {
    const custom = pattern.colour === 'custom';
    const agentColour = pattern.colour === 'agent';
    // «Acento y agente»: en reposo la luz es el acento; mientras un agente trabaja (y al terminar), su color.
    const busy = working || (reacting && activity === 'done');
    const codex = busy && agent === 'codex';
    const claude = busy && agent === 'claude';
    const light = accentLight(accent);
    const palette = pattern.colour === 'mono' ? 'mono' : waiting && agentColour ? 'amber' : claude && !custom && !failed ? 'ember' : 'custom';
    return {
      variant: pattern.pattern,
      palette,
      hue: custom ? pattern.hue : failed ? 351 : codex ? CODEX_HUE : light.hue,
      sat: custom ? pattern.saturation / 100 : failed ? 0.6 : codex ? 0.62 : light.sat,
      focus: [0.72, 0.78],
      spot: [pattern.focus.x, pattern.focus.y, pattern.reach / 100],
      angle: DIRECTIONAL.includes(pattern.pattern) ? pattern.angle : undefined,
      full: true,
      gain: gain * (working ? 1.1 : 1),
      // Trabajando, la deriva se acelera; al esperar una autorización se aquieta (la quietud dice «te toca»).
      speed: waiting ? 0 : (pattern.speed / 50) * (working ? 1.55 : 1),
      seed: 3.7,
      react: reacting ? reactGain : 0,
    };
  }, [pattern, agent, accent, activity, waiting, failed, working, gain, reactGain, reacting]);
  const controls = useMemo<FieldControls>(() => ({ cell, pointer: pattern.react && animate, resting }), [cell, pattern.react, animate, resting]);
  const currentLook = useRef(look);
  currentLook.current = look;
  const currentControls = useRef(controls);
  currentControls.current = controls;
  const texture = pattern.style;
  const currentTexture = useRef(texture);
  currentTexture.current = texture;
  const hidden = amount <= 0;

  useLayoutEffect(() => {
    if (!host.current) return;
    const field = mountField(host.current, currentLook.current, currentTexture.current, currentControls.current);
    controller.current = field;
    return () => {
      controller.current = null;
      field.dispose();
    };
  }, [hidden]);

  const moving = pattern.speed > 0 && !waiting && !resting;
  useLayoutEffect(() => {
    controller.current?.configure(look, animate, moving, controls, texture);
  }, [look, animate, moving, controls, hidden, texture]);

  const previous = useRef<{ activity: Activity; runId?: string | null } | null>(null);
  useEffect(() => {
    const old = previous.current;
    previous.current = { activity, runId };
    if (!old || !animate || !pattern.react || surface !== 'conversation') return;
    const field = controller.current;
    if (!field) return;
    if (runId && old.runId !== runId) field.react('send', 0.51);
    else if (activity !== old.activity) {
      const beat = beats[activity];
      if (beat) field.react(...beat);
    }
  }, [activity, runId, animate, pattern.react, surface]);

  if (hidden) return null;
  return <div className="background-field" ref={host} data-background="pattern" data-surface={surface}
    data-activity={activity} data-resting={resting || undefined} style={{ '--field-opacity': opacity } as CSSProperties} aria-hidden="true" />;
}

function ImageBackground({ settings, onError }: { settings: ImageSettings; onError?: (error: string | null) => void }) {
  const { url, error } = useBackgroundImage(settings.id);
  useEffect(() => { onError?.(error); }, [error, onError]);
  const { fit, x, y, dim, opacity, blur, tint } = settings;
  const brightness = 0.93 - dim * 0.0055;
  const transparency = opacity / 100;
  return <div className="chat-backdrop-image" data-background="image" data-image-missing={!!error || undefined}
    style={{ '--backdrop-image-tint': url ? tint * 0.0042 : 0 } as CSSProperties} aria-hidden="true">
    {url && <img src={url} alt="" draggable={false} style={{
      objectFit: fit,
      objectPosition: x + '% ' + y + '%',
      opacity: transparency,
      filter: 'brightness(' + brightness + ') blur(' + blur * 0.1 + 'px)',
    }} />}
  </div>;
}

function applyFieldSettings(
  base: Look, kind: FieldConfig['kind'], field: FieldSettings, activity: Activity,
): Look {
  const working = activity !== 'idle' && activity !== 'done' && activity !== 'waiting' && activity !== 'error';
  const reaction = field.activity / 100;
  const idleSpeed = field.ambient ? 0.53 * (activity === 'waiting' ? Math.max(0, 1 - reaction * 1.65) : 1) : 0;
  const variant = FIELD_STYLES[kind].variant;
  const center: [number, number] = [field.x / 100, field.y / 100];
  return {
    ...base,
    variant,
    palette: field.palette === 'fixed' ? 'custom' : base.palette,
    // Color fijo: siempre el suyo. «Agente»: en reposo, el acento (como Duovra Original); trabajando, el del agente.
    color: field.palette === 'fixed' ? field.color : undefined,
    focus: center,
    spot: [...center, field.reach / 100],
    full: kind !== 'original',
    angle: variant === 'streaks' ? -30 + field.distribution * 1.8 : undefined,
    gain: (0.2 + 1.2 * (field.intensity / 100)) * (1 + reaction * (working ? 0.28 : activity === 'done' ? 0.18 : 0)),
    speed: (field.speed / 45) * (idleSpeed + (working ? reaction * 1.4 : 0)),
    react: reaction * 1.8,
    shaping: {
      scale: 2.2 - field.size * 0.0175,
      amplitude: 0.0064 * field.amplitude,
      contrast: 0.52 + field.contrast * 0.0096,
      brightness: 0.6 + field.brightness * 0.008,
      softness: field.softness / 100,
      spread: field.distribution / 100,
    },
  };
}

function FieldBackground({ config, view, intensity, still, swatch = false }: SurfaceProps & { config: FieldConfig | null; still: boolean; swatch?: boolean }) {
  const stock = config?.kind === 'original' ? config.stock : undefined;
  const usesLegacy = !stock && (config === null || (config.kind === 'original' && config.legacy === true && !config.field));
  const legacyOff = useStore((s) => usesLegacy && s.settings['appearance.backdrop'] === 'off');
  const enabled = useStore((s) => stock?.reactions ?? (!usesLegacy || s.settings['appearance.background'] !== false));
  const hue = useStore((s) => stock?.hue ?? asHue(s.settings['appearance.hue']));
  const strength = useStore((s) => FIELD_GAIN[stock?.intensity ?? (usesLegacy ? fieldIntensity(s.settings) : 'normal')]);
  const idleSpeed = useStore((s) => AMBIENT_SPEED[stock?.ambient ?? (usesLegacy ? ambientMotion(s.settings) : 'normal')]);
  const dialog = useCovered();
  const kind = config?.kind ?? 'original';
  const settings = config?.field;
  const hidden = legacyOff || settings?.intensity === 0;
  const texture = FIELD_STYLES[kind].texture;
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<FieldController | null>(null);
  const activity = view?.stopping ? 'idle' : view?.activity ?? 'idle';
  const agent = view?.agent;
  const runId = view?.runId;
  const animate = enabled && intensity !== 'reduced' && !still;
  // Duovra Original conserva su reacción al turno sin seguimiento del puntero.
  const pointer = kind !== 'original' && (settings?.pointer ?? true);
  const ambient = settings ? settings.ambient && settings.speed > 0 : idleSpeed > 0;
  const resting = useFieldRest(!hidden && animate && !dialog && (ambient || pointer), WORKING.has(activity));
  const paintedActivity = animate ? activity : 'idle';
  const look = useMemo<Look>(() => {
    const waiting = paintedActivity === 'waiting';
    const failed = paintedActivity === 'error';
    const done = paintedActivity === 'done';
    const idle = paintedActivity === 'idle';
    const working = !idle && !waiting && !failed && !done;
    const codex = agent === 'codex' && (working || done);
    const original: Look = {
      variant: 'streak',
      palette: waiting ? 'amber' : agent === 'claude' && (working || done) ? 'ember' : 'custom',
      hue: failed ? 351 : codex ? CODEX_HUE : accentLight(hue).hue,
      sat: failed ? 0.6 : codex ? 0.62 : accentLight(hue).sat,
      focus: [0.5, 1.15],
      full: false,
      speed: idle || done ? idleSpeed : waiting ? Math.min(idleSpeed, 0.1) : failed ? 0.35 : WORK_SPEED,
      gain: Math.min(1, strength * (idle ? 0.72 : waiting || failed ? 0.74 : done ? 0.84 : 0.92)),
      seed: 3.7,
      react: (intensity === 'full' ? 1 : 0.84) * Math.min(1.15, strength),
    };
    return settings ? applyFieldSettings(original, kind, settings, paintedActivity) : original;
  }, [agent, hue, intensity, paintedActivity, strength, idleSpeed, settings, kind]);
  const controls = useMemo<FieldControls>(() => {
    const cell = settings ? Math.round((kind === 'particles' ? 12 : 13) - settings.density * 0.089) : 7;
    return {
    // En miniatura los puntos del original no bajan de 4 px: más pequeños dejarían de leerse como puntos.
    cell: swatch ? Math.max(kind === 'original' ? 4 : 3, Math.round(cell * 0.55)) : cell,
    dotSize: settings && kind === 'particles' ? 0.32 + settings.size * 0.0068 : undefined,
    pointer,
    resting,
    horizon: kind === 'original',
    band: swatch ? 0.8 : undefined,
    };
  }, [settings, kind, swatch, pointer, resting]);
  const currentLook = useRef(look);
  currentLook.current = look;
  const currentControls = useRef(controls);
  currentControls.current = controls;
  const previous = useRef<{ activity: Activity; runId?: string | null } | null>(null);

  useLayoutEffect(() => {
    if (!host.current) return;
    const field = mountField(host.current, currentLook.current, texture, currentControls.current);
    controller.current = field;
    return () => {
      controller.current = null;
      field.dispose();
    };
  }, [hidden, texture]);

  useEffect(() => {
    const moving = settings ? look.speed > 0 : idleSpeed > 0 || activity !== 'idle';
    controller.current?.configure(look, animate && !dialog, moving && !resting, controls);
  }, [look, hidden, animate, dialog, activity, idleSpeed, settings, controls, resting]);

  useEffect(() => {
    const old = previous.current;
    previous.current = { activity, runId };
    if (!old || !animate || hidden || dialog || settings?.activity === 0) return;
    const field = controller.current;
    if (!field) return;
    if (runId && old.runId !== runId) {
      field.react('send', 0.51);
    } else if (activity !== old.activity) {
      const beat = beats[activity];
      if (beat) field.react(...beat);
    }
  }, [activity, runId, animate, hidden, dialog, settings?.activity]);

  if (hidden) return null;
  const amount = settings ? settings.intensity / 65 : strength;
  return <div className="background-field" ref={host} data-activity={activity} data-background={kind} data-resting={resting || undefined}
    style={{ '--field-k': amount } as CSSProperties} aria-hidden="true" />;
}
