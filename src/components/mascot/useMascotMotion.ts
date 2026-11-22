import { useEffect, useRef } from 'react';

const rootMotionAttributes = [
  'data-mascots', 'data-animations', 'data-intensity', 'data-field-quality', 'data-away', 'data-settings-open',
];

export function useMascotMotion(enabled: boolean) {
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = ref.current;
    if (!enabled || !svg) return;
    const hit = svg.querySelector<SVGRectElement>('.mascot-hit');
    if (!hit) return;

    const root = document.documentElement;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true;
    let frame = 0;
    let x = 0;
    let y = 0;

    const canFollow = () => {
      const { mascots, animations, intensity, fieldQuality, away, settingsOpen } = root.dataset;
      return svg.dataset.s === 'idle' && visible && !document.hidden && !reduced.matches
        && mascots === 'full' && animations !== 'off' && intensity !== 'reduced'
        && fieldQuality !== '3' && fieldQuality !== '4' && away === undefined
        && (settingsOpen === undefined || !svg.closest('.app-body'));
    };

    const rest = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      svg.style.removeProperty('--mascot-cursor-x');
      svg.style.removeProperty('--mascot-cursor-y');
    };

    const follow = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' && event.pointerType !== 'pen') return;
      if (!canFollow()) return;
      x = event.clientX;
      y = event.clientY;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!canFollow()) return;
        const bounds = hit.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        // Una muestra por fotograma de entrada. Las transiciones CSS se encargan de la inercia.
        const normalize = (offset: number, extent: number) => Math.max(-1, Math.min(1, offset * 2 / extent - 1));
        svg.style.setProperty('--mascot-cursor-x', normalize(x - bounds.left, bounds.width).toFixed(3));
        svg.style.setProperty('--mascot-cursor-y', normalize(y - bounds.top, bounds.height).toFixed(3));
      });
    };

    const refresh = () => {
      if (!svg.toggleAttribute('data-follow', canFollow())) rest();
    };
    const settings = new MutationObserver(refresh);
    settings.observe(root, { attributes: true, attributeFilter: rootMotionAttributes });
    settings.observe(svg, { attributes: true, attributeFilter: ['data-s'] });
    const visibility = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      svg.toggleAttribute('data-outside', !visible);
      refresh();
    });
    visibility.observe(svg);
    refresh();
    reduced.addEventListener('change', refresh);
    svg.addEventListener('pointermove', follow, { passive: true });
    svg.addEventListener('pointerleave', rest);
    svg.addEventListener('pointercancel', rest);
    return () => {
      visibility.disconnect();
      settings.disconnect();
      reduced.removeEventListener('change', refresh);
      svg.removeEventListener('pointermove', follow);
      svg.removeEventListener('pointerleave', rest);
      svg.removeEventListener('pointercancel', rest);
      svg.removeAttribute('data-outside');
      svg.removeAttribute('data-follow');
      rest();
    };
  }, [enabled]);

  return ref;
}
