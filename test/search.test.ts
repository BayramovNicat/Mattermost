import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import {
  buildChannelSearchTerms,
  extractHighlightTerms,
  hasExplicitInModifier,
  splitHighlightedText,
} from '../src/utils/search';
import { createDevServer } from '../vite';

describe('search utilities', () => {
  test('builds channel-scoped Mattermost search terms for channels, DMs, and GMs', () => {
    expect(buildChannelSearchTerms('deploy error', { name: 'town-square', type: 'O' })).toBe(
      'in:town-square deploy error',
    );

    expect(buildChannelSearchTerms('invoice', { name: 'secret-ops', type: 'P' })).toBe(
      'in:secret-ops invoice',
    );

    expect(
      buildChannelSearchTerms('lunch tomorrow', {
        name: 'uid1__uid2',
        type: 'D',
        otherUser: { username: 'alice' },
      }),
    ).toBe('in:@alice lunch tomorrow');

    expect(buildChannelSearchTerms('roadmap', { name: 'gmhash123', type: 'G' })).toBe(
      'in:gmhash123 roadmap',
    );

    expect(
      buildChannelSearchTerms('in:other-channel release', { name: 'town-square', type: 'O' }),
    ).toBe('in:other-channel release');

    expect(buildChannelSearchTerms('   ', { name: 'town-square', type: 'O' })).toBe('');
    expect(hasExplicitInModifier('foo in:general')).toBe(true);
    expect(hasExplicitInModifier('in:general foo')).toBe(true);
    expect(hasExplicitInModifier('login:error')).toBe(false);
  });

  test('extracts highlight terms while ignoring Mattermost modifiers and splits text safely', () => {
    const terms = extractHighlightTerms('from:@alice "deploy fix" before:2026-01-01 regex(1)', [
      'deploy',
    ]);
    expect(terms).toContain('deploy fix');
    expect(terms).toContain('deploy');
    expect(terms).toContain('regex(1)');
    expect(terms).not.toContain('from:@alice');
    expect(terms).not.toContain('before:2026-01-01');

    const segments = splitHighlightedText('Shipped the Deploy Fix for regex(1) today', terms);
    expect(segments.some((s) => s.highlighted && s.text.toLowerCase() === 'deploy fix')).toBe(true);
    expect(segments.some((s) => s.highlighted && s.text === 'regex(1)')).toBe(true);
    expect(segments.map((s) => s.text).join('')).toBe('Shipped the Deploy Fix for regex(1) today');
  });
});

describe('in-conversation search UI & API flow', () => {
  let server: Server<unknown>;
  let mockBackend: Server<unknown>;
  let webview: Bun.WebView;
  let prevProxyTarget: string | undefined;
  const searchRequests: string[] = [];

  beforeAll(async () => {
    prevProxyTarget = process.env.VITE_PROXY_TARGET;

    mockBackend = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/api/me') {
          return Response.json({ id: 'user-me', username: 'me' });
        }

        if (url.pathname === '/api/channels') {
          return Response.json([
            { id: 'ch-eng', name: 'engineering', display_name: 'Engineering', type: 'O' },
          ]);
        }

        if (url.pathname === '/api/channels/ch-eng/search') {
          const q = url.searchParams.get('q') || '';
          searchRequests.push(q);

          if (q.toLowerCase().includes('deploy')) {
            return Response.json({
              order: ['post-loaded-2', 'post-old-99'],
              posts: {
                'post-loaded-2': {
                  id: 'post-loaded-2',
                  user_id: 'user-alice',
                  channel_id: 'ch-eng',
                  message: 'The production deploy completed cleanly!',
                  create_at: Date.now() - 120_000,
                },
                'post-old-99': {
                  id: 'post-old-99',
                  user_id: 'user-me',
                  channel_id: 'ch-eng',
                  message: 'Older deploy checklist from last month',
                  create_at: Date.now() - 30 * 24 * 60 * 60 * 1000,
                },
              },
              matches: {
                'post-loaded-2': ['deploy'],
                'post-old-99': ['deploy'],
              },
              users: {
                'user-alice': { id: 'user-alice', username: 'alice', display_name: 'Alice' },
                'user-me': { id: 'user-me', username: 'me', display_name: 'Me' },
              },
              query: q,
              channelId: 'ch-eng',
            });
          }

          return Response.json({
            order: [],
            posts: {},
            matches: {},
            users: {},
            query: q,
            channelId: 'ch-eng',
          });
        }

        if (url.pathname === '/api/channels/ch-eng/posts') {
          const before = url.searchParams.get('before');
          const after = url.searchParams.get('after');

          if (before === 'post-old-99') {
            const base = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const order: string[] = [];
            const posts: Record<string, unknown> = {};
            for (let i = 0; i < 15; i++) {
              const id = `post-old-before-${i}`;
              order.push(id);
              posts[id] = {
                id,
                user_id: 'user-alice',
                channel_id: 'ch-eng',
                message: `Previous message ${i} before old deploy`,
                create_at: base - (i + 1) * 60_000,
              };
            }
            return Response.json({
              order,
              posts,
              users: {
                'user-alice': { id: 'user-alice', username: 'alice', display_name: 'Alice' },
              },
            });
          }

          if (after === 'post-old-99') {
            const base = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const order: string[] = [];
            const posts: Record<string, unknown> = {};
            for (let i = 14; i >= 0; i--) {
              const id = `post-old-after-${i}`;
              order.push(id);
              posts[id] = {
                id,
                user_id: 'user-alice',
                channel_id: 'ch-eng',
                message: `Follow-up message ${i} after old deploy`,
                create_at: base + (i + 1) * 60_000,
              };
            }
            return Response.json({
              order,
              posts,
              users: {
                'user-alice': { id: 'user-alice', username: 'alice', display_name: 'Alice' },
              },
            });
          }

          return Response.json({
            order: ['post-loaded-3', 'post-loaded-2', 'post-loaded-1'],
            posts: {
              'post-loaded-1': {
                id: 'post-loaded-1',
                user_id: 'user-me',
                channel_id: 'ch-eng',
                message: 'Morning everyone',
                create_at: Date.now() - 300_000,
              },
              'post-loaded-2': {
                id: 'post-loaded-2',
                user_id: 'user-alice',
                channel_id: 'ch-eng',
                message: 'The production deploy completed cleanly!',
                create_at: Date.now() - 120_000,
              },
              'post-loaded-3': {
                id: 'post-loaded-3',
                user_id: 'user-me',
                channel_id: 'ch-eng',
                message: 'Great job team',
                create_at: Date.now() - 60_000,
              },
            },
            users: {
              'user-alice': { id: 'user-alice', username: 'alice', display_name: 'Alice' },
              'user-me': { id: 'user-me', username: 'me', display_name: 'Me' },
            },
          });
        }

        return Response.json({});
      },
    });

    process.env.VITE_PROXY_TARGET = `http://localhost:${mockBackend.port}`;
    server = createDevServer(0, false);
    webview = new Bun.WebView();
    await webview.navigate(`http://localhost:${server.port}`);
  });

  afterAll(async () => {
    await webview.close();
    server.stop(true);
    mockBackend.stop(true);
    if (prevProxyTarget === undefined) {
      delete process.env.VITE_PROXY_TARGET;
    } else {
      process.env.VITE_PROXY_TARGET = prevProxyTarget;
    }
  });

  test('opens conversation search, highlights matches, jumps directly to loaded or older post in conversation window, and jumps back to latest', async () => {
    const result = (await webview.evaluate(`(async () => {
      let attempts = 0;
      while (!document.querySelector('article[data-post-id="post-loaded-2"]') && attempts < 60) {
        await new Promise(r => setTimeout(r, 30));
        attempts++;
      }

      const draftInput = document.querySelector('#chat-message-input');
      if (draftInput) {
        draftInput.value = 'Unsent draft message';
      }

      const searchBtn = document.querySelector('#search-chat-button');
      searchBtn?.click();
      await new Promise(r => setTimeout(r, 40));

      const searchInput = document.querySelector('#conversation-search-input');
      const focusedOnOpen = document.activeElement === searchInput;

      if (searchInput) {
        searchInput.value = 'deploy';
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      }

      let waitResults = 0;
      while (document.querySelectorAll('article[data-search-post-id]').length < 2 && waitResults < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitResults++;
      }

      const resultCards = document.querySelectorAll('article[data-search-post-id]');
      const marks = Array.from(document.querySelectorAll('article[data-search-post-id] mark')).map(
        m => m.textContent?.toLowerCase()
      );

      const loadedResultBtn = document.querySelector('article[data-search-post-id="post-loaded-2"] button');
      loadedResultBtn?.click();
      await new Promise(r => setTimeout(r, 30));

      const jumpedArticle = document.querySelector('article[data-post-id="post-loaded-2"]');
      const jumpedHighlighted = jumpedArticle?.classList.contains('ring-indigo-500/70') ?? false;

      const oldResultBtn = document.querySelector('article[data-search-post-id="post-old-99"] button');
      oldResultBtn?.click();
      let waitOldPost = 0;
      while (!document.querySelector('article[data-post-id="post-old-99"]') && waitOldPost < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitOldPost++;
      }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const oldArticleInChat = document.querySelector('article[data-post-id="post-old-99"]');
      const oldArticleHighlighted = oldArticleInChat?.classList.contains('ring-indigo-500/70') ?? false;
      const hasBeforeInChat = !!document.querySelector('article[data-post-id="post-old-before-0"]');
      const hasAfterInChat = !!document.querySelector('article[data-post-id="post-old-after-0"]');
      const searchStillOpenWithResults =
        document.querySelectorAll('article[data-search-post-id]').length === 2;

      const jumpLatestBtn = document.querySelector('#jump-to-latest-button');
      const jumpBannerVisible = !!jumpLatestBtn && !jumpLatestBtn.parentElement?.classList.contains('hidden');

      jumpLatestBtn?.click();
      let waitLatest = 0;
      while (!document.querySelector('article[data-post-id="post-loaded-3"]') && waitLatest < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitLatest++;
      }
      const restoredLatest = !!document.querySelector('article[data-post-id="post-loaded-3"]');
      const jumpBannerHiddenAfterLatest =
        document.querySelector('#jump-to-latest-button')?.parentElement?.classList.contains('hidden') ?? true;

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 30));

      return {
        focusedOnOpen,
        resultCount: resultCards.length,
        marks,
        jumpedHighlighted,
        oldArticleInChat: !!oldArticleInChat,
        oldArticleHighlighted,
        hasBeforeInChat,
        hasAfterInChat,
        searchStillOpenWithResults,
        jumpBannerVisible,
        restoredLatest,
        jumpBannerHiddenAfterLatest,
        closedOnEscape: !document.querySelector('#conversation-search-input'),
        draftPreserved: document.querySelector('#chat-message-input')?.value === 'Unsent draft message',
      };
    })()`)) as {
      focusedOnOpen: boolean;
      resultCount: number;
      marks: string[];
      jumpedHighlighted: boolean;
      oldArticleInChat: boolean;
      oldArticleHighlighted: boolean;
      hasBeforeInChat: boolean;
      hasAfterInChat: boolean;
      searchStillOpenWithResults: boolean;
      jumpBannerVisible: boolean;
      restoredLatest: boolean;
      jumpBannerHiddenAfterLatest: boolean;
      closedOnEscape: boolean;
      draftPreserved: boolean;
    };

    expect(result.focusedOnOpen).toBe(true);
    expect(result.resultCount).toBe(2);
    expect(result.marks).toEqual(['deploy', 'deploy']);
    expect(result.jumpedHighlighted).toBe(true);
    expect(result.oldArticleInChat).toBe(true);
    expect(result.oldArticleHighlighted).toBe(true);
    expect(result.hasBeforeInChat).toBe(true);
    expect(result.hasAfterInChat).toBe(true);
    expect(result.searchStillOpenWithResults).toBe(true);
    expect(result.jumpBannerVisible).toBe(true);
    expect(result.restoredLatest).toBe(true);
    expect(result.jumpBannerHiddenAfterLatest).toBe(true);
    expect(result.closedOnEscape).toBe(true);
    expect(result.draftPreserved).toBe(true);
    expect(searchRequests).toContain('deploy');
  });

  test('opens conversation search with Cmd+F shortcut', async () => {
    const result = (await webview.evaluate(`(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }));
      await new Promise(r => setTimeout(r, 40));
      const input = document.querySelector('#conversation-search-input');
      return {
        opened: !!input,
        focused: document.activeElement === input,
      };
    })()`)) as { opened: boolean; focused: boolean };

    expect(result.opened).toBe(true);
    expect(result.focused).toBe(true);
  });
});
