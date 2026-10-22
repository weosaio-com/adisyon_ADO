// Backend cocuk sureci: IPC kanalli baslatma ve duzgun kapanis (Electron'suz; selfcheck.mjs).
// IPC kanali iki is gorur: kapanista `shutdown` mesaji (veritabani ve sunucular duzgun kapanir) ve
// ana surec cokerse kanalin kopmasi (backend kendini kapatir; port ve veritabani kilitli kalmaz).
import { spawn } from 'node:child_process';

/** Kapanis mesajindan sonra zorla sonlandirmadan once beklenecek sure. */
export const STOP_TIMEOUT_MS = 10_000;
/** Zorla sonlandirma (SIGTERM) islenmezse (askida/durdurulmus surec) kesin sonlandirmaya kadar. */
export const KILL_WAIT_MS = 5_000;

export function startBackendProcess({ execPath, entry, env, onOutput }) {
  const child = spawn(execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Akis adi ikinci arguman: olaylar kaydi stderr'i ve stdout'u ayri suzer (PLT-14).
  child.stdout.on('data', (chunk) => onOutput(chunk, 'stdout'));
  child.stderr.on('data', (chunk) => onOutput(chunk, 'stderr'));
  return child;
}

const hasExited = (child) => child.exitCode !== null || child.signalCode !== null;

/**
 * Backend'i kapatir: once `shutdown` mesaji, en fazla `timeoutMs` beklenir, kapanmazsa zorla
 * sonlandirilir. Windows'ta kill() sinyal degil dogrudan sonlandirmadir; bu yuzden once mesaj.
 * Sonuc: 'exited' (zaten kapaliydi) | 'graceful' | 'killed'.
 */
export function stopBackendProcess(child, timeoutMs = STOP_TIMEOUT_MS, killWaitMs = KILL_WAIT_MS) {
  return new Promise((resolve) => {
    if (!child || hasExited(child)) {
      resolve('exited');
      return;
    }
    let result = 'graceful';
    let escalate = null;
    const kill = () => {
      if (result === 'killed') return;
      result = 'killed';
      child.kill();
      // Askida kalan surec SIGTERM'i isleyemeyebilir: sure dolunca kesin sonlandirma (PLT-12).
      escalate = setTimeout(() => {
        if (!hasExited(child)) child.kill('SIGKILL');
      }, killWaitMs);
    };
    const timer = setTimeout(kill, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      clearTimeout(escalate);
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
