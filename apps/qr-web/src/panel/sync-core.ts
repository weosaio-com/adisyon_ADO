import type { MenuSnapshot } from '@ado/shared/menu';

// Panel yayininin saf kurallari (self-check'li): hangi hata ne demek, ne zaman kendiliginden
// yayinlanir, alt cubuk ne gosterir.

/** Taslaktaki urunlerin kullandigi gorsel anahtarlari (tekrarsiz). */
export function referencedImageKeys(menu: MenuSnapshot): string[] {
  return [
    ...new Set(menu.products.flatMap((product) => (product.imageKey ? [product.imageKey] : []))),
  ];
}

export type PublishFailure = 'offline' | 'conflict' | 'session' | 'images' | 'invalid' | 'other';

export function classifyPublishError(error: unknown): PublishFailure {
  const { status, code } = (error ?? {}) as { status?: number; code?: string };
  if (status === 0) return 'offline';
  if (code === 'VERSION_CONFLICT') return 'conflict';
  if (status === 401) return 'session';
  if (code === 'IMAGES_MISSING' || code === 'IMAGE_KEY_MISMATCH') return 'images';
  if (code === 'VALIDATION_ERROR') return 'invalid';
  return 'other';
}

/** "Internet gelince yayinla" istegi su an gonderilebilir mi? */
export function shouldAutoPublish(state: {
  ready: boolean;
  hasDraft: boolean;
  publishPending: boolean;
  online: boolean;
  busy: boolean;
  conflict: boolean;
}): boolean {
  return (
    state.ready &&
    state.hasDraft &&
    state.publishPending &&
    state.online &&
    !state.busy &&
    !state.conflict
  );
}

export type SaveBarState =
  | { kind: 'hidden' }
  | { kind: 'conflict' }
  | { kind: 'publishing' }
  | { kind: 'queued'; online: boolean }
  | { kind: 'error'; dirty: boolean }
  | { kind: 'dirty'; online: boolean };

export function saveBarState(state: {
  dirty: boolean;
  online: boolean;
  busy: boolean;
  publishPending: boolean;
  conflict: boolean;
  error: boolean;
}): SaveBarState {
  if (state.conflict) return { kind: 'conflict' };
  if (state.busy) return { kind: 'publishing' };
  if (state.publishPending) return { kind: 'queued', online: state.online };
  if (state.error) return { kind: 'error', dirty: state.dirty };
  if (state.dirty) return { kind: 'dirty', online: state.online };
  return { kind: 'hidden' };
}
