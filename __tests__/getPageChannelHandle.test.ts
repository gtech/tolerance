import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// The regex used by getPageChannelHandle to extract @handle from ytInitialData
const CANONICAL_BASE_URL_RE = /"canonicalBaseUrl"\s*:\s*"\/@([^"]+)"/;

describe('getPageChannelHandle', () => {
  describe('canonicalBaseUrl regex against real YouTube HTML', () => {
    const htmlPath = path.resolve(__dirname, '../../data/youtube_foresight.html');
    let htmlContent: string;

    beforeEach(() => {
      htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    });

    it('should find canonicalBaseUrl in the saved HTML', () => {
      expect(htmlContent).toContain('canonicalBaseUrl');
    });

    it('should extract @ForesightInstitute handle from /channel/ page HTML', () => {
      const match = htmlContent.match(CANONICAL_BASE_URL_RE);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('ForesightInstitute');
    });

    it('should NOT find any /@handle hrefs in the DOM (confirming the problem)', () => {
      // On /channel/UCxxx pages, there are no href="/@..." links
      expect(htmlContent).not.toMatch(/href="\/@[^"]+"/);
    });

    it('should contain the channel ID in the URL structure', () => {
      expect(htmlContent).toContain('UCg5UVUMqXeCQ03MelT_RXMg');
    });
  });

  describe('URL pattern matching', () => {
    const handleUrlRe = /^\/@([^/?]+)/;
    const channelUrlRe = /^\/channel\/([^/?]+)/;

    it('should extract handle from /@handle URL', () => {
      const match = '/@3blue1brown/videos'.match(handleUrlRe);
      expect(match![1]).toBe('3blue1brown');
    });

    it('should extract handle from /@handle URL without subpath', () => {
      const match = '/@MKBHD'.match(handleUrlRe);
      expect(match![1]).toBe('MKBHD');
    });

    it('should NOT match /channel/ URLs with handle regex', () => {
      const match = '/channel/UCg5UVUMqXeCQ03MelT_RXMg/videos'.match(handleUrlRe);
      expect(match).toBeNull();
    });

    it('should extract channel ID from /channel/ URL', () => {
      const match = '/channel/UCg5UVUMqXeCQ03MelT_RXMg/videos'.match(channelUrlRe);
      expect(match![1]).toBe('UCg5UVUMqXeCQ03MelT_RXMg');
    });

    it('should extract channel ID from /channel/ URL without subpath', () => {
      const match = '/channel/UCg5UVUMqXeCQ03MelT_RXMg'.match(channelUrlRe);
      expect(match![1]).toBe('UCg5UVUMqXeCQ03MelT_RXMg');
    });

    it('should not match homepage', () => {
      expect('/'.match(handleUrlRe)).toBeNull();
      expect('/'.match(channelUrlRe)).toBeNull();
    });

    it('should not match watch page', () => {
      expect('/watch?v=abc123'.match(handleUrlRe)).toBeNull();
      expect('/watch?v=abc123'.match(channelUrlRe)).toBeNull();
    });
  });

  describe('simulated getPageChannelHandle logic', () => {
    // Replicate the function logic without requiring DOM/window mocking
    function getPageChannelHandle(
      pathname: string,
      scriptContents: string[]
    ): string | null {
      // 1. /@handle URL
      const handleMatch = pathname.match(/^\/@([^/?]+)/);
      if (handleMatch) return handleMatch[1];

      // 2. /channel/ page — extract from script data
      if (pathname.startsWith('/channel/')) {
        for (const text of scriptContents) {
          if (text.includes('canonicalBaseUrl')) {
            const match = text.match(/"canonicalBaseUrl"\s*:\s*"\/@([^"]+)"/);
            if (match) return match[1];
          }
        }

        // 3. Fall back to channel ID
        const channelMatch = pathname.match(/^\/channel\/([^/?]+)/);
        if (channelMatch) return channelMatch[1];
      }

      return null;
    }

    it('should return handle from /@handle URL', () => {
      expect(getPageChannelHandle('/@3blue1brown/videos', [])).toBe('3blue1brown');
    });

    it('should extract handle from script data on /channel/ page', () => {
      const scriptData = '{"canonicalBaseUrl":"/@ForesightInstitute"}';
      expect(
        getPageChannelHandle('/channel/UCg5UVUMqXeCQ03MelT_RXMg/videos', [scriptData])
      ).toBe('ForesightInstitute');
    });

    it('should fall back to channel ID when no canonicalBaseUrl in scripts', () => {
      expect(
        getPageChannelHandle('/channel/UCg5UVUMqXeCQ03MelT_RXMg/videos', ['no relevant data'])
      ).toBe('UCg5UVUMqXeCQ03MelT_RXMg');
    });

    it('should fall back to channel ID when scripts are empty', () => {
      expect(
        getPageChannelHandle('/channel/UCg5UVUMqXeCQ03MelT_RXMg', [])
      ).toBe('UCg5UVUMqXeCQ03MelT_RXMg');
    });

    it('should return null on non-channel pages', () => {
      expect(getPageChannelHandle('/', [])).toBeNull();
      expect(getPageChannelHandle('/watch?v=abc', [])).toBeNull();
      expect(getPageChannelHandle('/results?search=test', [])).toBeNull();
    });

    it('should prefer /@handle URL over script data', () => {
      const scriptData = '{"canonicalBaseUrl":"/@DifferentChannel"}';
      expect(
        getPageChannelHandle('/@3blue1brown', [scriptData])
      ).toBe('3blue1brown');
    });

    it('should work with real YouTube foresight HTML data', () => {
      const htmlPath = path.resolve(__dirname, '../../data/youtube_foresight.html');
      const html = fs.readFileSync(htmlPath, 'utf-8');

      // Extract script-like chunks containing canonicalBaseUrl
      const chunks: string[] = [];
      // Split by script tags to simulate querySelectorAll('script')
      const scriptMatches = html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of scriptMatches) {
        if (m[1].includes('canonicalBaseUrl')) {
          chunks.push(m[1]);
        }
      }

      const result = getPageChannelHandle(
        '/channel/UCg5UVUMqXeCQ03MelT_RXMg/videos',
        chunks
      );
      expect(result).toBe('ForesightInstitute');
    });
  });
});
