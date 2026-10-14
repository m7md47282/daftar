import { env } from './env.ts';
import { buildApp } from './http/app.ts';
import { purgeExpiredDemos } from './platform.ts';
import { pool } from './db/pools.ts';
import { closeBrowser } from './pdf/render.ts';

if (process.env.NODE_ENV === 'production') {
  // refuse to run production with the development defaults
  const weak = ['password123', 'change-me-now', ''];
  if (weak.includes(process.env.SUPERADMIN_PASSWORD ?? '')) throw new Error('SUPERADMIN_PASSWORD is a development default — set a strong one');
  if (!/^[0-9a-f]{64}$/i.test(env.masterKey)) throw new Error('MASTER_KEY must be 64 hex chars (openssl rand -hex 32)');
  if (!env.webOrigin.startsWith('https://')) console.warn('WEB_ORIGIN is not https — share links will be http');
}

const app = buildApp();
// Cloud Run injects PORT and needs 0.0.0.0; locally we stay on loopback.
const port = Number(process.env.PORT ?? env.apiPort);
const host = process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
await app.listen({ port, host });
console.log(`daftar api on http://${host}:${port}`);

const purge = () => purgeExpiredDemos().then((n) => n && console.log(`purged ${n} expired demo(s)`)).catch((e) => console.error('demo purge failed', e));
purge();
setInterval(purge, 3600_000).unref();

// Cloud Run sends SIGTERM before stopping an instance: finish in-flight requests, then close pools.
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, async () => {
    try { await app.close(); await closeBrowser(); await pool.end(); } finally { process.exit(0); }
  });
}
