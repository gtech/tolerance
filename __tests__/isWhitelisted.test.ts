import { describe, it, expect } from 'vitest';
import { isWhitelisted, WhitelistEntry } from '../src/shared/types';

function makeEntry(sourceId: string, platform: WhitelistEntry['platform']): WhitelistEntry {
  return { sourceId, platform, createdAt: Date.now() };
}

describe('isWhitelisted', () => {
  it('returns false for undefined whitelist', () => {
    expect(isWhitelisted('user1', 'reddit', undefined)).toBe(false);
  });

  it('returns false for empty whitelist', () => {
    expect(isWhitelisted('user1', 'reddit', [])).toBe(false);
  });

  it('matches case-insensitively', () => {
    const whitelist = [makeEntry('SomeUser', 'reddit')];
    expect(isWhitelisted('someuser', 'reddit', whitelist)).toBe(true);
    expect(isWhitelisted('SOMEUSER', 'reddit', whitelist)).toBe(true);
  });

  it('strips @ prefix from sourceId', () => {
    const whitelist = [makeEntry('username', 'twitter')];
    expect(isWhitelisted('@username', 'twitter', whitelist)).toBe(true);
  });

  it('strips u/ prefix from sourceId', () => {
    const whitelist = [makeEntry('username', 'reddit')];
    expect(isWhitelisted('u/username', 'reddit', whitelist)).toBe(true);
  });

  it('matches when whitelist entry has prefix and input does not', () => {
    const whitelist = [makeEntry('@username', 'twitter')];
    expect(isWhitelisted('username', 'twitter', whitelist)).toBe(true);
  });

  it('returns false for platform mismatch', () => {
    const whitelist = [makeEntry('username', 'reddit')];
    expect(isWhitelisted('username', 'twitter', whitelist)).toBe(false);
  });

  it('matches on second entry in list', () => {
    const whitelist = [
      makeEntry('other', 'reddit'),
      makeEntry('target', 'reddit'),
    ];
    expect(isWhitelisted('target', 'reddit', whitelist)).toBe(true);
  });
});
