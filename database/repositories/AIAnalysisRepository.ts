import { getDatabase, withTransaction } from '../db';
import { AI_ALGO_VERSION, AssetStatus, GLOBAL_ALGO_VERSION } from '../schema';
import type { AssetRecord } from './AssetRepository';

export interface AIProgress { pending: number; done: number; error: number }
const validResult = `a.version = ${AI_ALGO_VERSION}
    AND a.source_updated_at IS s.updated_at AND a.source_signature IS s.file_signature
    AND a.source_phash IS s.phash`;

async function readWork(scope?: readonly string[]) {
    const db = await getDatabase();
    const chunks: (readonly string[] | undefined)[] = scope === undefined ? [undefined] : [];
    if (scope) {
        const unique = [...new Set(scope)];
        for (let i = 0; i < unique.length; i += 500) chunks.push(unique.slice(i, i + 500));
    }
    const rows: { asset_id: string; ai_status: number }[] = [];
    for (const ids of chunks) {
        rows.push(...await db.getAllAsync<{ asset_id: string; ai_status: number }>(`
            SELECT s.asset_id, CASE WHEN ${validResult} THEN a.status ELSE 0 END AS ai_status
            FROM assets s LEFT JOIN ai_analysis a ON a.asset_id = s.asset_id
            WHERE s.status = ? AND s.algo_version = ?
            ${ids ? `AND s.asset_id IN (${ids.map(() => '?').join(',')})` : ''}
            ORDER BY s.taken_at, s.asset_id`, [AssetStatus.DONE, GLOBAL_ALGO_VERSION, ...(ids ?? [])]));
    }
    return rows;
}

export const AIAnalysisRepository = {
    async getCandidates(scope?: readonly string[], errorsOnly = false): Promise<string[]> {
        return (await readWork(scope)).filter(row => errorsOnly ? row.ai_status === AssetStatus.ERROR : row.ai_status !== AssetStatus.DONE).map(row => row.asset_id);
    },
    async getCounts(scope?: readonly string[]): Promise<AIProgress> {
        const counts: AIProgress = { pending: 0, done: 0, error: 0 };
        for (const row of await readWork(scope)) {
            if (row.ai_status === AssetStatus.DONE) counts.done++;
            else if (row.ai_status === AssetStatus.ERROR) counts.error++;
            else counts.pending++;
        }
        return counts;
    },
    async save(source: AssetRecord, result: { labelsJson: string; faceCount: number } | null): Promise<boolean> {
        return withTransaction(async db => {
            // Compare-and-set against the full base snapshot: a deleted,
            // edited, reset or rescanned asset cannot receive stale AI output.
            const current = await db.getFirstAsync<{ asset_id: string }>(`
                SELECT asset_id FROM assets WHERE asset_id = ? AND status = ? AND algo_version IS ?
                AND updated_at IS ? AND file_signature IS ? AND phash IS ?
                AND taken_at IS ? AND width IS ? AND height IS ?`,
                [source.asset_id, AssetStatus.DONE, source.algo_version, source.updated_at,
                    source.file_signature, source.phash, source.taken_at, source.width, source.height]);
            if (!current) return false;
            if (result) {
                await db.runAsync('UPDATE assets SET labels_json = ?, face_count = ? WHERE asset_id = ?',
                    [result.labelsJson, result.faceCount, source.asset_id]);
            }
            await db.runAsync(`INSERT OR REPLACE INTO ai_analysis
                (asset_id, version, status, source_updated_at, source_signature, source_phash, error_message, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [source.asset_id, AI_ALGO_VERSION, result ? AssetStatus.DONE : AssetStatus.ERROR,
                    source.updated_at, source.file_signature, source.phash,
                    result ? null : 'AI analysis failed; retry available', Date.now()]);
            return true;
        });
    },
};
