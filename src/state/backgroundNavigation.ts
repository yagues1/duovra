let guard: ((confirmLabel: string) => Promise<boolean> | undefined) | undefined;

export function registerBackgroundNavigation(check: NonNullable<typeof guard>) {
  guard = check;
  return () => {
    if (guard === check) guard = undefined;
  };
}

export function confirmBackgroundNavigation(confirmLabel = 'Salir de Apariencia') {
  return guard?.(confirmLabel);
}
