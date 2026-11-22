import { DatabaseSync } from 'node:sqlite';
import {
  SQL_CREATE_ASSETS,
  SQL_CREATE_ASSETS_INDEXES,
  SQL_CREATE_DUP_GROUPS,
  SQL_CREATE_DUP_GROUPS_INDEXES,
  SQL_CREATE_DUP_MEMBERS,
  SQL_CREATE_DUP_MEMBERS_INDEXES,
  SQL_CREATE_FACE_GROUPS,
  SQL_CREATE_FACE_INSTANCES,
  SQL_CREATE_FACE_INSTANCES_INDEXES,
  SQL_CREATE_MEDIA_PENDING_QUEUE,
  SQL_CREATE_MEDIA_PENDING_QUEUE_INDEXES,
  SQL_CREATE_MEDIA_PROCESSED_RECORDS,
  SQL_CREATE_MEDIA_PROCESSED_RECORDS_INDEXES,
  SQL_CREATE_MEDIA_REVIEW_IGNORES,
  SQL_CREATE_MEDIA_REVIEW_IGNORES_INDEXES,
  SQL_CREATE_META,
  SQL_CREATE_PROTECTED_ALBUMS,
  SQL_CREATE_PROTECTED_ALBUMS_INDEXES,
  SQL_CREATE_AI_ANALYSIS,
  SQL_CREATE_SIMILAR_REVIEWS,
} from '../../database/schema';

type SqlValue = string | number | null;

/**
 * A private SQLite database for repository tests.
 *
 * It implements only the async methods used by the production repositories,
 * while keeping every test isolated from the user's Expo database.
 */
export class TestDatabase {
  private readonly database = new DatabaseSync(':memory:');
  private failurePredicate: ((sql: string) => boolean) | null = null;

  constructor() {
    this.database.exec([
      SQL_CREATE_META,
      SQL_CREATE_ASSETS,
      // `face_count` is added by the production V2 migration. Start the
      // isolated fixture at the current schema so repository SQL is tested
      // against the same columns as a real upgraded database.
      'ALTER TABLE assets ADD COLUMN face_count INTEGER DEFAULT 0;',
      SQL_CREATE_DUP_GROUPS,
      SQL_CREATE_DUP_MEMBERS,
      SQL_CREATE_FACE_GROUPS,
      SQL_CREATE_FACE_INSTANCES,
      SQL_CREATE_AI_ANALYSIS,
      SQL_CREATE_SIMILAR_REVIEWS,
      SQL_CREATE_MEDIA_PROCESSED_RECORDS,
      SQL_CREATE_MEDIA_PENDING_QUEUE,
      SQL_CREATE_MEDIA_REVIEW_IGNORES,
      SQL_CREATE_PROTECTED_ALBUMS,
      ...SQL_CREATE_ASSETS_INDEXES,
      ...SQL_CREATE_DUP_GROUPS_INDEXES,
      ...SQL_CREATE_DUP_MEMBERS_INDEXES,
      ...SQL_CREATE_FACE_INSTANCES_INDEXES,
      ...SQL_CREATE_MEDIA_PROCESSED_RECORDS_INDEXES,
      ...SQL_CREATE_MEDIA_PENDING_QUEUE_INDEXES,
      ...SQL_CREATE_MEDIA_REVIEW_IGNORES_INDEXES,
      ...SQL_CREATE_PROTECTED_ALBUMS_INDEXES,
    ].join('\n'));
  }

  async execAsync(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  async withTransactionAsync(callback: () => Promise<void>): Promise<void> {
    await this.execAsync('BEGIN');
    try { await callback(); await this.execAsync('COMMIT'); }
    catch (error) { await this.execAsync('ROLLBACK'); throw error; }
  }

  async runAsync(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<{ changes: number; lastInsertRowId: number }> {
    if (this.failurePredicate?.(sql)) {
      throw new Error(`Injected test database failure for SQL: ${sql}`);
    }
    const result = this.database.prepare(sql).run(...(params as SqlValue[]));
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async getFirstAsync<T>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T | null> {
    const row = this.database.prepare(sql).get(...(params as SqlValue[]));
    return (row as T | undefined) ?? null;
  }

  async getAllAsync<T>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    return this.database.prepare(sql).all(...(params as SqlValue[])) as T[];
  }

  async closeAsync(): Promise<void> {
    this.database.close();
  }

  setFailurePredicate(predicate: ((sql: string) => boolean) | null): void {
    this.failurePredicate = predicate;
  }
}
