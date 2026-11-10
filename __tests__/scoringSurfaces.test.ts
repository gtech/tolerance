import { describe, it, expect } from 'vitest';
import { canScoreFrom, isMessagingPath, isScorableUrl, SCORE_MESSAGE_PLATFORM } from '../src/shared/scoring-surfaces';
import { isUnfilteredTwitterPath } from '../src/content/twitter/paths';

// People's private messages must never reach the scoring model.

const MESSAGING_URLS: [string, string][] = [
  ['SCORE_TWEETS', 'https://x.com/messages'],
  ['SCORE_TWEETS', 'https://x.com/messages/1234-5678'],
  ['SCORE_TWEETS', 'https://x.com/messages/compose'],
  ['SCORE_TWEETS', 'https://x.com/i/chat'],
  ['SCORE_TWEETS', 'https://x.com/i/chat/1234-5678'],
  ['SCORE_TWEETS', 'https://twitter.com/messages'],
  ['SCORE_TWEETS', 'https://x.com/Messages'],
  ['SCORE_FACEBOOK_POSTS', 'https://www.facebook.com/messages'],
  ['SCORE_FACEBOOK_POSTS', 'https://www.facebook.com/messages/t/1234'],
  ['SCORE_FACEBOOK_POSTS', 'https://www.facebook.com/messages/e2ee/t/1234'],
  ['SCORE_INSTAGRAM_POSTS', 'https://www.instagram.com/direct/inbox/'],
  ['SCORE_INSTAGRAM_POSTS', 'https://www.instagram.com/direct/t/1234/'],
  ['SCORE_POSTS', 'https://old.reddit.com/message/inbox/'],
  ['SCORE_POSTS', 'https://old.reddit.com/message/messages/abc'],
  ['SCORE_POSTS', 'https://www.reddit.com/message/inbox'],
  ['SCORE_POSTS', 'https://www.reddit.com/chat'],
  ['SCORE_POSTS', 'https://www.reddit.com/chat/room/abc'],
];

const FEED_URLS: [string, string][] = [
  ['SCORE_TWEETS', 'https://x.com/home'],
  ['SCORE_TWEETS', 'https://x.com/explore'],
  ['SCORE_TWEETS', 'https://x.com/someuser'],
  ['SCORE_TWEETS', 'https://x.com/i/lists/1234'],
  ['SCORE_TWEETS', 'https://x.com/i/bookmarks'],
  ['SCORE_TWEETS', 'https://x.com/messagesfan'],       // a username, not the inbox
  ['SCORE_TWEETS', 'https://twitter.com/home'],
  ['SCORE_FACEBOOK_POSTS', 'https://www.facebook.com/'],
  ['SCORE_FACEBOOK_POSTS', 'https://www.facebook.com/groups/1234/'],
  ['SCORE_INSTAGRAM_POSTS', 'https://www.instagram.com/'],
  ['SCORE_INSTAGRAM_POSTS', 'https://www.instagram.com/someuser/'],
  ['SCORE_INSTAGRAM_POSTS', 'https://www.instagram.com/directed.by.sam/'],
  ['SCORE_POSTS', 'https://www.reddit.com/'],
  ['SCORE_POSTS', 'https://www.reddit.com/r/chat/'],
  ['SCORE_POSTS', 'https://www.reddit.com/r/programming/hot'],
  ['SCORE_POSTS', 'https://old.reddit.com/r/all/'],
  ['SCORE_POSTS', 'https://old.reddit.com/user/someone'],
  ['SCORE_VIDEOS', 'https://www.youtube.com/'],
  ['SCORE_VIDEOS', 'https://www.youtube.com/watch?v=abc'],
  ['SCORE_VIDEOS', 'https://www.youtube.com/feed/subscriptions'],
];

describe('canScoreFrom', () => {
  it.each(MESSAGING_URLS)('refuses %s from %s', (type, url) => {
    expect(canScoreFrom(type, [url])).toBe(false);
    expect(canScoreFrom(type, [url, url])).toBe(false);
  });

  it.each(FEED_URLS)('allows %s from %s', (type, url) => {
    expect(canScoreFrom(type, [url])).toBe(true);
    expect(canScoreFrom(type, [url, undefined])).toBe(true);
  });

  it('refuses when either the frame or the tab is on a messaging page', () => {
    expect(canScoreFrom('SCORE_TWEETS', ['https://x.com/home', 'https://x.com/messages'])).toBe(false);
    expect(canScoreFrom('SCORE_TWEETS', ['https://x.com/messages/1', 'https://x.com/home'])).toBe(false);
  });

  it('refuses when the sender is unknown', () => {
    expect(canScoreFrom('SCORE_TWEETS', [])).toBe(false);
    expect(canScoreFrom('SCORE_TWEETS', [undefined, undefined])).toBe(false);
    expect(canScoreFrom('SCORE_TWEETS', ['not a url'])).toBe(false);
  });

  it('refuses a scoring message from another site or an extension page', () => {
    expect(canScoreFrom('SCORE_TWEETS', ['https://www.facebook.com/'])).toBe(false);
    expect(canScoreFrom('SCORE_FACEBOOK_POSTS', ['https://www.messenger.com/t/1234'])).toBe(false);
    expect(canScoreFrom('SCORE_POSTS', ['https://chat.reddit.com/room/abc'])).toBe(false);
    expect(canScoreFrom('SCORE_POSTS', ['https://mail.google.com/mail/u/0/'])).toBe(false);
    expect(canScoreFrom('SCORE_POSTS', ['chrome-extension://abcdef/dashboard/index.html'])).toBe(false);
    expect(canScoreFrom('SCORE_TWEETS', ['https://x.com.evil.example/home'])).toBe(false);
  });

  it('refuses message types it does not know', () => {
    expect(canScoreFrom('SCORE_SOMETHING_NEW', ['https://x.com/home'])).toBe(false);
  });

  it('knows every scoring message the background handles', () => {
    expect(Object.keys(SCORE_MESSAGE_PLATFORM).sort()).toEqual([
      'SCORE_FACEBOOK_POSTS', 'SCORE_INSTAGRAM_POSTS', 'SCORE_POSTS', 'SCORE_TWEETS', 'SCORE_VIDEOS',
    ]);
  });
});

describe('isScorableUrl', () => {
  it('ignores query strings and fragments', () => {
    expect(isScorableUrl('twitter', 'https://x.com/messages?foo=1#bar')).toBe(false);
    expect(isScorableUrl('twitter', 'https://x.com/home?next=/messages')).toBe(true);
  });
});

describe('Twitter content script', () => {
  it('leaves DM pages alone entirely', () => {
    for (const path of ['/messages', '/messages/1234-5678', '/i/chat', '/i/chat/1234']) {
      expect(isMessagingPath('twitter', path)).toBe(true);
      expect(isUnfilteredTwitterPath(path)).toBe(true);
    }
  });

  it('still filters feeds', () => {
    for (const path of ['/home', '/explore', '/someuser', '/i/lists/1234', '/messagesfan']) {
      expect(isUnfilteredTwitterPath(path)).toBe(false);
    }
  });
});
