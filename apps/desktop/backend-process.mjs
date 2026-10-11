// Backend cocuk sureci: IPC kanalli baslatma ve duzgun kapanis (Electron'suz; selfcheck.mjs).
// IPC kanali iki is gorur: kapanista `shutdown` mesaji (veritabani ve sunucular duzgun kapanir) ve
// ana surec cokerse kanalin kopmasi (backend kendini kapatir; port ve veritabani kilitli kalmaz).
import { spawn } from 'node:child_process';

/** Kapanis mesajindan sonra zorla sonlandirmadan once beklenecek sure. */
export const STOP_TIMEOUT_MS = 10_000;

export function startBackendProcess({ execPath, entry, env, onOutput }) {
  const child = spawn(execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  return child;
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Backend'i kapatir: once `shutdown` mesaji, en fazla `timeoutMs` beklenir, kapanmazsa zorla
 * sonlandirilir. Windows'ta kill() sinyal degil dogrudan sonlandirmadir; bu yuzden once mesaj.
 * Sonuc: 'exited' (zaten kapaliydi) | 'graceful' | 'killed'.
 */
export function stopBackendProcess(child, timeoutMs = STOP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!child || hasExited(child)) {
      resolve('exited');
      return;
    }
    let result = 'graceful';
    const kill = () => {
      result = 'killed';
      child.kill();
    };
    const timer = setTimeout(kill, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(result);
    });
    if (!child.connected) {
      kill();
      return;
    }
    child.send({ type: 'shutdown' }, (error) => {
      if (error) kill();
    });
  });
}
