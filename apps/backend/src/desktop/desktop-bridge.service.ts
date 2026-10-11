import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

/** Masaustu guncelleyicisinin durumu (apps/desktop/updater.mjs). */
export const UPDATE_STATES = [
  'disabled',
  'idle',
  'checking',
  'downloading',
  'ready',
  'installing',
  'error',
] as const;

const updateStatusSchema = z.object({
  type: z.literal('update-status'),
  state: z.enum(UPDATE_STATES),
  channel: z.enum(['stable', 'beta']),
  currentVersion: z.string().max(40),
  version: z.string().max(40).nullish(),
  notes: z.string().max(2000).nullish(),
  progress: z.number().min(0).max(100).nullish(),
  error: z.string().max(500).nullish(),
  checkedAt: z.string().max(40).nullish(),
});

/** Masaustu kabugundan (Electron ana sureci) gelen IPC mesajlari. */
export const desktopMessageSchema = z.discriminatedUnion('type', [
  // Kabuk kapaniyor: acik istekler bitsin, veritabani kapansin (main.ts).
  z.object({ type: z.literal('shutdown') }),
  updateStatusSchema,
]);
export type DesktopMessage = z.infer<typeof desktopMessageSchema>;
export type DesktopUpdateStatus = z.infer<typeof updateStatusSchema>;
type Listener = (message: DesktopMessage) => void;

/** Backend'den kabuga giden komutlar: guncelleme denetle / onaylanan surumu kur. */
export type DesktopCommand = { type: 'update-check' } | { type: 'update-install'; version: string };

/**
 * Masaustu kabugu ile IPC kanali. Backend'i kabuk IPC ile baslattiysa
 * (apps/desktop/backend-process.mjs) `process.send` vardir; gelistirmede ve sunucu olarak
 * calisirken yoktur, servis sessiz kalir. Gelen mesajlar dogrulanir; gecersizi yok sayilir.
 */
@Injectable()
export class DesktopBridgeService {
  private readonly logger = new Logger(DesktopBridgeService.name);
  private readonly listeners = new Set<Listener>();

  constructor() {
    if (this.attached) process.on('message', (raw: unknown) => this.receive(raw));
  }

  /** Masaustu kabugu tarafindan IPC kanaliyla mi baslatildi. */
  get attached(): boolean {
    return typeof process.send === 'function';
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Kabuga komut yollar; kabuk yoksa ya da kanal koptuysa false. */
  send(command: DesktopCommand): boolean {
    if (!this.attached || !process.connected) return false;
    process.send?.(command);
    return true;
  }

  receive(raw: unknown): void {
    const parsed = desktopMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('Masaustu kabugundan gecersiz mesaj yok sayildi.');
      return;
    }
    for (const listener of this.listeners) listener(parsed.data);
  }
}
