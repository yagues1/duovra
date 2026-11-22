import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronRight, Eye, Image as ImageIcon, Plus, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import {
  BACKGROUND_PRESETS, DEFAULT_IMAGE, DUOVRA_PRESETS, LEGACY_FIELD_PRESETS, MAX_BACKGROUND_PRESETS, MAX_PRESET_NAME, PATTERN_BACKGROUND_PRESETS,
  backgroundImageId, backgroundPreferences, legacyToPattern, sameBackground, snapshotBackground,
  type BackgroundConfig, type BackgroundPreset, type BackgroundSelection,
} from '../../lib/background';
import { importBackgroundImage, useBackgroundImage } from '../../lib/backgroundImages';
import { errorText } from '../../lib/ipc';
import type { Intensity } from '../../lib/types';
import { releaseBackgroundDrafts, saveBackgroundPreferences } from '../../state/backgroundPreferences';
import { registerBackgroundNavigation } from '../../state/backgroundNavigation';
import { useStore } from '../../state/store';
import { BackgroundSurface, PatternBackground } from '../shell/Background';
import { confirmDialog } from '../ui/Dialog';
import { ImageControls, PatternControls } from './BackgroundControls';

const DUOVRA_GALLERY = [...DUOVRA_PRESETS.filter((preset) => preset.config.kind !== 'image'), ...LEGACY_FIELD_PRESETS];
const IMAGE_PRESET = DUOVRA_PRESETS.find((preset) => preset.id === 'image')!;
const RECOMMENDED = [DUOVRA_GALLERY[0], ...PATTERN_BACKGROUND_PRESETS.filter((preset) => ['quiet', 'streaks', 'corner'].includes(preset.id))];
const CATEGORIES = ['Recomendados', 'Patrones', 'Duovra', 'Mis fondos'] as const;
type Category = typeof CATEGORIES[number];

function initialCategory(presetId: string): Category {
  if (RECOMMENDED.some((preset) => preset.id === presetId)) return 'Recomendados';
  if (PATTERN_BACKGROUND_PRESETS.some((preset) => preset.id === presetId)) return 'Patrones';
  if (DUOVRA_GALLERY.some((preset) => preset.id === presetId)) return 'Duovra';
  return 'Mis fondos';
}

/**
 * Apariencia → Fondo: galería de presets, patrón y tratamiento, y pocos
 * controles principales; lo técnico queda plegado. Como Ajustes se superpone a la conversación, el
 * borrador se pinta en el fondo real detrás del diálogo (`backgroundDraft` del store) desde el primer
 * cambio. Nada llega a SQLite hasta Aplicar; Cancelar, cerrar Ajustes o cambiar de sección (tras
 * confirmar) descartan el borrador y el fondo vuelve a ser el guardado.
 */
export function BackgroundSettings({ intensity, onPeek }: { intensity: Intensity; onPeek?: () => void }) {
  const settings = useStore((state) => state.settings);
  const { active, presets } = useMemo(() => backgroundPreferences(settings), [settings]);
  const allPresets = useMemo(() => [...BACKGROUND_PRESETS, ...LEGACY_FIELD_PRESETS, ...presets], [presets]);
  const stored = useStore((state) => state.backgroundDraft);
  const setStored = useStore((state) => state.setBackgroundDraft);
  const draft = stored ?? active;
  const [category, setCategory] = useState<Category>(() => initialCategory(active.presetId));
  const [naming, setNaming] = useState<'new' | 'edit' | null>(null);
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operation = useRef<Promise<void> | null>(null);
  const confirming = useRef(false);
  const mounted = useRef(false);
  const temporary = useRef(new Set<string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const uid = useId();
  // Sin conversación detrás (Ajustes abierto desde Proyectos) se muestra una vista previa propia.
  const behind = useStore((state) => state.view === 'chat');
  const personal = presets.find((preset) => preset.id === draft.presetId);
  const base = allPresets.find((preset) => preset.id === draft.presetId);
  const dirty = !sameBackground(active, draft);
  const complete = draft.config.kind !== 'image' || !!draft.config.image.id;
  const defaults: BackgroundConfig | undefined = base?.id === 'image' && draft.config.kind === 'image'
    ? { kind: 'image', image: { ...DEFAULT_IMAGE, id: draft.config.image.id } }
    : base?.config;
  const modified = defaults && !sameBackground(draft, { presetId: draft.presetId, config: defaults });

  const setDraft = (next: BackgroundSelection | null) => setStored(next && sameBackground(next, active) ? null : next);

  useLayoutEffect(() => registerBackgroundNavigation((confirmLabel) => {
    if (operation.current || dirty || naming) return confirmDiscard(confirmLabel);
  }), [dirty, naming]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Salir de Apariencia (ya confirmado) descarta el borrador: el fondo vuelve al guardado.
      useStore.getState().setBackgroundDraft(null);
      const ids = [...temporary.current];
      temporary.current.clear();
      void Promise.resolve(operation.current).then(() => releaseBackgroundDrafts(ids));
    };
  }, []);

  useEffect(() => {
    if (naming) nameInput.current?.focus();
  }, [naming]);

  async function confirmDiscard(confirmLabel: string) {
    if (operation.current) {
      setStatus('Espera a que termine la operación.');
      return false;
    }
    if (confirming.current) return false;
    confirming.current = true;
    try {
      const accepted = await confirmDialog({
        title: '¿Descartar los cambios del fondo?',
        body: 'La conversación volverá al fondo que tenías aplicado.',
        confirmLabel,
        danger: true,
      });
      if (accepted) {
        useStore.getState().setBackgroundDraft(null);
        if (confirmLabel === 'Cerrar Duovra') await clearTemporaryImages();
      }
      return accepted;
    } finally {
      confirming.current = false;
    }
  }

  function run(action: () => Promise<void>, setFailure = setError) {
    if (operation.current) return;
    setFailure(null);
    setStatus('');
    setBusy(true);
    operation.current = Promise.resolve().then(action).catch((reason) => {
      if (mounted.current) setFailure(errorText(reason));
    }).finally(() => {
      operation.current = null;
      if (mounted.current) setBusy(false);
    });
  }

  function edit(config: BackgroundConfig) {
    setDraft({ ...draft, config });
    setStatus('');
  }

  function forgetTemporaryImage() {
    const id = backgroundImageId(draft.config);
    if (id && temporary.current.delete(id)) void releaseBackgroundDrafts([id]);
  }

  function clearTemporaryImages() {
    const ids = [...temporary.current];
    temporary.current.clear();
    return releaseBackgroundDrafts(ids);
  }

  /** Elegir un preset lo prueba al instante en la conversación; los ajustes manuales se reemplazan sin preguntar. */
  function select(preset: BackgroundPreset) {
    if (operation.current) return;
    const useActive = active.presetId === preset.id || (preset.id === 'image' && active.config.kind === 'image');
    const keepImage = preset.id === 'image' && draft.config.kind === 'image';
    const config = useActive ? active.config : keepImage ? draft.config : preset.config;
    if (backgroundImageId(config) !== backgroundImageId(draft.config)) forgetTemporaryImage();
    setDraft({ presetId: preset.id, config });
    setNaming(null);
    setError(null);
    setImageError(null);
    setStatus(preset.id === 'image' && !backgroundImageId(config) ? 'Elige una imagen para usarla como fondo.' : '');
  }

  function cancel() {
    setDraft(null);
    setNaming(null);
    setImageError(null);
    setError(null);
    setStatus('Cambios descartados. La conversación conserva su fondo.');
    setCategory(initialCategory(active.presetId));
    heading.current?.focus({ preventScroll: true });
    void clearTemporaryImages();
  }

  function restore() {
    if (!defaults) return;
    if (backgroundImageId(defaults) !== backgroundImageId(draft.config)) forgetTemporaryImage();
    edit(defaults);
    setImageError(null);
    setStatus(dirty ? 'Valores del preset restaurados en la vista previa.' : 'Valores predeterminados en la vista previa.');
    heading.current?.focus({ preventScroll: true });
  }

  function apply() {
    if (!complete || !dirty) return;
    run(async () => {
      const selection = modified && (personal || base?.config.kind !== draft.config.kind)
        ? { ...draft, presetId: 'custom' } : draft;
      await saveBackgroundPreferences((current) => ({ ...current, active: selection }));
      void clearTemporaryImages();
      if (mounted.current) {
        useStore.getState().setBackgroundDraft(null);
        setStatus('Fondo aplicado a las conversaciones.');
        heading.current?.focus({ preventScroll: true });
      }
    });
  }

  function loadFile(file: File) {
    run(async () => {
      const id = await importBackgroundImage(file);
      if (!mounted.current) {
        void releaseBackgroundDrafts([id]);
        return;
      }
      forgetTemporaryImage();
      temporary.current.add(id);
      const current = useStore.getState().backgroundDraft ?? active;
      if (current.config.kind === 'image') setDraft({ ...current, config: { kind: 'image', image: { ...current.config.image, id } } });
      setStatus('Imagen lista. Se ve ya detrás de Ajustes.');
    }, setImageError);
  }

  function removeImage() {
    forgetTemporaryImage();
    setDraft({ presetId: 'minimal', config: { kind: 'minimal' } });
    setCategory('Duovra');
    setNaming(null);
    setImageError(null);
    setStatus('Pulsa Aplicar para usar Minimalista y retirar la imagen de la conversación.');
  }

  function savePreset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || !complete) return;
    const existing = naming === 'edit' ? personal : undefined;
    const preset = { id: existing?.id ?? crypto.randomUUID(), name: trimmed, config: snapshotBackground(draft.config, settings) };
    run(async () => {
      await saveBackgroundPreferences((current) => {
        if (!existing && current.presets.length >= MAX_BACKGROUND_PRESETS) throw new Error('Has alcanzado el límite de presets personales.');
        if (current.presets.some((item) => item.id !== preset.id && item.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) throw new Error('Ya tienes un preset con ese nombre.');
        const diverged = current.active.presetId === preset.id && !sameBackground(current.active, { presetId: preset.id, config: preset.config });
        return {
          active: diverged ? { ...current.active, presetId: 'custom' } : current.active,
          presets: existing ? current.presets.map((item) => item.id === preset.id ? preset : item) : [...current.presets, preset],
        };
      });
      const savedImage = backgroundImageId(preset.config);
      if (savedImage) temporary.current.delete(savedImage);
      if (mounted.current) {
        const saved = useStore.getState();
        const next = { presetId: preset.id, config: preset.config };
        saved.setBackgroundDraft(sameBackground(next, backgroundPreferences(saved.settings).active) ? null : next);
        setCategory('Mis fondos');
        setNaming(null);
        setStatus('Preset guardado. Pulsa Aplicar para usarlo en la conversación.');
        heading.current?.focus({ preventScroll: true });
      }
    });
  }

  async function removePreset(preset: BackgroundPreset) {
    const accepted = await confirmDialog({
      title: `¿Eliminar «${preset.name}»?`,
      body: 'La conversación conserva el fondo que tenga aplicado.',
      confirmLabel: 'Eliminar preset',
      danger: true,
    });
    if (!accepted || !mounted.current) return;
    run(async () => {
      await saveBackgroundPreferences((current) => ({ ...current,
        active: current.active.presetId === preset.id ? { ...current.active, presetId: 'custom' } : current.active,
        presets: current.presets.filter((item) => item.id !== preset.id),
      }));
      if (mounted.current) {
        forgetTemporaryImage();
        useStore.getState().setBackgroundDraft(null);
        setNaming(null);
        setStatus('Preset eliminado.');
        heading.current?.focus({ preventScroll: true });
      }
    });
  }

  const config = draft.config;
  const convertible = config.kind === 'original' || config.kind === 'waves' || config.kind === 'particles' || config.kind === 'ambient';
  const draftName = (base?.name ?? 'Fondo personalizado') + (modified ? ' · modificado' : '');
  const gallery = category === 'Recomendados' ? RECOMMENDED : category === 'Patrones' ? PATTERN_BACKGROUND_PRESETS
    : category === 'Duovra' ? DUOVRA_GALLERY : [IMAGE_PRESET, ...presets];

  return (
    <section className="background-settings" data-background-editor aria-labelledby={`${uid}-title`} aria-busy={busy}>
      <header className="bg-head">
        <div className="min-w-0">
          <h3 ref={heading} tabIndex={-1} id={`${uid}-title`}>Fondo</h3>
          <p>En uso <strong>{allPresets.find((preset) => preset.id === active.presetId)?.name ?? 'Fondo personalizado'}</strong>{dirty && <> · En prueba <strong>{draftName}</strong></>}</p>
        </div>
        {behind && onPeek && <button className="btn bg-preview-trigger" type="button" onClick={onPeek}>
          <Eye size={14} aria-hidden /> Ver en la conversación
        </button>}
      </header>

      {!behind && (
        <div className="bg-preview chat-stage" aria-label="Vista previa del fondo" role="img">
          <BackgroundSurface config={draft.config} surface="preview" intensity={intensity} />
        </div>
      )}

      <div className="bg-categories" role="group" aria-label="Colecciones de fondos">
        {CATEGORIES.map((item) => <button key={item} className="btn" type="button" aria-pressed={category === item}
          onClick={() => setCategory(item)}>{item}</button>)}
      </div>
      <Gallery title={category} presets={gallery} active={active} draft={draft} busy={busy} intensity={intensity} onSelect={select}
        imageId={backgroundImageId(draft.config) ?? backgroundImageId(active.config)} />

      {config.kind !== 'minimal' && <fieldset className="bg-controls" key={`${draft.presetId}-${config.kind}`} disabled={busy} aria-label={`Ajustes de ${draftName}`}>
        {config.kind === 'pattern' && <PatternControls pattern={config.pattern} onChange={(pattern) => edit({ kind: 'pattern', pattern })} />}
        {config.kind === 'image' && <ImageControls image={config.image} busy={busy} inputError={imageError}
          onChange={(image) => edit({ kind: 'image', image })} onFile={loadFile} onRemove={removeImage} />}
        {convertible && (
          <details className="bg-advanced">
            <summary><ChevronRight size={14} className="bg-advanced-chev" aria-hidden /> Ajustes avanzados</summary>
            <div className="bg-advanced-body">
              <button type="button" className="btn" onClick={() => {
                const pattern = legacyToPattern(config);
                if (pattern) { edit({ kind: 'pattern', pattern }); heading.current?.focus({ preventScroll: true }); }
              }}><Sparkles size={14} aria-hidden /> {config.kind === 'original' ? 'Personalizar como patrón' : 'Editar como patrón'}</button>
            </div>
          </details>
        )}
      </fieldset>}

      <footer className="bg-footer">
        {error && <p id={`${uid}-error`} className="background-error" role="alert">{error}</p>}
        <div className="background-actions">
          {modified && <button type="button" className="btn" disabled={busy} onClick={restore}>
            <RotateCcw size={13} aria-hidden /> Restaurar valores del preset
          </button>}
          <div>
            <button type="button" className="btn" disabled={!dirty || busy} onClick={cancel}>Cancelar</button>
            <button type="button" className="btn btn-primary" disabled={!dirty || !complete || busy || !!naming} onClick={apply}>Aplicar</button>
          </div>
        </div>
        <p className="background-feedback" role="status">{status}</p>
        <details className="bg-advanced bg-preset-management" onToggle={(event) => {
          if (!event.currentTarget.open) { setNaming(null); setError(null); }
        }}>
          <summary><ChevronRight size={14} className="bg-advanced-chev" aria-hidden /> Gestionar presets</summary>
          <div className="bg-advanced-body">
            <div className="background-management-actions">
              <button type="button" className="btn" disabled={!complete || busy} onClick={() => { setNaming('new'); setName(''); setError(null); }}>
                <Plus size={14} aria-hidden /> Guardar como preset
              </button>
              {personal && <>
                <button type="button" className="btn" disabled={!complete || busy} onClick={() => { setNaming('edit'); setName(personal.name); setError(null); }}>Renombrar o actualizar</button>
                <button type="button" className="btn" disabled={busy} onClick={() => void removePreset(personal)}><Trash2 size={15} aria-hidden /> Eliminar preset</button>
              </>}
            </div>
            {naming && <form className="background-preset-form" onSubmit={savePreset}>
              <label>Nombre del preset<input ref={nameInput} type="text" className="input" required maxLength={MAX_PRESET_NAME} value={name} disabled={busy}
                aria-describedby={error ? `${uid}-error` : undefined}
                onChange={(event) => { setName(event.currentTarget.value); setError(null); }} /></label>
              <button type="button" className="btn" disabled={busy} onClick={() => {
                setNaming(null); setError(null); heading.current?.focus({ preventScroll: true });
              }}>Cancelar edición</button>
              <button type="submit" className="btn btn-primary" disabled={!name.trim() || !complete || busy}>{naming === 'edit' ? 'Actualizar' : 'Guardar'}</button>
            </form>}
          </div>
        </details>
      </footer>
    </section>
  );
}

function Gallery({ title, presets, active, draft, busy, intensity, onSelect, imageId }: {
  title: string;
  presets: readonly BackgroundPreset[];
  active: BackgroundSelection;
  draft: BackgroundSelection;
  busy: boolean;
  intensity: Intensity;
  onSelect: (preset: BackgroundPreset) => void;
  imageId?: string | null;
}) {
  return (
      <div className="background-gallery" role="group" aria-label={title}>
        {presets.map((preset) => <GalleryItem key={preset.id} preset={preset} active={active.presetId === preset.id} selected={draft.presetId === preset.id}
          busy={busy} intensity={intensity} imageId={preset.id === 'image' ? imageId : undefined} onSelect={() => onSelect(preset)} />)}
      </div>
  );
}

function GalleryItem({ preset, active, selected, busy, intensity, imageId, onSelect }: {
  preset: BackgroundPreset;
  active: boolean;
  selected: boolean;
  busy: boolean;
  intensity: Intensity;
  imageId?: string | null;
  onSelect: () => void;
}) {
  const config = preset.config;
  const thumbnail = useBackgroundImage(config.kind === 'image' ? imageId ?? backgroundImageId(config) : null, 'thumbnail');
  const uid = useId();
  const legacy = config.kind === 'waves' || config.kind === 'particles' || config.kind === 'ambient';
  return (
    <button type="button" className="background-preset" data-background-preset={preset.id} data-kind={config.kind} aria-pressed={selected}
      aria-labelledby={uid} aria-describedby={active ? `${uid}-state` : undefined} disabled={busy} onClick={onSelect}>
      <span className="background-preset-thumb" aria-hidden="true">
        {config.kind === 'pattern' ? (
          <PatternBackground pattern={config.pattern} surface="swatch" intensity={intensity} />
        ) : config.kind === 'image' ? (
          thumbnail.url ? <img alt="" decoding="async" src={thumbnail.url} /> : <ImageIcon size={18} />
        ) : legacy ? (
          <>
            <img alt="" decoding="async" src={`${import.meta.env.BASE_URL}backgrounds/${config.kind}.webp`} />
            {config.field.palette === 'fixed' && <span className="background-preset-swatch" style={{ backgroundColor: config.field.color }} />}
          </>
        ) : (
          <img alt="" decoding="async" src={`${import.meta.env.BASE_URL}backgrounds/${config.kind}.webp`} />
        )}
      </span>
      <span id={uid} className="background-preset-name">{preset.name}</span>
      {active && <span id={`${uid}-state`} className="background-preset-tick" data-tip="En uso"><Check size={11} aria-hidden="true" /><span className="sr-only">En uso</span></span>}
    </button>
  );
}
