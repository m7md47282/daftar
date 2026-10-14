import { createHash } from 'node:crypto';

// ZATCA readiness. Nothing here talks to ZATCA yet. We already produce:
//  - the Phase 1 QR (TLV, base64) required on every printed tax invoice
//  - the Phase 2 chain fields: UUID, invoice counter (ICV), previous invoice hash (PIH)
// When we connect, the hash will move to the signed UBL XML; the chain shape stays.

// Phase 2 spec: the first invoice's PIH is base64(sha256 hex of "0").
export const INITIAL_PIH = 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==';

export function tlvQr(fields: { seller: string; vatNumber: string; timestamp: string; total: string; vat: string }): string {
  const parts = [fields.seller, fields.vatNumber, fields.timestamp, fields.total, fields.vat].map((v, i) => {
    const val = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from([i + 1, val.length]), val]);
  });
  return Buffer.concat(parts).toString('base64');
}

export function invoiceHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64');
}
