import type { WidgetSession } from './model';

export const WIDGET_LANGUAGE = 'duovra-widget';

export type WidgetView = { source: string } & (
  | { session: WidgetSession; error?: never }
  | { session?: never; error: string }
);

export function widgetTitle(view: WidgetView) {
  return view.session?.definition.title ?? 'Widget interactivo';
}
