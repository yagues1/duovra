import { Check } from 'lucide-react';
import { effortLabel } from '../../lib/format';

/**
 * Menú de esfuerzo con la misma anatomía que el selector de modelos: una fila por nivel, solo los
 * que admite el modelo elegido, check en el actual y cierre al elegir. El Popover (role="menu")
 * aporta flechas, Inicio/Fin, Tab y Escape; el foco empieza en el nivel seleccionado.
 */
export function EffortMenu({ efforts, value, defaultEffort, onSelect }: {
  efforts: string[];
  value: string | null;
  defaultEffort?: string | null;
  onSelect: (effort: string) => void;
}) {
  return (
    <div className="mp effort-menu">
      <div className="mp-head" role="presentation">Esfuerzo</div>
      <div className="mp-list">
        {efforts.map((effort) => {
          const selected = effort === value;
          return (
            <button key={effort} type="button" role="menuitemradio" aria-checked={selected} tabIndex={-1}
              className="mp-model effort-row" data-selected={selected || undefined} onClick={() => onSelect(effort)}>
              <span className="mp-check" aria-hidden>{selected && <Check size={14} />}</span>
              <span className="mp-model-name">{effortLabel(effort)}</span>
              {effort === defaultEffort && <span className="effort-default">Predeterminado</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
