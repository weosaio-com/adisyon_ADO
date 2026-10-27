import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAccess, renewAccess } from './api';
import { requestCheck } from '../offline/engine';

const RECONNECT_MS = 5000;
// Sunucu 25 sn'de bir "ping" yollar; bu surede hic veri gelmezse baglanti yari acik sayilir
// (Wi-Fi dolasimi, uyku): akis kesilip yeniden kurulur. OFF-16
const STALE_MS = 60_000;
const WATCH_MS = 10_000;

// Olay adi oneki -> tazelenecek sorgu anahtarlari (kismi eslesme: ['order'] -> ['order', id]).
const KEYS: Record<string, string[][]> = {
  order: [['orders'], ['order']],
  payment: [['orders'], ['order']],
  table: [['tables'], ['orders']],
};

/** SSE canli sinyal: olay gelince ilgili react-query sorgularini invalidate eder. */
export function useLiveEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let stopped = false;
    let abort: AbortController | undefined;
    let timer: number | undefined;
    let lost = false; // akis bir kez koptu: yeniden baglaninca kacirilan olaylar tazelenir
    const handle = (raw: string) => {
      let name = raw;
      try {
        const json: unknown = JSON.parse(name);
        if (json && typeof json === 'object') {
          name = String((json as { data?: unknown }).data ?? name);
        }
      } catch {
        // duz metin
      }
      const prefix = name.split('.')[0] ?? '';
      for (const key of KEYS[prefix] ?? []) qc.invalidateQueries({ queryKey: key });
    };
    const connect = async () => {
      // Belirtec yoksa da deneme surer: yeniden giriste canli baglanti kendiliginden kurulur.
      const token = getAccess();
      const delay = token ? await stream(token) : RECONNECT_MS;
      if (!stopped) timer = window.setTimeout(() => void connect(), delay);
    };
    // Akisi okur; bitince ya da koparsa bir sonraki denemeye kadar beklenecek sureyi dondurur.
    const stream = async (token: string): Promise<number> => {
      abort = new AbortController();
      try {
        const response = await fetch('/api/v1/events/stream', {
          headers: { Authorization: `Bearer ${token}` },
          signal: abort.signal,
        });
        if (response.status === 401) {
          // Erisim belirtecinin suresi doldu: api.ts'in paylasilan yenilemesi (oturum gercekten
          // bittiyse uygulama giris ekranina gecer); yeni belirtecle hemen yeniden baglanilir.
          await renewAccess(token);
          return 1000;
        }
        if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
        // Kopukken gelen olaylar kacirilmis olabilir: yeniden baglaninca bir kez tazele.
        if (lost) {
          lost = false;
          for (const keys of Object.values(KEYS)) {
            for (const key of keys) qc.invalidateQueries({ queryKey: key });
          }
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let lastData = Date.now();
        const watchdog = window.setInterval(() => {
          if (Date.now() - lastData > STALE_MS) abort?.abort();
        }, WATCH_MS);
        try {
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done) break;
            lastData = Date.now();
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() ?? '';
            for (const frame of frames) {
              const data = frame
                .split(/\r?\n/)
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
              if (data) handle(data);
            }
          }
        } finally {
          window.clearInterval(watchdog);
        }
      } catch {
        // Yeniden baglanma connect() icinde.
      }
      if (!stopped) {
        lost = true;
        // Akis koptu: baglanti hemen yoklanir (rozet bir sonraki tiki beklemez).
        requestCheck();
      }
      return RECONNECT_MS;
    };
    void connect();
    return () => {
      stopped = true;
      abort?.abort();
      window.clearTimeout(timer);
    };
  }, [qc]);
}
