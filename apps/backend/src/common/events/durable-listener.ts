/**
 * Kalici (publishDurable) domain event dinleyicileri icin `@OnEvent` secenekleri.
 *
 * - `suppressErrors: false`: dinleyici hatasi EventBusService.publish'e ulasir;
 *   worker `domain.event` isini geri cekilmeyle yeniden dener. Varsayilan (true)
 *   hatayi yalnizca loglar ve is `completed` sayilirdi (fis/stok sessizce kaybolurdu).
 * - `async` YOK: EventEmitter2'nin async sarmali dinleyiciyi setImmediate ile
 *   ertelediginden emitAsync onu beklemez; suppressErrors:false ile birlikte
 *   kullanilirsa islenmemis promise reddi sureci dusurur.
 *
 * Yeniden denemede olayin TUM dinleyicileri tekrar calisir -> her dinleyici
 * idempotent olmali (unique anahtar / upsert / on-kontrol). Detay: EVENT_BUS.md.
 */
export const DURABLE_LISTENER = { suppressErrors: false } as const;
