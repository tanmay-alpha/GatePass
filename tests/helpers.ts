import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/server/app';
import { openDatabase, type Database } from '../src/server/db';
import { GatePass, type GatePassOptions } from '../src/server/gatepass';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
export const PUBLIC_URL = 'https://gate.example';

/** Mutable clock so tests can move time forward deterministically. */
export class TestClock {
  /** Default: 30 minutes into EVENT_INPUT's window (18:00–23:00 UTC). */
  constructor(public current = new Date('2030-06-01T18:30:00.000Z')) {}
  now = (): Date => new Date(this.current);
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface Harness {
  dir: string;
  dbFile: string;
  db: Database;
  service: GatePass;
  clock: TestClock;
  app: Express;
  admin: (req: request.Test) => request.Test;
  close: () => void;
}

/** File-backed (not :memory:) so tests exercise WAL and multi-connection behaviour. */
export function createHarness(options: Partial<GatePassOptions> = {}): Harness {
  const dir = mkdtempSync(path.join(tmpdir(), 'gatepass-'));
  const dbFile = path.join(dir, 'gatepass.db');
  const db = openDatabase(dbFile);
  const clock = new TestClock();
  const service = new GatePass(db, { publicUrl: PUBLIC_URL, now: clock.now, ...options });
  const app = createApp({ service, adminToken: ADMIN_TOKEN, publicUrl: PUBLIC_URL, allowSignup: true });
  return {
    dir,
    dbFile,
    db,
    service,
    clock,
    app,
    admin: (req) => req.set('Authorization', `Bearer ${ADMIN_TOKEN}`),
    close: () => {
      if (db.isOpen) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export const EVENT_INPUT = {
  name: 'Launch Night',
  venue: 'Hall A',
  startsAt: '2030-06-01T18:00:00.000Z',
  endsAt: '2030-06-01T23:00:00.000Z'
};

/** Creates an event, one scanner and `count` passes through the HTTP API. */
export async function seedEvent(h: Harness, count = 1) {
  const event = (await h.admin(request(h.app).post('/api/events')).send(EVENT_INPUT).expect(201)).body;
  const scanner = (await h.admin(request(h.app).post(`/api/events/${event.id}/scanners`)).send({ label: 'Door 1' }).expect(201)).body;
  const passes = (await h.admin(request(h.app).post(`/api/events/${event.id}/passes`)).send({ count }).expect(201)).body;
  return { event, scannerKey: scanner.key as string, scannerId: scanner.scanner.id as string, passes };
}

export function scan(h: Harness, key: string, code: string) {
  return request(h.app).post('/api/scanner/redeem').set('Authorization', `Bearer ${key}`).send({ code });
}
