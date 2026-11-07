import { describe, expect, it } from 'vitest';
import { extractPassToken, generateToken, hashToken, safeEqual } from '../src/server/tokens';

describe('pass tokens', () => {
  it('generates distinct 256-bit base64url tokens', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));
    expect(tokens.size).toBe(1000);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically without revealing the token', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  it('extracts tokens from raw codes and pass URLs only', () => {
    const token = 'A'.repeat(43);
    expect(extractPassToken(token)).toBe(token);
    expect(extractPassToken(` https://gate.example/p/${token} `)).toBe(token);
    expect(extractPassToken(`https://gate.example/p/${token}/?utm=x`)).toBe(token);
    expect(extractPassToken(`https://gate.example/p/${token}x`)).toBeNull();
    expect(extractPassToken('A'.repeat(42))).toBeNull();
    expect(extractPassToken(`https://gate.example/other/${token}`)).toBeNull();
    expect(extractPassToken("' OR 1=1 --")).toBeNull();
  });

  it('compares secrets of different lengths without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
