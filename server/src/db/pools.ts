import pg from 'pg';
import { env } from '../env.ts';

// int8 → number (ids, counters, trader-pack halalas stay far below 2^53).
// numeric → string: accounting money is never turned into a float.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => v);
pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'

const base = { host: env.pgHost, port: env.pgPort };

export const adminPool = (database = 'postgres') =>
  new pg.Pool({ ...base, user: env.pgAdminUser, password: env.pgAdminPassword, database, max: 2 });

export const pool = new pg.Pool({ ...base, user: env.pgAppUser, password: env.pgAppPassword, database: env.dbName, max: 20 });

export type Tx = pg.PoolClient;
export type Scope = { companyId?: number | null; branchScope?: 'all' | number; platform?: boolean; userId?: number };

// Every query runs in a transaction whose context drives row-level security:
// app.company_id (which company), app.branch_scope ('all' or a branch id), app.platform (cross-company listings).
export async function tx<T>(scope: Scope, fn: (tx: Tx) => Promise<T>, opts: { rollback?: boolean; serializable?: boolean } = {}): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(opts.serializable ? 'begin isolation level repeatable read' : 'begin');
    await client.query(
      `select set_config('app.company_id', $1, true), set_config('app.branch_scope', $2, true),
              set_config('app.platform', $3, true), set_config('app.user_id', $4, true)`,
      [scope.companyId ? String(scope.companyId) : '', String(scope.branchScope ?? 'all'), scope.platform ? 'on' : 'off', String(scope.userId ?? '')]);
    const out = await fn(client);
    if (opts.rollback) {
      await client.query('set constraints all immediate'); // run the deferred balance check before discarding
      await client.query('rollback');
    } else await client.query('commit');
    return out;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const platformTx = <T>(fn: (tx: Tx) => Promise<T>) => tx({ platform: true }, fn);
