import { invoke, isTauri } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { errorText } from './ipc';

export const BACKGROUND_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';
export const BACKGROUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

export async function importBackgroundImage(file: File): Promise<string> {
  if (file.size > BACKGROUND_IMAGE_MAX_BYTES) throw new Error('La imagen supera el límite de 8 MB.');
  if (file.size === 0) throw new Error('Selecciona un archivo PNG, JPEG o WebP válido.');
  if (!isTauri()) throw new Error('Abre Duovra para importar una imagen de fondo.');
  return invoke<string>('background_image_import', await file.arrayBuffer());
}

export async function releaseBackgroundImages(ids: readonly string[]): Promise<void> {
  if (!ids.length || !isTauri()) return;
  await invoke('background_images_release', { ids: [...new Set(ids)] });
}

export function useBackgroundImage(id: string | null, size: 'display' | 'thumbnail' = 'display'): { url: string | null; error: string | null } {
  const generation = useRef(0);
  const [result, setResult] = useState<{ generation: number; id: string; size: typeof size; url: string | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!id) return;
    const request = ++generation.current;
    let url: string | undefined;
    void invoke<ArrayBuffer | number[]>('background_image_read', { id, thumbnail: size === 'thumbnail' }).then((data) => {
      if (request !== generation.current) return;
      const buffer = Array.isArray(data) ? new Uint8Array(data) : data;
      url = URL.createObjectURL(new Blob([buffer], { type: 'image/webp' }));
      setResult({ generation: request, id, size, url, error: null });
    }).catch((error: unknown) => {
      if (request === generation.current) setResult({ generation: request, id, size, url: null, error: errorText(error) });
    });
    return () => {
      generation.current++;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, size]);

  return result?.id === id && result.size === size && result.generation === generation.current
    ? result : { url: null, error: null };
}
