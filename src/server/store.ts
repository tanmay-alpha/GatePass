import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AssetRecord, AuditEvent, QrRecord } from '../shared/types';

export interface DatabaseShape {
  qrCodes: QrRecord[];
  auditEvents: AuditEvent[];
  assets: AssetRecord[];
  feedback: Array<{ id: string; qrCodeId: string; submission: unknown; createdAt: string }>;
}

const defaultDb: DatabaseShape = { qrCodes: [], auditEvents: [], assets: [], feedback: [] };

export class JsonStore {
  private db: DatabaseShape | null = null;

  constructor(private readonly dataFile = process.env.DATA_FILE || '.local/data/db.json') {}

  async all(): Promise<DatabaseShape> {
    if (this.db) return this.db;
    await mkdir(path.dirname(this.dataFile), { recursive: true });
    try {
      this.db = JSON.parse(await readFile(this.dataFile, 'utf8')) as DatabaseShape;
    } catch {
      this.db = structuredClone(defaultDb);
      await this.save();
    }
    return this.db;
  }

  async save(): Promise<void> {
    if (!this.db) this.db = structuredClone(defaultDb);
    await mkdir(path.dirname(this.dataFile), { recursive: true });
    await writeFile(this.dataFile, JSON.stringify(this.db, null, 2));
  }

  async upsertQr(record: QrRecord): Promise<QrRecord> {
    const db = await this.all();
    const index = db.qrCodes.findIndex((qr) => qr.id === record.id);
    if (index >= 0) db.qrCodes[index] = record;
    else db.qrCodes.unshift(record);
    await this.save();
    return record;
  }

  async addAudit(event: Omit<AuditEvent, 'id' | 'createdAt'>): Promise<AuditEvent> {
    const db = await this.all();
    const saved = { ...event, id: randomUUID(), createdAt: new Date().toISOString() };
    db.auditEvents.unshift(saved);
    await this.save();
    return saved;
  }

  async addAsset(input: Omit<AssetRecord, 'id' | 'createdAt' | 'sha256'> & { buffer: Buffer }): Promise<AssetRecord> {
    const db = await this.all();
    const saved: AssetRecord = {
      id: randomUUID(),
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      storagePath: input.storagePath,
      publicPath: input.publicPath,
      sha256: createHash('sha256').update(input.buffer).digest('hex'),
      createdAt: new Date().toISOString()
    };
    db.assets.unshift(saved);
    await this.save();
    return saved;
  }
}

export function publicBaseUrl(): string {
  return process.env.APP_PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`;
}
