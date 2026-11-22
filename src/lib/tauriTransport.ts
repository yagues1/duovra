import { invoke as nativeInvoke } from '@tauri-apps/api/core';
import { listen as nativeListen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';

type EventHandler = (event: { payload: unknown }) => void;
type FixtureInvoke = (command: string, args?: Record<string, unknown>) => unknown;
let fixtures: FixtureInvoke | undefined;
const listeners = new Map<string, Set<EventHandler>>();

/** El frontend QA puede ejercitar el mismo store dentro de WebView2 con eventos locales. */
export function installFixtureTransport(invoke: FixtureInvoke) {
  fixtures = invoke;
}

export function emitFixture(event: string, payload: unknown) {
  listeners.get(event)?.forEach((handler) => handler({ payload }));
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return fixtures ? Promise.resolve().then(() => fixtures!(command, args) as T) : nativeInvoke<T>(command, args);
}

export async function listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn> {
  if (!fixtures) return nativeListen<T>(event, handler);
  const group = listeners.get(event) ?? new Set<EventHandler>();
  const fn = handler as EventHandler;
  group.add(fn);
  listeners.set(event, group);
  return () => { group.delete(fn); };
}
