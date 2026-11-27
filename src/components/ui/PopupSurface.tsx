import { Component, Fragment, createRef, type ComponentPropsWithoutRef, type RefObject } from 'react';

type Props = ComponentPropsWithoutRef<'div'> & {
  elementRef: RefObject<HTMLDivElement | null>;
  open: boolean;
};
type Snapshot = {
  nodes: Node[];
  scroll: { element: Element; top: number; left: number }[];
  geometry: Record<string, string>;
};

// Captura el DOM antes de que React retire o actualice los hijos suscritos a
// Zustand. La copia solo vive durante la salida y no ejecuta efectos ni eventos.
export class PopupSurface extends Component<Props, object, Snapshot | null> {
  private frozenHost = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const root = this.props.elementRef.current;
    if (!previous.open || this.props.open || !root) return null;
    const style = getComputedStyle(root);
    const geometry = {
      width: style.width, height: style.height, left: style.left, top: style.top,
      'transform-origin': style.transformOrigin,
    };
    const scroll: Snapshot['scroll'] = [];
    // Los anillos de contexto y otras transiciones internas tampoco deben
    // reiniciar su animación al clonar el DOM durante la salida.
    const animated = new Map<Element, Set<string>>();
    for (const animation of root.getAnimations({ subtree: true })) {
      const effect = animation.effect;
      if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element) || effect.target === root) continue;
      const properties = animated.get(effect.target) ?? new Set<string>();
      for (const frame of effect.getKeyframes()) {
        for (const key of Object.keys(frame)) {
          if (['offset', 'computedOffset', 'easing', 'composite'].includes(key)) continue;
          properties.add(key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()));
        }
      }
      animated.set(effect.target, properties);
    }
    const copy = (node: Node) => {
      const clone = node.cloneNode(true);
      if (node instanceof Element && clone instanceof Element) {
        const originals = [node, ...node.querySelectorAll('*')];
        const copies = [clone, ...clone.querySelectorAll('*')];
        originals.forEach((source, index) => {
          const target = copies[index];
          if (source instanceof HTMLInputElement && target instanceof HTMLInputElement) {
            if (source.type !== 'file') target.value = source.value;
            target.checked = source.checked;
          }
          if (source instanceof HTMLTextAreaElement && target instanceof HTMLTextAreaElement) target.value = source.value;
          if (source instanceof HTMLSelectElement && target instanceof HTMLSelectElement) target.selectedIndex = source.selectedIndex;
          if (source.scrollTop || source.scrollLeft) scroll.push({ element: target, top: source.scrollTop, left: source.scrollLeft });
          const properties = animated.get(source);
          if (properties && (target instanceof HTMLElement || target instanceof SVGElement)) {
            const computed = getComputedStyle(source);
            target.style.setProperty('animation', 'none', 'important');
            target.style.setProperty('transition', 'none', 'important');
            for (const property of properties) target.style.setProperty(property, computed.getPropertyValue(property));
          }
          // Los identificadores HTML salientes no deben resolver aria-controls ni
          // colisionar con otro menú. Los IDs SVG internos conservan sus referencias.
          if (target instanceof HTMLElement) target.removeAttribute('id');
        });
      }
      return clone;
    };
    return { nodes: [...root.childNodes].filter(node => node !== this.frozenHost.current).map(copy), geometry, scroll };
  }

  componentDidUpdate(previous: Props, _state: object, snapshot: Snapshot | null) {
    const root = this.props.elementRef.current;
    const host = this.frozenHost.current;
    if (!root) return;
    if (this.props.open && !previous.open) {
      root.removeAttribute('data-frozen');
      for (const name of ['width', 'height', 'left', 'top', 'transform-origin']) root.style.removeProperty('--popup-frozen-' + name);
    } else if (snapshot && host) {
      for (const [name, value] of Object.entries(snapshot.geometry)) root.style.setProperty('--popup-frozen-' + name, value);
      root.setAttribute('data-frozen', '');
      host.replaceChildren(...snapshot.nodes);
      for (const { element, top, left } of snapshot.scroll) {
        element.scrollTop = top;
        element.scrollLeft = left;
      }
    }
  }

  render() {
    const { elementRef, open, children, ...props } = this.props;
    return <div ref={elementRef} {...props}>
      {open ? <Fragment key="live">{children}</Fragment>
        : <div key="frozen" ref={this.frozenHost} style={{ display: 'contents' }} aria-hidden="true" inert />}
    </div>;
  }
}
