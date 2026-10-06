import { Controller, Sse } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { fromEvent, interval, map, merge, type Observable } from 'rxjs';
import type { DomainEvent } from '@ado/shared';

/**
 * SSE canli sinyal akisi (GET /events/stream). Sunucu sadece olay ADINI yollar
 * ("order.created"); istemci ilgili veriyi REST'ten tazeler. Kimlik dogrulama
 * global JwtAuthGuard uzerinden: yalniz `Authorization: Bearer` basligi (istemci
 * fetch ile baglanir; ?token= sorgu parametresi bilerek desteklenmez, loga dusmesin).
 */
@Controller('events')
export class EventsController {
  constructor(private readonly emitter: EventEmitter2) {}

  // ponytail: tek sube, oda/filtre yok — herkese her sinyal; sube filtresi gerekirse eklenir.
  @Sse('stream')
  stream(): Observable<string> {
    const domain = fromEvent(this.emitter, '**').pipe(
      map((ev) => (ev as DomainEvent<string, unknown>).name),
    );
    // 25 sn heartbeat: bos baglantinin ara kutularca kesilmesini onler.
    const heartbeat = interval(25_000).pipe(map(() => 'ping'));
    return merge(domain, heartbeat);
  }
}
