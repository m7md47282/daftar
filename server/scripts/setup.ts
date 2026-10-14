// Explicit platform set-up (run by the operator, never on start-up):
//  - creates the database and app role if missing (existing data is never dropped)
//  - publishes the fabric chart template v1.0.0 (idempotent; a published version is immutable)
//  - creates the platform admin login if missing
// It never creates companies, accounts or demo data (BAS-03).
// Usage: node server/scripts/setup.ts            (or --fresh to wipe a local dev database)
import { ensureDatabase } from '../src/db/bootstrap.ts';
import { pool, platformTx } from '../src/db/pools.ts';
import { publishTemplate } from '../src/core/templates.ts';
import { fabricTemplateContent } from '../src/core/template-fabric.ts';
import { hashPassword } from '../src/core/companies.ts';

const fresh = process.argv.includes('--fresh');
const r = await ensureDatabase(undefined, { fresh });
console.log(r.created ? 'database created' : 'database exists — schema left as is');
const username = process.env.SUPERADMIN_USERNAME ?? 'superadmin';
const { rows: [admin] } = await pool.query(
  `insert into users(username, password_hash, full_name, is_platform_admin) values ($1, $2, 'مدير المنصة', true)
   on conflict (username) do update set is_platform_admin = true returning id`, [username, hashPassword(process.env.SUPERADMIN_PASSWORD ?? 'change-me-now')]);
const t = await platformTx((x) => publishTemplate(x, admin.id, fabricTemplateContent()));
console.log(`template ${t.slug}@${t.version} published (${t.content.accounts.length} accounts)`);
await pool.end();
