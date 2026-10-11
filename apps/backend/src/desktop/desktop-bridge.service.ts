import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

/** Masaustu kabugundan (Electron ana sureci) gelen IPC mesajlari. */
export const desktopMessageSchema = z.discriminatedUnion('type', [
  // Kabuk kapaniyor: acik istekler bitsin, veritabani kapansin (main.ts).
  z.object({ type: z.literal('shutdown') }),
]);
export type DesktopMessage = z.infer<typeof desktopMessageSchema>;
type Listener = (message: DesktopMessage) => void;

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

  receive(raw: unknown): void {
    const parsed = desktopMessageSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn('Masaustu kabugundan gecersiz mesaj yok sayildi.');
      return;
    }
    for (const listener of this.listeners) listener(parsed.data);
  }
}
