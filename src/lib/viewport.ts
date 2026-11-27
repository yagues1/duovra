// Windows reports a tiny transient client area while the WebView is minimized.
// Keep the last usable logical dimensions until the native window is restored.
let stable = { width: 1360, height: 720 };
export function usableViewport() {
  return window.innerWidth >= 320 && window.innerHeight >= 200;
}
export function viewport() {
  if (usableViewport()) stable = { width: window.innerWidth, height: window.innerHeight };
  return stable;
}
export function installViewportGuard(root: HTMLElement) {
  const resize = () => {
    const { width, height } = viewport();
    if (usableViewport()) {
      root.style.removeProperty('width');
      root.style.removeProperty('height');
    } else {
      root.style.width = width + 'px';
      root.style.height = height + 'px';
    }
  };
  resize();
  window.addEventListener('resize', resize);
}
