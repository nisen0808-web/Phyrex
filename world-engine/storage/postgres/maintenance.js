'use strict';
const { databaseError, integer } = require('./config');
const { textId, safeInteger, fromSqlInteger, digest, restoreSave } = require('./codec');
const { auditDigest, auditRecordInput, lockAuditRequest } = require('./audit-receipt');

function createMaintenanceOperations({ transaction, ensureReady, schema }) {
  async function compactCheckpoints(worldId, options = {}) {
    const selected = textId(worldId, 'worldId');
    const keep = integer(options.keep, 20, 1, 1000000, 'checkpoint keep');
    const maxRecords = integer(options.maxRecords, 100, 1, 1000, 'compaction batch');
    if (options.apply !== undefined && typeof options.apply !== 'boolean') throw databaseError('INVALID_INPUT', 'apply must be boolean');
    const apply = options.apply === true;
    const expected = options.expectedRevision === undefined ? null : safeInteger(options.expectedRevision, 'expectedRevision', 1);
    if (apply && expected === null) throw databaseError('INVALID_INPUT', 'Compaction requires expectedRevision');
    await ensureReady();
    return transaction(async client => {
      const found = await client.query(`SELECT revision,latest_sequence FROM ${schema}.worlds WHERE world_id=$1 ${apply ? 'FOR UPDATE' : ''}`, [selected]);
      if (!found.rows.length || found.rows[0].latest_sequence === null) throw databaseError('MISSING_WORLD', 'World has no checkpoint');
      const revision = fromSqlInteger(found.rows[0].revision);
      if (expected !== null && revision !== expected) throw databaseError('REVISION_CONFLICT', 'World revision changed before maintenance');
      const boundary = await client.query(`SELECT revision FROM ${schema}.world_saves WHERE world_id=$1 AND envelope IS NOT NULL ORDER BY revision DESC LIMIT 1 OFFSET $2`, [selected, keep - 1]);
      const beforeRevision = boundary.rows.length ? fromSqlInteger(boundary.rows[0].revision) : 0;
      const result = await client.query(`SELECT count(*) AS count,COALESCE(sum(pg_column_size(envelope)),0) AS bytes FROM ${schema}.world_saves WHERE world_id=$1 AND revision<$2 AND envelope IS NOT NULL AND sequence<>$3`, [selected, beforeRevision, found.rows[0].latest_sequence]);
      const eligible = fromSqlInteger(result.rows[0].count);
      let compacted = 0;
      if (apply) {
        let cursor = beforeRevision;
        while (compacted < Math.min(eligible, maxRecords)) {
          const batch = await client.query(`SELECT * FROM ${schema}.world_saves WHERE world_id=$1 AND revision<$2 AND envelope IS NOT NULL AND sequence<>$3 ORDER BY revision DESC LIMIT 1`, [selected, cursor, found.rows[0].latest_sequence]);
          if (!batch.rows.length) break;
          const row = batch.rows[0];
          restoreSave(row); // Never erase the evidence of a corrupt payload.
          await client.query(`UPDATE ${schema}.world_saves SET archived_metadata=COALESCE(envelope->'metadata','{}'::jsonb),envelope=NULL,archived_at=clock_timestamp() WHERE sequence=$1`, [row.sequence]);
          cursor = fromSqlInteger(row.revision); compacted++;
        }
      }
      return { worldId: selected, revision, keep, eligible, compacted, remaining: eligible - compacted,
        payloadBytesEligible: fromSqlInteger(result.rows[0].bytes), applied: apply };
    }, !apply);
  }

  async function retireAuditRecords(records) {
    if (!Array.isArray(records) || records.length > 1000) throw databaseError('INVALID_INPUT', 'Audit retention batch must have at most 1000 rows');
    // Capture caller input before awaiting, and lock in sequence order to avoid
    // deadlocks between overlapping maintenance batches.
    const candidates = records.map(row => ({ sequence: safeInteger(row.sequence, 'audit sequence', 1),
      requestId: textId(row.request_id, 'audit requestId', 128), checksum: digest(row) })).sort((a, b) => a.sequence - b.sequence);
    if (new Set(candidates.map(row => row.sequence)).size !== candidates.length) throw databaseError('INVALID_INPUT', 'Duplicate audit retention row');
    await ensureReady();
    return transaction(async client => {
      let retired = 0, missing = 0;
      for (const candidate of candidates) {
        await lockAuditRequest(client, schema, candidate.requestId);
        const found = await client.query(`SELECT to_jsonb(t) AS data FROM ${schema}.command_api_audit t WHERE sequence=$1 FOR UPDATE`, [candidate.sequence]);
        if (!found.rows.length) { missing++; continue; }
        const row = found.rows[0].data;
        if (digest(row) !== candidate.checksum) throw databaseError('AUDIT_RETENTION_CONFLICT', 'Audit record differs from its backup');
        await client.query(`INSERT INTO ${schema}.command_api_audit_receipts(request_id,sequence,input_digest,created_at) VALUES ($1,$2,$3,$4)`,
          [row.request_id, row.sequence, auditDigest(auditRecordInput(row)), row.created_at]);
        await client.query(`DELETE FROM ${schema}.command_api_audit WHERE sequence=$1`, [candidate.sequence]);
        retired++;
      }
      return { retired, missing };
    });
  }
  return { compactCheckpoints, retireAuditRecords };
}
module.exports = { createMaintenanceOperations };
