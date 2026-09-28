import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { connect } from 'node:tls';

// Tablet senaryosu: uygulama LAN IP'sinden acilir. Tarayici bunu yalniz HTTPS ile
// "guvenli baglam" sayar; Service Worker (cevrimdisi acilis) buna baglidir.
// Backend API_TLS_PORT ile baslatilmali; E2E_HTTPS_PORT yoksa test atlanir.
const HTTPS_PORT = Number(process.env.E2E_HTTPS_PORT) || 0;

function lanIp(): string | undefined {
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return undefined;
}

// Tablete CA kurmak yerine: sunucu sertifikasinin acik anahtarina (SPKI) guven.
function serverSpki(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, rejectUnauthorized: false }, () => {
      const der = socket
        .getPeerX509Certificate()!
        .publicKey.export({ type: 'spki', format: 'der' });
      socket.end();
      resolve(createHash('sha256').update(der).digest('base64'));
    });
    socket.on('error', reject);
  });
}

test('LAN HTTPS: guvenli baglam + service worker + cevrimdisi yenileme', async ({
  playwright,
  browserName,
  launchOptions,
}) => {
  const ip = lanIp();
  test.skip(!HTTPS_PORT || !ip, 'E2E_HTTPS_PORT veya LAN IPv4 yok');

  const spki = await serverSpki(ip!, HTTPS_PORT);
  const browser = await playwright[browserName].launch({
    ...launchOptions,
    args: [...(launchOptions.args ?? []), `--ignore-certificate-errors-spki-list=${spki}`],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`https://${ip}:${HTTPS_PORT}/login`);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(true);
    await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, {
      timeout: 15_000,
    });
    await expect(page.getByText('Tekrar hoş geldiniz')).toBeVisible();
    await expect(page.getByText('Bu bağlantı güvenli değil')).toHaveCount(0);

    // Baglanti kopuk + sayfa yenileme: app-shell service worker'dan acilir.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByText('Tekrar hoş geldiniz')).toBeVisible();
  } finally {
    await browser.close();
  }
});
