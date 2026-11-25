import { ArrowUpRight, Heart } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getLocale, tr, useTr } from '../../i18n';
import { supportUrl } from '../../lib/support';

/** Abre el apartado de apoyo de la web oficial en el idioma actual. Nada más: sin ventanas internas. */
function openSupport() {
  void openUrl(supportUrl(getLocale())).catch(() => undefined);
}

export function SupportLink({ rail = false }: { rail?: boolean }) {
  useTr();
  const label = tr('Apoyar Duovra');
  const hint = tr('Se abre en el navegador');
  if (rail) {
    return (
      <button type="button" className="rail-btn support-rail" data-support-link aria-label={`${label} (${hint})`}
        data-tip={label} data-tip-side="right" onClick={openSupport}>
        <Heart className="support-heart" size={17} strokeWidth={1.7} aria-hidden />
      </button>
    );
  }
  return (
    <button type="button" className="support-link" data-support-link aria-label={`${label} (${hint})`} onClick={openSupport}>
      <Heart className="support-heart" size={16} strokeWidth={1.7} aria-hidden />
      <span className="truncate">{label}</span>
      <ArrowUpRight className="support-arrow" size={14} strokeWidth={1.7} aria-hidden />
    </button>
  );
}
