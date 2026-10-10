import { beforeEach, describe, expect, it, vi } from 'vitest';
import { YourlsClient } from '../src/yourls/client';

describe('YourlsClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('uses dev fallback without live secrets', async () => {
    const client = new YourlsClient({ shortDomain: 'http://localhost:3000/r' });
    const result = await client.shorten('https://example.com', 'custom');
    expect(result.shorturl).toBe('http://localhost:3000/r/custom');
    expect(result.longurl).toBe('https://example.com');
  });

  it('sends passwordless signature server-side', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      statusCode: 200,
      shorturl: 'https://tiny/abc',
      url: { keyword: 'abc', url: 'https://example.com', shorturl: 'https://tiny/abc' }
    })));
    const client = new YourlsClient({ apiUrl: 'https://tiny/yourls-api.php', signature: 'secret' });
    const result = await client.shorten('https://example.com', 'abc');
    expect(result.shorturl).toBe('https://tiny/abc');
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('signature')).toBe('secret');
    expect(body.get('action')).toBe('shorturl');
  });
});
