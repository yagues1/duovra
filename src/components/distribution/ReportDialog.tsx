import { CheckCircle2, Send, TriangleAlert } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { distribution, type DistributionInfo } from '../../lib/distribution';
import { errorText } from '../../lib/ipc';
import { CATEGORIES, confirmedReport, invalidField, MAX_CAPTURE_BYTES, normalizeDraft, REPORT_LIMITS, type ReportDraft } from '../../lib/report';
import { useStore } from '../../state/store';
import { GlassDialog } from './GlassDialog';

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

  return (
    <GlassDialog title="Reportar un error" onClose={dismiss} busy={busy}>
      {issue ? (
        <div className="studio-dialog-body">
          <div className="report-success">
            <span className="report-success-badge" aria-hidden><CheckCircle2 size={26} /></span>
            <h3 role="status" ref={receiptRef} tabIndex={-1}>Reporte enviado · n.º {issue}</h3>
            <p className="studio-dialog-note">Se ha recibido de forma privada. Gracias por ayudar a mejorar Duovra.</p>
            <p className="studio-dialog-note selectable">Identificador {reportId.current}</p>
          </div>
          <div className="studio-dialog-actions">
            <button type="button" className="btn btn-primary" data-dialog-focus onClick={onClose}>Cerrar</button>
          </div>
        </div>
      ) : (
        <form className="studio-dialog-body report-form" noValidate onSubmit={(event) => void submit(event)}>
          <p className="studio-dialog-note">Describe el problema con tus propias palabras. Revisa que el texto y la captura estén libres de datos personales.</p>
          <p className="studio-report-meta"><span>Versión {info?.version ?? '…'}</span><span>{info?.platform ?? 'Cargando plataforma…'}</span></p>
          {info && !info.reportingEnabled && (
            <div className="report-service" role="note">
              <TriangleAlert size={16} aria-hidden style={{ flexShrink: 0, color: 'var(--warning)', marginTop: 1 }} />
              <span><strong>Servicio de envío no configurado.</strong> Esta compilación no incluye la dirección del servicio de reportes, así que todavía no puede enviarlos. Puedes escribir el reporte: el borrador se guarda en este equipo y podrás enviarlo cuando instales una versión con el servicio activo.</span>
            </div>
          )}
          <fieldset disabled={busy || locked}>
            <div className="studio-report-row">
              <label className="studio-field" htmlFor={`${uid}-title`}>
                {FIELDS.title}
                <input id={`${uid}-title`} data-dialog-focus className="studio-input" required maxLength={REPORT_LIMITS.title} value={draft.title} aria-invalid={invalid === 'title' || undefined} aria-describedby={invalid === 'title' ? `${uid}-error` : undefined} onChange={(e) => update('title', e.target.value)} />
              </label>
              <label className="studio-field" htmlFor={`${uid}-category`}>
                Categoría
                <select id={`${uid}-category`} className="studio-input" value={draft.category} onChange={(e) => update('category', e.target.value as ReportDraft['category'])}>
                  {Object.entries(CATEGORIES).map(([key, name]) => <option value={key} key={key}>{name}</option>)}
                </select>
              </label>
            </div>
            {(['description', 'steps', 'expected'] as const).map((field) => (
              <label className="studio-field" key={field} htmlFor={`${uid}-${field}`}>
                {FIELDS[field]}
                <textarea id={`${uid}-${field}`} className="studio-input" required={field !== 'expected'} rows={2} maxLength={REPORT_LIMITS[field]} value={draft[field]} aria-invalid={invalid === field || undefined} aria-describedby={invalid === field ? `${uid}-error` : undefined} onChange={(e) => update(field, e.target.value)} />
              </label>
            ))}
            {(
              <div className="studio-field">
                <label htmlFor={`${uid}-capture`}>Captura (opcional)</label>
                <input id={`${uid}-capture`} className="studio-input" ref={fileRef} type="file" accept="image/png,image/jpeg" aria-describedby={`${uid}-capture-note`} onChange={async (event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
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
                }} disabled={preparing} />
                <span id={`${uid}-capture-note`} className="studio-dialog-note">La captura se guarda de forma privada. Revísala antes de autorizar su envío.</span>
                {capture && <div className="studio-capture"><img src={capture} alt="Vista previa de la captura que se adjuntará" /><button type="button" className="btn" onClick={() => {
                  setCapture(undefined);
                  update('consent', false);
                  if (fileRef.current) {
                    fileRef.current.value = '';
                    fileRef.current.focus();
                  }
                }}>Quitar captura</button></div>}
                {captureError && <span className="studio-error" role="alert">{captureError}</span>}
              </div>
            )}
            <label className="studio-consent">
              <input id={`${uid}-consent`} type="checkbox" required checked={draft.consent} aria-invalid={invalid === 'consent' || undefined} aria-describedby={invalid === 'consent' ? `${uid}-error` : undefined} onChange={(e) => update('consent', e.target.checked)} />
              <span>Autorizo compartir el contenido del reporte, su versión, plataforma, ID y fecha{capture ? ', y la captura seleccionada' : ''}.</span>
            </label>
          </fieldset>
          <details className="report-preview">
            <summary>Qué se enviará</summary>
            <dl>
              <dt>Título</dt><dd>{draft.title.trim() || '—'}</dd>
              <dt>Categoría</dt><dd>{CATEGORIES[draft.category]}</dd>
              <dt>Texto</dt><dd>Descripción, pasos{draft.expected.trim() ? ' y resultado esperado' : ''}, con correos, tokens y rutas de usuario ocultados automáticamente.</dd>
              <dt>Versión</dt><dd>{info?.version ?? '…'}</dd>
              <dt>Sistema</dt><dd>{info?.platform ?? '…'}</dd>
              <dt>Identificador</dt><dd className="selectable">{reportId.current}</dd>
              <dt>Fecha</dt><dd>Hora de recepción (UTC)</dd>
              <dt>Captura</dt><dd>{capture ? 'Sí, guardada de forma privada' : 'No'}</dd>
              <dt>No se envía</dt><dd>Conversaciones, código, rutas, credenciales ni registros.</dd>
            </dl>
          </details>
          <p role="alert" id={`${uid}-error`} className="studio-error">{error}</p>
          <p role="status" className="studio-dialog-note">{busy ? 'Enviando el reporte de forma segura…' : ''}</p>
          <div className="studio-dialog-actions">
            <button type="button" className="btn" onClick={dismiss} disabled={busy}>Cerrar</button>
            <button className="btn btn-primary" disabled={!info || busy || preparing || !info.reportingEnabled} aria-busy={busy || undefined}>
              <Send size={14} aria-hidden />
              {busy ? 'Enviando…' : error && info?.reportingEnabled ? 'Reintentar el envío' : 'Enviar reporte'}
            </button>
          </div>
        </form>
      )}
    </GlassDialog>
  );
}
