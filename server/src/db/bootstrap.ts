import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from '../env.ts';
import { adminPool } from './pools.ts';

const schema = () => readFileSync(fileURLToPath(new URL('../../../db/schema.sql', import.meta.url)), 'utf8');
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// Creates the app role (owns nothing ⇒ row-level security always applies) and, if missing, the database.
export async function ensureDatabase(dbName = env.dbName, opts: { fresh?: boolean } = {}) {
  const admin = adminPool();
  try {
    const role = await admin.query('select 1 from pg_roles where rolname = $1', [env.pgAppUser]);
    if (!role.rowCount) await admin.query(`create role ${env.pgAppUser} login password ${lit(env.pgAppPassword)}`);
    else await admin.query(`alter role ${env.pgAppUser} password ${lit(env.pgAppPassword)}`);
    const exists = (await admin.query('select 1 from pg_database where datname = $1', [dbName])).rowCount! > 0;
    if (exists && opts.fresh) await admin.query(`drop database "${dbName}" with (force)`);
    if (exists && !opts.fresh) return { created: false };
    await admin.query(`create database "${dbName}"`);
  } finally { await admin.end(); }
  const db = adminPool(dbName);
  try {
    await db.query(schema());
    await db.query(`grant usage on schema public to ${env.pgAppUser};
      grant select, insert, update, delete on all tables in schema public to ${env.pgAppUser};
      grant usage, select on all sequences in schema public to ${env.pgAppUser};`);
  } finally { await db.end(); }
  return { created: true };
}

export async function dropDatabase(dbName: string) {
  const admin = adminPool();
  try { await admin.query(`drop database if exists "${dbName}" with (force)`); } finally { await admin.end(); }
}
