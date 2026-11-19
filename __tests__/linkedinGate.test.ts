import { describe, it, expect } from 'vitest';
import { isLinkedInFeedPath, liGateCss, LI_POST_ID_ATTR, LI_DONE_ATTR } from '../src/content/linkedin/gate';
import { LINKEDIN_SITE, OPTIONAL_SITES } from '../src/shared/optional-sites';
import manifest from '../manifest.json';
import firefoxManifest from '../manifest.firefox.json';

describe('LinkedIn', () => {
  it('scores the home feed and nothing else', () => {
    expect(isLinkedInFeedPath('/feed/')).toBe(true);
    expect(isLinkedInFeedPath('/feed')).toBe(true);
    for (const path of ['/', '/messaging/', '/messaging/thread/2-abc/', '/in/someone/', '/feed/update/urn:li:activity:1/', '/notifications/', '/jobs/', '/search/results/all/']) {
      expect(isLinkedInFeedPath(path), path).toBe(false);
    }
  });

  it('gates only unhandled posts inside the feed list', () => {
    const css = liGateCss('scope');
    expect(css).toContain('html.scope [data-testid="mainFeed"] [role="listitem"][componentkey^="update-card-"]');
    expect(css).toContain(`:not([${LI_POST_ID_ATTR}])`);
    expect(css).toContain(`:not([${LI_DONE_ATTR}])`);
  });

  it('is an optional site in both manifests, not an install permission', () => {
    expect(OPTIONAL_SITES).toContain(LINKEDIN_SITE);
    for (const m of [manifest, firefoxManifest] as { optional_host_permissions: string[]; host_permissions?: string[] }[]) {
      for (const origin of LINKEDIN_SITE.origins) {
        expect(m.optional_host_permissions).toContain(origin);
        expect(m.host_permissions ?? []).not.toContain(origin);
      }
    }
  });
});
