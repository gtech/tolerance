import { describe, it, expect } from 'vitest';
import { isWhitelisted, normalizeSourceId, type WhitelistEntry } from '../src/shared/types';
import { isSubscribed } from '../src/background/subscriptions';

// Source names as compared for trusted sources and Subscriptions Only. The old pattern
// stripped any leading run of "@", "u" and "/", which ate the first letter of every
// name starting with "u".

describe('normalizeSourceId', () => {
  it('lower-cases and drops a leading @ or u/', () => {
    expect(normalizeSourceId('@MKBHD')).toBe('mkbhd');
    expect(normalizeSourceId('u/Someone')).toBe('someone');
    expect(normalizeSourceId('/u/Someone')).toBe('someone');
    expect(normalizeSourceId('  Plain  ')).toBe('plain');
  });

  it('keeps names that start with u', () => {
    expect(normalizeSourceId('UndecidedMF')).toBe('undecidedmf');
    expect(normalizeSourceId('@uber')).toBe('uber');
    expect(normalizeSourceId('u/uuu')).toBe('uuu');
  });
});

describe('isSubscribed', () => {
  const list = { youtube: ['undecidedmf', 'mkbhd'], reddit: [], twitter: [], instagram: [] };

  it('matches a channel whose handle starts with u', () => {
    expect(isSubscribed('UndecidedMF', 'youtube', list as never)).toBe(true);
    expect(isSubscribed('@MKBHD', 'youtube', list as never)).toBe(true);
    expect(isSubscribed('ndecidedmf', 'youtube', list as never)).toBe(false);
  });
});

describe('isWhitelisted', () => {
  const entry = (sourceId: string): WhitelistEntry => ({ sourceId, platform: 'twitter', createdAt: 0 } as WhitelistEntry);

  it('does not treat "uber" and "ber" as the same source', () => {
    expect(isWhitelisted('ber', 'twitter', [entry('@uber')])).toBe(false);
    expect(isWhitelisted('Uber', 'twitter', [entry('@uber')])).toBe(true);
  });

  it('is scoped to the platform', () => {
    expect(isWhitelisted('uber', 'reddit', [entry('@uber')])).toBe(false);
  });
});
