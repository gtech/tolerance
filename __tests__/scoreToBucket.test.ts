import { describe, it, expect } from 'vitest';
import { scoreToBucket } from '../src/shared/constants';

describe('scoreToBucket', () => {
  describe('reddit (default platform)', () => {
    it('returns "high" at threshold (70)', () => {
      expect(scoreToBucket(70)).toBe('high');
    });

    it('returns "medium" just below high threshold (69)', () => {
      expect(scoreToBucket(69)).toBe('medium');
    });

    it('returns "medium" at threshold (40)', () => {
      expect(scoreToBucket(40)).toBe('medium');
    });

    it('returns "low" just below medium threshold (39)', () => {
      expect(scoreToBucket(39)).toBe('low');
    });

    it('returns "low" for score 0', () => {
      expect(scoreToBucket(0)).toBe('low');
    });

    it('returns "high" for score 100', () => {
      expect(scoreToBucket(100)).toBe('high');
    });

    it('defaults to reddit when no platform specified', () => {
      expect(scoreToBucket(70)).toBe('high');
      expect(scoreToBucket(69)).toBe('medium');
    });
  });

  describe('twitter', () => {
    it('returns "high" at threshold (48)', () => {
      expect(scoreToBucket(48, 'twitter')).toBe('high');
    });

    it('returns "medium" just below high threshold (47)', () => {
      expect(scoreToBucket(47, 'twitter')).toBe('medium');
    });

    it('returns "medium" at threshold (38)', () => {
      expect(scoreToBucket(38, 'twitter')).toBe('medium');
    });

    it('returns "low" just below medium threshold (37)', () => {
      expect(scoreToBucket(37, 'twitter')).toBe('low');
    });
  });

  describe('youtube', () => {
    it('returns "high" at threshold (55)', () => {
      expect(scoreToBucket(55, 'youtube')).toBe('high');
    });

    it('returns "medium" just below high threshold (54)', () => {
      expect(scoreToBucket(54, 'youtube')).toBe('medium');
    });

    it('returns "medium" at threshold (40)', () => {
      expect(scoreToBucket(40, 'youtube')).toBe('medium');
    });

    it('returns "low" just below medium threshold (39)', () => {
      expect(scoreToBucket(39, 'youtube')).toBe('low');
    });
  });

  describe('instagram', () => {
    it('returns "high" at threshold (55)', () => {
      expect(scoreToBucket(55, 'instagram')).toBe('high');
    });

    it('returns "medium" just below high threshold (54)', () => {
      expect(scoreToBucket(54, 'instagram')).toBe('medium');
    });

    it('returns "medium" at threshold (40)', () => {
      expect(scoreToBucket(40, 'instagram')).toBe('medium');
    });

    it('returns "low" just below medium threshold (39)', () => {
      expect(scoreToBucket(39, 'instagram')).toBe('low');
    });
  });
});
