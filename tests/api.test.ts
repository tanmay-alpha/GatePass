import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir = '';
let app: Awaited<ReturnType<typeof loadApp>>;

async function loadApp() {
  vi.resetModules();
  process.env.NODE_ENV = 'test';
  process.env.DATA_FILE = path.join(tempDir, 'db.json');
  process.env.UPLOAD_DIR = path.join(tempDir, 'uploads');
  process.env.APP_PUBLIC_URL = 'http://localhost:3000';
  const module = await import('../src/server/server');
  return module.createApp();
}

describe('API', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'ctech-qr-'));
    app = await loadApp();
  });

  afterEach(async () => {
    delete process.env.ADMIN_TOKEN;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('renders SVG and PNG through API parity route', async () => {
    const svg = await request(app).post('/api/qr/custom').send({ data: 'https://example.com', file: 'svg', size: 300 });
    expect(svg.status).toBe(200);
    expect(svg.headers['content-type']).toContain('image/svg+xml');
    expect(svg.body.toString()).toContain('<svg');

    const png = await request(app).get('/qr/custom').query({ data: 'https://example.com', file: 'png', size: 300 });
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toContain('image/png');
  });

  it('creates dynamic QR records and keeps short payload stable on edit', async () => {
    const created = await request(app).post('/api/qr-codes').send({
      name: 'Dynamic URL',
      mode: 'dynamic_url',
      contentType: 'url',
      keyword: 'launch',
      contentPayload: { url: 'https://example.com/a' }
    });
    expect(created.status).toBe(201);
    const original = created.body.encodedPayload;
    expect(original).toContain('/r/launch');
    expect(created.body.yourlsLongUrl).toBe(`http://localhost:3000/r/${created.body.id}`);

    const updated = await request(app).patch(`/api/qr-codes/${created.body.id}`).send({ contentPayload: { url: 'https://example.com/b' } });
    expect(updated.status).toBe(200);
    expect(updated.body.encodedPayload).toBe(original);
    expect(updated.body.yourlsLongUrl).toBe(created.body.yourlsLongUrl);

    const redirect = await request(app).get('/r/launch').redirects(0);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe('https://example.com/b');

    const detail = await request(app).get(`/api/qr-codes/${created.body.id}`);
    expect(detail.body.auditEvents.length).toBeGreaterThanOrEqual(2);
  });

  it('accepts safe SVG upload and rejects active SVG', async () => {
    const safe = await request(app).post('/api/qr/upload-image').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), { filename: 'logo.svg', contentType: 'image/svg+xml' });
    expect(safe.status).toBe(200);
    expect(safe.body.file).toContain('/uploads/');

    const unsafe = await request(app).post('/api/qr/upload-image').attach('file', Buffer.from('<svg><script>alert(1)</script></svg>'), { filename: 'evil.svg', contentType: 'image/svg+xml' });
    expect(unsafe.status).toBe(400);
  });

  it('rejects active SVG event handlers beyond onload', async () => {
    const unsafe = await request(app).post('/api/qr/upload-image').attach('file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect onmouseover="alert(1)"/></svg>'), { filename: 'evil.svg', contentType: 'image/svg+xml' });
    expect(unsafe.status).toBe(400);
  });

  it('validates dynamic landing payloads before storing them', async () => {
    const result = await request(app).post('/api/qr-codes').send({
      mode: 'dynamic_payload', contentType: 'social',
      contentPayload: { links: [{ label: 'Unsafe', url: 'javascript:alert(1)' }] }
    });
    expect(result.status).toBe(400);
    expect((await request(app).get('/api/qr-codes')).body).toEqual([]);
  });

  it('protects management reads and writes when configured', async () => {
    process.env.ADMIN_TOKEN = 'test-only-token';
    expect((await request(app).get('/api/qr-codes')).status).toBe(401);
    expect((await request(app).post('/api/qr-codes').send({})).status).toBe(401);
    expect((await request(app).get('/api/qr-codes').set('x-admin-token', 'test-only-token')).status).toBe(200);
  });
});
