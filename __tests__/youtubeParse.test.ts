import { describe, it, expect } from 'vitest';
import { isCountOrDate, parseUploadDate, parseViewCount, pickDuration } from '../src/shared/youtube-parse';

// The text on a YouTube card. The current forms are from a capture of the home page and
// the watch-page sidebar in November 2026; the older ones must keep working too.

describe('parseViewCount', () => {
  it('reads the long form in a card\'s accessibility label', () => {
    expect(parseViewCount('36 thousand views')).toBe(36_000);
    expect(parseViewCount('1.2 million views')).toBe(1_200_000);
    expect(parseViewCount('2.5 billion views')).toBe(2_500_000_000);
    expect(parseViewCount('812 views')).toBe(812);
    expect(parseViewCount('1 view')).toBe(1);
  });

  it('still reads the older short form', () => {
    expect(parseViewCount('1.2M views')).toBe(1_200_000);
    expect(parseViewCount('123K views')).toBe(123_000);
    expect(parseViewCount('1,234 views')).toBe(1234);
  });

  it('finds the count among the other pieces of a card', () => {
    expect(parseViewCount('Some Channel · 36 thousand views · 2 days ago')).toBe(36_000);
  });

  it('gives 0 when no count is there', () => {
    for (const text of ['', 'No views', 'Some Channel', '36K', '2 days ago']) expect(parseViewCount(text)).toBe(0);
  });
});

describe('parseUploadDate', () => {
  it('reads how long ago a video was posted', () => {
    expect(parseUploadDate('36 thousand views · 2 days ago')).toBe('2 days ago');
    expect(parseUploadDate('1 year ago')).toBe('1 year ago');
    expect(parseUploadDate('Streamed 3 hours ago')).toBe('3 hours ago');
  });

  it('gives nothing for the abbreviated form or when no date is there', () => {
    expect(parseUploadDate('2d ago')).toBeUndefined();
    expect(parseUploadDate('36 thousand views')).toBeUndefined();
  });
});

describe('pickDuration', () => {
  it('takes the badge that reads as a time', () => {
    expect(pickDuration(['12:34'])).toBe('12:34');
    expect(pickDuration(['1:02:03'])).toBe('1:02:03');
    expect(pickDuration(['New', ' 4:05 ', 'CC'])).toBe('4:05');
  });

  it('ignores badges that are not a length', () => {
    expect(pickDuration(['Sponsored'])).toBeUndefined();
    expect(pickDuration(['LIVE', 'New'])).toBeUndefined();
    expect(pickDuration([])).toBeUndefined();
  });
});

describe('isCountOrDate', () => {
  it('recognises views, dates and live counts in either form', () => {
    for (const text of ['36 thousand views', '1.2M views', '36K', '1,234', '2 days ago', '2d ago', '412 watching', 'Streamed 3 hours ago', 'Premiered 2 days ago', '', '  ']) {
      expect(isCountOrDate(text)).toBe(true);
    }
  });

  it('lets channel names through, including ones with numbers', () => {
    for (const text of ['Some Channel', 'Channel 5 News', '3Blue1Brown', 'MKBHD', 'Agora Viewpoints']) {
      expect(isCountOrDate(text)).toBe(false);
    }
  });
});
