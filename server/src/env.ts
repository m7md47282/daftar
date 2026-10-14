import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const envFile = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const env = {
  pgHost: req('PG_HOST'),
  pgPort: Number(req('PG_PORT')),
  pgAdminUser: req('PG_ADMIN_USER'),
  pgAdminPassword: req('PG_ADMIN_PASSWORD'),
  pgAppUser: req('PG_APP_USER'),
  pgAppPassword: req('PG_APP_PASSWORD'),
  apiPort: Number(process.env.API_PORT ?? 8094),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:8083',
  masterKey: req('MASTER_KEY'),
  chromePath: process.env.CHROME_PATH,
  dbName: process.env.PG_DATABASE ?? 'daftar',
  storageDir: process.env.STORAGE_DIR ?? new URL('../../storage', import.meta.url).pathname,
};
