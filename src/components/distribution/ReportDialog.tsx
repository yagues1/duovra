import { ExternalLink, Send } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { distribution, type DistributionInfo } from '../../lib/distribution';
import { errorText } from '../../lib/ipc';
import { CATEGORIES, confirmedReport, invalidField, ISSUE_BASE, issueBody, MAX_CAPTURE_BYTES, normalizeDraft, REPORT_LIMITS, type ReportDraft } from '../../lib/report';
import { GlassDialog } from './GlassDialog';

const EMPTY: ReportDraft = { title: '', description: '', steps: '', expected: '', category: 'funcional', consent: false };
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
  const [draft, setDraft] = useState(EMPTY);
  const [invalid, setInvalid] = useState<keyof ReportDraft>();
  const [capture, setCapture] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [issue, setIssue] = useState<number>();
  const [locked, setLocked] = useState(false);
  const [handoff, setHandoff] = useState<{ body: string; paste: boolean }>();
  const reportId = useRef(crypto.randomUUID());
  const pending = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const receiptRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (issue) receiptRef.current?.focus();
  }, [issue]);

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
    pending.current = true;
    setBusy(true);
    setError('');
    setHandoff(undefined);
    const id = reportId.current;
    const report = { ...clean, id, version: info.version, platform: info.platform, capture: capture?.split(',')[1] };
    try {
      if (info.reportingEnabled) {
        setLocked(true);
        const receipt = await distribution.submitReport(report);
        if (!confirmedReport(receipt, id)) throw new Error('El servicio devolvió una confirmación no válida.');
        setIssue(receipt.issueNumber);
      } else {
        const body = issueBody(report, new Date().toISOString());
        const url = new URL(`${ISSUE_BASE}/new`);
        url.searchParams.set('title', report.title);
        url.searchParams.set('body', body);
        const paste = url.href.length > 7500;
        if (paste) url.searchParams.delete('body');
        setHandoff({ body, paste });
        await openUrl(url.href);
      }
    } catch (cause) {
      setError(`${info.reportingEnabled ? 'Incidencia sin confirmar.' : 'No se pudo abrir GitHub.'} ${errorText(cause)}`);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  return (
    <GlassDialog title="Reportar un error" onClose={dismiss} busy={busy}>
      {issue ? (
        <div className="studio-dialog-body">
          <p role="status" ref={receiptRef} tabIndex={-1}>Reporte recibido. GitHub confirmó la incidencia #{issue}.</p>
          <p className="studio-dialog-note selectable">ID {reportId.current}</p>
          <button type="button" className="btn btn-primary" data-dialog-focus onClick={onClose}>Cerrar reporte</button>
        </div>
      ) : (
        <form className="studio-dialog-body report-form" noValidate onSubmit={(event) => void submit(event)}>
          <p className="studio-dialog-note">Describe el problema con tus propias palabras. Revisa que el texto y la captura estén libres de datos personales.</p>
          <p className="studio-report-meta"><span>Versión {info?.version ?? '…'}</span><span>{info?.platform ?? 'Cargando plataforma…'}</span></p>
          {info && !info.reportingEnabled && <p className="studio-dialog-note">GitHub abrirá el borrador. Para enviarlo, inicia sesión con acceso al repositorio y confirma allí. Puedes adjuntar la captura desde GitHub.</p>}
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
            {info?.reportingEnabled && (
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
          <p role="alert" id={`${uid}-error`} className="studio-error">{error}</p>
          <p role="status" className="studio-dialog-note">{busy ? 'Preparando el reporte…' : handoff && !error ? 'Borrador abierto en GitHub. Completa el envío en el navegador.' : ''}</p>
          {handoff?.paste && <label className="studio-field">Copia este texto en el borrador de GitHub<textarea className="studio-input" rows={3} readOnly value={handoff.body} /></label>}
          <div className="studio-dialog-actions">
            <button type="button" className="btn" onClick={dismiss} disabled={busy}>Cerrar</button>
            <button className="btn btn-primary" disabled={!info || busy || preparing}>
              {info?.reportingEnabled ? <Send size={14} aria-hidden /> : <ExternalLink size={14} aria-hidden />}
              {info?.reportingEnabled ? locked ? 'Reintentar el envío' : 'Enviar reporte' : 'Abrir borrador en GitHub'}
            </button>
          </div>
        </form>
      )}
    </GlassDialog>
  );
}
