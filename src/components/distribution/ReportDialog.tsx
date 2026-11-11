import { Check, CheckCircle2, ImagePlus, Loader2, Send, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { distribution, type DistributionInfo } from '../../lib/distribution';
import { errorText } from '../../lib/ipc';
import { CATEGORIES, confirmedReport, invalidField, MAX_CAPTURE_BYTES, normalizeDraft, REPORT_LIMITS, type ReportDraft } from '../../lib/report';
import { useStore } from '../../state/store';
import { GlassDialog } from './GlassDialog';
import { Select } from '../ui/Controls';

const EMPTY: ReportDraft = { title: '', description: '', steps: '', expected: '', category: 'funcional', consent: false };
/** Borrador local (solo texto y categoría; nunca la captura ni el consentimiento). */
const DRAFT_KEY = 'report.draft';

function savedDraft(): ReportDraft {
  const raw = useStore.getState().settings[DRAFT_KEY] as Partial<ReportDraft> | undefined;
  if (!raw || typeof raw !== 'object') return EMPTY;
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    title: text(raw.title, REPORT_LIMITS.title),
    description: text(raw.description, REPORT_LIMITS.description),
    steps: text(raw.steps, REPORT_LIMITS.steps),
    expected: text(raw.expected, REPORT_LIMITS.expected),
    category: raw.category && Object.hasOwn(CATEGORIES, raw.category) ? raw.category : 'funcional',
    consent: false,
  };
}
const FIELDS = {
  title: 'Título del problema',
  description: 'Descripción',
  steps: 'Pasos para reproducirlo',
  expected: 'Resultado esperado (opcional)',
};

async function prepareCapture(file: File) {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 8_000_000) throw new Error('Elige una imagen PNG o JPEG de hasta 8 MB.');
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d', { alpha: false });
  try {
    if (!ctx) throw new Error('No se pudo preparar la imagen.');
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close();
  }
  const image = canvas.toDataURL('image/jpeg', 0.82);
  if (!image.startsWith('data:image/jpeg;base64,') || image.length > MAX_CAPTURE_BYTES / 3 * 4) throw new Error('La captura preparada supera 1 MB.');
  return image;
}

export function ReportDialog({ info, onClose }: { info?: DistributionInfo; onClose: () => void }) {
  const uid = useId();
  const [draft, setDraft] = useState(savedDraft);
  const [invalid, setInvalid] = useState<keyof ReportDraft>();
  const [capture, setCapture] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issue, setIssue] = useState<number>();
  const [locked, setLocked] = useState(false);
  const reportId = useRef(crypto.randomUUID());
  const pending = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (issue) receiptRef.current?.focus();
  }, [issue]);

  // El borrador sobrevive a cerrar el formulario, a un fallo de red y a reiniciar Duovra.
  useEffect(() => {
    if (issue) return;
    const t = window.setTimeout(() => {
      const { consent: _consent, ...text } = draft;
      void useStore.getState().setSetting(DRAFT_KEY, text);
    }, 500);
    return () => window.clearTimeout(t);
  }, [draft, issue]);

  function update<K extends keyof ReportDraft>(field: K, value: ReportDraft[K]) {
    setDraft((old) => ({ ...old, [field]: value, consent: field === 'consent' ? value === true : false }));
    if (invalid === field) {
      setInvalid(undefined);
      setError('');
    }
  }

  function dismiss() {
    if (!pending.current) onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || preparing || !info) return;
    const clean = normalizeDraft(draft);
    const field = invalidField(draft) ?? invalidField(clean);
    if (field) {
      setInvalid(field);
      setError(field === 'consent' ? 'Confirma tu consentimiento para continuar.' : 'Revisa el campo indicado. El texto debe ser válido y respetar el límite.');
      document.getElementById(`${uid}-${field}`)?.focus();
      return;
    }
    if (!info.reportingEnabled) {
      setError('El servicio de reportes no está configurado en esta compilación. Tu borrador queda guardado en este equipo.');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    const id = reportId.current;
    const report = { ...clean, id, version: info.version, platform: info.platform, capture: capture?.split(',')[1] };
    try {
      // El ID se conserva entre reintentos: el servicio no crea duplicados.
      setLocked(true);
      const receipt = await distribution.submitReport(report);
      if (!confirmedReport(receipt, id)) throw new Error('El servicio devolvió una confirmación no válida.');
      setIssue(receipt.issueNumber);
      void useStore.getState().setSetting(DRAFT_KEY, null);
    } catch (cause) {
      setLocked(false);
      setError(`El reporte no se ha enviado. ${errorText(cause)} Tu texto se conserva: puedes reintentar.`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  async function pickCapture(file: File | undefined, input: HTMLInputElement) {
    if (!file) return;
    setPreparing(true);
    setCaptureError('');
    setCapture(undefined);
    update('consent', false);
    try {
      setCapture(await prepareCapture(file));
    } catch (cause) {
      input.value = '';
      setCaptureError(errorText(cause));
    } finally {
      setPreparing(false);
    }
  }

  function removeCapture() {
    setCapture(undefined);
    update('consent', false);
    if (fileRef.current) fileRef.current.value = '';
    requestAnimationFrame(() => document.getElementById(`${uid}-capture`)?.focus());
  }

  const meta = (
    <>
      <span>Duovra {info?.version ?? '…'}</span>
      <span aria-hidden>·</span>
      <span>{info?.platform ?? 'Windows'}</span>
    </>
  );
  const unavailable = !!info && !info.reportingEnabled;

  return (
    <GlassDialog title="Reportar un error" subtitle={meta} className="report-dialog" onClose={dismiss} busy={busy}>
      {issue ? (
        <div className="report-form">
          <div className="report-scroll">
            <div className="report-success">
              <span className="report-success-badge" aria-hidden><CheckCircle2 size={26} /></span>
              <h3 role="status" ref={receiptRef} tabIndex={-1}>Reporte recibido · n.º {issue}</h3>
              <p className="studio-dialog-note">Se ha registrado de forma privada. Gracias por ayudar a mejorar Duovra.</p>
              <p className="report-receipt selectable">{reportId.current}</p>
            </div>
          </div>
          <div className="report-footer">
            <span className="flex-1" />
            <button type="button" className="btn btn-primary" data-dialog-focus onClick={onClose}>Cerrar</button>
          </div>
        </div>
      ) : (
        <form className="report-form" noValidate onSubmit={(event) => void submit(event)}>
          <div className="report-scroll">
            <p className="report-intro">Cuéntanos qué ha pasado. Correos, tokens y rutas de usuario se ocultan automáticamente.</p>
            <fieldset disabled={busy || locked}>
              <div className="studio-report-row">
                <div className="studio-field">
                  <label htmlFor={`${uid}-title`}>{FIELDS.title}</label>
                  <input id={`${uid}-title`} data-dialog-focus className="studio-input" required maxLength={REPORT_LIMITS.title} value={draft.title} placeholder="Resumen breve" aria-invalid={invalid === 'title' || undefined} aria-describedby={invalid === 'title' ? `${uid}-error` : undefined} onChange={(e) => update('title', e.target.value)} />
                </div>
                <div className="studio-field">
                  <label htmlFor={`${uid}-category`}>Categoría</label>
                  <Select id={`${uid}-category`} label="Categoría" className="report-category" align="start" value={draft.category}
                    onChange={(v) => update('category', v as ReportDraft['category'])}
                    options={Object.entries(CATEGORIES).map(([value, label]) => ({ value, label }))} />
                </div>
              </div>
              {(['description', 'steps', 'expected'] as const).map((field) => (
                <div className="studio-field" key={field}>
                  <label htmlFor={`${uid}-${field}`}>{FIELDS[field]}</label>
                  <textarea id={`${uid}-${field}`} className="studio-input" required={field !== 'expected'} rows={field === 'expected' ? 2 : 3} maxLength={REPORT_LIMITS[field]} value={draft[field]} aria-invalid={invalid === field || undefined} aria-describedby={invalid === field ? `${uid}-error` : undefined} onChange={(e) => update(field, e.target.value)} />
                </div>
              ))}
              <div className="studio-field">
                <span>Captura (opcional)</span>
                <input ref={fileRef} type="file" accept="image/png,image/jpeg" className="sr-only" tabIndex={-1} aria-hidden onChange={(event) => void pickCapture(event.currentTarget.files?.[0], event.currentTarget)} />
                {capture ? (
                  <div className="report-capture">
                    <img src={capture} alt="Vista previa de la captura que se adjuntará" />
                    <div className="min-w-0 flex-1">
                      <div className="report-capture-title">Captura preparada</div>
                      <div className="studio-dialog-note">JPEG sin metadatos. Se guarda de forma privada.</div>
                    </div>
                    <button type="button" id={`${uid}-capture`} className="btn-icon" aria-label="Quitar la captura" data-tip="Quitar la captura" onClick={removeCapture}><X size={15} /></button>
                  </div>
                ) : (
                  <button type="button" id={`${uid}-capture`} className="report-drop" disabled={preparing} onClick={() => fileRef.current?.click()}>
                    {preparing ? <Loader2 size={17} className="animate-spin" aria-hidden /> : <ImagePlus size={17} aria-hidden />}
                    <span className="min-w-0">
                      <span className="report-drop-title">{preparing ? 'Preparando la captura…' : 'Añadir una captura'}</span>
                      <span className="report-drop-note">PNG o JPEG · solo se envía si lo autorizas</span>
                    </span>
                  </button>
                )}
                {captureError && <span className="studio-error" role="alert">{captureError}</span>}
              </div>
              <details className="report-preview">
                <summary>Qué se enviará</summary>
                <dl>
                  <dt>Título</dt><dd>{draft.title.trim() || '—'}</dd>
                  <dt>Categoría</dt><dd>{CATEGORIES[draft.category]}</dd>
                  <dt>Texto</dt><dd>Descripción, pasos{draft.expected.trim() ? ' y resultado esperado' : ''}, con datos sensibles ocultados.</dd>
                  <dt>Sistema</dt><dd>Duovra {info?.version ?? '…'} · {info?.platform ?? '…'}</dd>
                  <dt>Identificador</dt><dd className="selectable">{reportId.current}</dd>
                  <dt>Captura</dt><dd>{capture ? 'Sí, privada' : 'No'}</dd>
                  <dt>No se envía</dt><dd>Conversaciones, código, rutas, credenciales ni registros.</dd>
                </dl>
              </details>
              <label className="report-consent">
                <input id={`${uid}-consent`} type="checkbox" required checked={draft.consent} aria-invalid={invalid === 'consent' || undefined} aria-describedby={invalid === 'consent' ? `${uid}-error` : undefined} onChange={(e) => update('consent', e.target.checked)} />
                <span className="report-check" aria-hidden><Check size={12} strokeWidth={3} /></span>
                <span>Autorizo enviar este reporte{capture ? ' y la captura' : ''}, con la versión, la plataforma, el identificador y la fecha.</span>
              </label>
            </fieldset>
            {(error || unavailable) && (
              <div role="alert" id={`${uid}-error`} className="report-alert">
                <TriangleAlert size={15} aria-hidden />
                <span>{error || 'Esta compilación no puede enviar reportes. Tu borrador se guarda en este equipo.'}</span>
              </div>
            )}
          </div>
          <div className="report-footer">
            <span role="status" className="report-status">
              {busy && <><Loader2 size={14} className="animate-spin" aria-hidden /> Enviando de forma segura…</>}
            </span>
            <button type="button" className="btn" onClick={dismiss} disabled={busy}>Cancelar</button>
            <button className="btn btn-primary" disabled={!info || busy || preparing || unavailable} aria-busy={busy || undefined}>
              <Send size={14} aria-hidden />
              {busy ? 'Enviando…' : error && !unavailable ? 'Reintentar' : 'Enviar reporte'}
            </button>
          </div>
        </form>
      )}
    </GlassDialog>
  );
}
