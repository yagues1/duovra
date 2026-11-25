import { motion } from 'motion/react';
import { ChevronDown, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Popover, MenuItem } from '../ui/Popover';
import { fitTabs, type TabFit } from '../../lib/workbenchTabs';
import { getLocale, tr } from '../../i18n';

export interface WorkbenchTabItem {
  id: string | null;
  title: string;
  kind: string;
  /** Pestaña abierta desde la conversación (archivo, diff, salida…); las vistas fijas no la tienen. */
  opened: boolean;
  description?: string;
}

interface Props {
  baseId: string;
  items: WorkbenchTabItem[];
  active: string | null;
  icons: Record<string, LucideIcon>;
  changeCount: number;
  listRef: RefObject<HTMLDivElement | null>;
  select: (id: string | null) => void;
  close: (id: string) => void;
  focusActive: () => void;
}

const FULL: TabFit = { compact: 'none', shown: [], hidden: [] };

/**
 * Barra de pestañas de Workbench. Mide el ancho natural de cada pestaña en una fila invisible y
 * decide cómo mostrarlas (ver `fitTabs`): nunca hay desplazamiento horizontal ni pestañas cortadas.
 */
export function WorkbenchTabs({ baseId, items, active, icons, changeCount, listRef, select, close, focusActive }: Props) {
  const bar = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const overflowButton = useRef<HTMLButtonElement>(null);
  const [fit, setFit] = useState<TabFit>(() => ({ ...FULL, shown: items.filter((i) => i.opened).map((_, n) => n) }));
  const [menu, setMenu] = useState(false);
  const fixed = items.filter((i) => !i.opened);
  const opened = items.filter((i) => i.opened);
  const activeIndex = items.findIndex((i) => i.id === active);
  const key = `${items.map((i) => `${i.id}:${i.title}`).join('|')}#${changeCount}#${getLocale()}`;

  useLayoutEffect(() => {
    const host = bar.current;
    const row = measure.current;
    if (!host || !row) return;
    const compute = () => {
      const cells = [...row.children] as HTMLElement[];
      const width = (el: Element | null | undefined) => el?.getBoundingClientRect().width ?? 0;
      const fixedW = cells.slice(0, fixed.length).map(width);
      const openedW = cells.slice(fixed.length, fixed.length + opened.length).map((el) => Math.ceil(width(el)));
      const icon = width(row.querySelector('[data-measure="icon"]'));
      const overflow = width(row.querySelector('[data-measure="overflow"]'));
      const style = getComputedStyle(host);
      const available = host.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const next = fitTabs(available, { fixed: fixedW.map(Math.ceil), icon: Math.ceil(icon), opened: openedW, overflow: Math.ceil(overflow), gap: 2, separator: 7 }, activeIndex);
      setFit((prev) => (prev.compact === next.compact && prev.shown.join() === next.shown.join() && prev.hidden.join() === next.hidden.join() ? prev : next));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(host);
    return () => observer.disconnect();
    // `key` resume títulos, número de pestañas, insignia e idioma: lo que cambia los anchos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, activeIndex]);

  const hiddenItems = fit.hidden.map((i) => opened[i]).filter(Boolean);
  if (menu && !hiddenItems.length) setMenu(false);
  const visible = [...fixed, ...fit.shown.map((i) => opened[i]).filter(Boolean)];
  const compactFixed = (item: WorkbenchTabItem) => !item.opened && (fit.compact === 'all' || (fit.compact === 'inactive' && item.id !== active));

  const renderTab = (item: WorkbenchTabItem, i: number, measuring = false) => {
    const Icon = icons[item.kind];
    const on = !measuring && item.id === active;
    const compact = !measuring && compactFixed(item);
    const badge = item.id === 'git' && changeCount > 0 && <span className="panel-tab-badge"
      aria-label={changeCount === 1 ? tr('1 archivo cambiado') : tr('{n} archivos cambiados', { n: changeCount })}>{changeCount}</span>;
    if (measuring) {
      return <span key={item.id ?? 'overview'} className="panel-tab" data-opened={item.opened || undefined}>
        <Icon size={13} aria-hidden /><span className="panel-tab-label">{item.title}</span>{badge}
      </span>;
    }
    const firstOpened = item.opened && visible.findIndex((v) => v.opened) === i;
    return (
      <button
        key={item.id ?? 'overview'}
        id={`${baseId}-tab-${items.indexOf(item)}`}
        role="tab"
        tabIndex={on ? 0 : -1}
        aria-selected={on}
        aria-label={compact ? item.title : undefined}
        aria-description={item.description}
        aria-controls={`${baseId}-view`}
        className="panel-tab"
        data-opened={item.opened || undefined}
        data-first-opened={firstOpened || undefined}
        data-compact={compact || undefined}
        data-tip={compact ? item.title : item.opened ? item.description ?? item.title : undefined}
        data-tip-truncated={!compact && item.opened && !item.description ? true : undefined}
        data-tip-side="bottom"
        onClick={() => select(item.id)}
        onKeyDown={(event) => {
          if (event.key === 'Delete' && item.opened && item.id) {
            event.preventDefault();
            close(item.id);
            focusActive();
            return;
          }
          const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
            : offset ? (i + offset + visible.length) % visible.length : -1;
          if (next < 0) return;
          event.preventDefault();
          select(visible[next].id);
          focusActive();
        }}
      >
        {on && <motion.span layoutId={baseId + '-pill'} className="panel-tab-pill" aria-hidden
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }} />}
        <Icon size={13} aria-hidden />
        <span className="panel-tab-label">{item.title}</span>
        {badge}
      </button>
    );
  };

  return (
    <div ref={bar} className="panel-tabbar">
      <div ref={listRef} className="panel-tabs" role="tablist" aria-label={tr('Vistas de Workbench')}>
        {visible.map((item, i) => renderTab(item, i))}
      </div>
      {hiddenItems.length > 0 && <>
        <button ref={overflowButton} type="button" className="panel-tabs-more" aria-haspopup="menu" aria-expanded={menu}
          aria-label={tr('{n} pestañas más', { n: hiddenItems.length })} data-tip={tr('{n} pestañas más', { n: hiddenItems.length })}
          onClick={() => setMenu((open) => !open)}>
          <span className="font-mono">+{hiddenItems.length}</span><ChevronDown size={12} aria-hidden />
        </button>
        <Popover open={menu} onClose={() => setMenu(false)} anchor={overflowButton.current} placement="bottom-end" width={260}
          ariaLabel={tr('Pestañas abiertas')}>
          {hiddenItems.map((item) => {
            const Icon = icons[item.kind];
            return <MenuItem key={item.id} icon={<Icon size={14} />} label={item.title}
              onSelect={() => { setMenu(false); select(item.id); focusActive(); }} />;
          })}
        </Popover>
      </>}
      {/* Fila de medida: mismas clases, invisible y fuera del flujo. */}
      <div ref={measure} className="panel-tabs-measure" aria-hidden>
        {items.map((item, i) => renderTab(item, i, true))}
        <span className="panel-tab" data-measure="icon"><ChevronDown size={13} aria-hidden /></span>
        <span className="panel-tabs-more" data-measure="overflow"><span className="font-mono">+{Math.max(2, opened.length)}</span><ChevronDown size={12} aria-hidden /></span>
      </div>
    </div>
  );
}
