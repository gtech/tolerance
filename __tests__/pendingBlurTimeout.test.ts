import { describe, it, expect } from 'vitest';
import { pendingBlurTimeoutMs } from '../src/shared/types';

describe('pendingBlurTimeoutMs', () => {
  it('defaults to 15 seconds when unset', () => {
    expect(pendingBlurTimeoutMs(undefined)).toBe(15000);
  });

  it('converts seconds to milliseconds', () => {
    expect(pendingBlurTimeoutMs(30)).toBe(30000);
  });

  it('returns null (wait until scored) for 0', () => {
    expect(pendingBlurTimeoutMs(0)).toBeNull();
  });
});
