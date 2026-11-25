import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { MattermostAPI } from '../server/api';
import { startServer } from '../server/index';
import { createDevServer } from '../vite';

describe('delete message API and server route', () => {
  let mockMattermost: Server<unknown>;
  let appServer: Server<unknown>;
  const receivedRequests: Array<{ method: string; path: string; auth: string | null }> = [];

  beforeAll(() => {
    mockMattermost = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        receivedRequests.push({
          method: req.method,
          path: url.pathname,
          auth: req.headers.get('authorization'),
        });

        if (req.method === 'DELETE' && url.pathname === '/api/v4/posts/post-ok') {
          return Response.json({ status: 'OK' });
        }
        if (req.method === 'DELETE' && url.pathname === '/api/v4/posts/post-no-content') {
          return new Response(null, { status: 204 });
        }
        if (req.method === 'DELETE' && url.pathname === '/api/v4/posts/post-forbidden') {
          return Response.json(
            { id: 'api.post.delete.permissions.app_error', message: 'Permission denied' },
            { status: 403 }
          );
        }
        return Response.json({ message: 'Not Found' }, { status: 404 });
      },
    });

    const api = new MattermostAPI({
      baseUrl: `http://localhost:${mockMattermost.port}`,
      token: 'test-token',
      csrfToken: 'test-csrf',
      userId: 'user-me',
      lang: 'en',
    });

    appServer = startServer(0, { api, enableWebSocket: false });
  });

  afterAll(() => {
    appServer.stop(true);
    mockMattermost.stop(true);
  });

  test('MattermostAPI.deletePost sends DELETE /api/v4/posts/:id and handles JSON and 204 responses', async () => {
    const api = new MattermostAPI({
      baseUrl: `http://localhost:${mockMattermost.port}`,
      token: 'test-token',
      csrfToken: 'test-csrf',
      userId: 'user-me',
      lang: 'en',
    });

    const okRes = await api.deletePost('post-ok');
    expect(okRes).toEqual({ status: 'OK' });

    const noContentRes = await api.deletePost('post-no-content');
    expect(noContentRes).toEqual({ status: 'OK' });

    expect(receivedRequests).toContainEqual({
      method: 'DELETE',
      path: '/api/v4/posts/post-ok',
      auth: 'Bearer test-token',
    });
  });

  test('DELETE /api/posts/:postId proxies deletion and propagates Mattermost error status', async () => {
    const res = await fetch(`http://localhost:${appServer.port}/api/posts/post-ok`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'OK' });

    const forbiddenRes = await fetch(`http://localhost:${appServer.port}/api/posts/post-forbidden`, {
      method: 'DELETE',
    });
    expect(forbiddenRes.status).toBe(403);
    const errBody = (await forbiddenRes.json()) as { error: string };
    expect(errBody.error).toContain('403');
  });
});

describe('delete message UI, grouping, search sync, and WebSocket flow', () => {
  let server: Server<unknown>;
  let mockBackend: Server<unknown>;
  let webview: Bun.WebView;
  let prevProxyTarget: string | undefined;
  const deletedPostIds: string[] = [];

  beforeAll(async () => {
    prevProxyTarget = process.env.VITE_PROXY_TARGET;

    const now = Date.now();
    const yesterdayTs = now - 24 * 60 * 60 * 1000;
    const todayTs = now - 10 * 60 * 1000;

    mockBackend = Bun.serve({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('chat');
        },
        message() {},
      },
      fetch(req, serverInstance) {
        const url = new URL(req.url);

        if (url.pathname === '/ws') {
          return serverInstance.upgrade(req, { data: undefined })
            ? undefined
            : new Response('Upgrade failed', { status: 400 });
        }

        if (url.pathname === '/api/me') {
          return Response.json({ id: 'user-me', username: 'me' });
        }

        if (url.pathname === '/api/channels') {
          return Response.json([
            { id: 'ch-general', name: 'general', display_name: 'General', type: 'O' },
          ]);
        }

        if (url.pathname === '/api/channels/ch-general/posts') {
          if (url.searchParams.get('before') || url.searchParams.get('after')) {
            return Response.json({ order: [], posts: {}, users: {} });
          }

          return Response.json({
            order: ['post-ws-target', 'post-system-1', 'post-me-2', 'post-me-1', 'post-alice-1', 'post-yesterday'],
            posts: {
              'post-yesterday': {
                id: 'post-yesterday',
                user_id: 'user-me',
                channel_id: 'ch-general',
                message: 'Yesterday standalone message',
                create_at: yesterdayTs,
              },
              'post-alice-1': {
                id: 'post-alice-1',
                user_id: 'user-alice',
                channel_id: 'ch-general',
                message: 'Alice message cannot be deleted by me',
                create_at: todayTs,
              },
              'post-me-1': {
                id: 'post-me-1',
                user_id: 'user-me',
                channel_id: 'ch-general',
                message: 'My first grouped message today',
                create_at: todayTs + 60_000,
              },
              'post-me-2': {
                id: 'post-me-2',
                user_id: 'user-me',
                channel_id: 'ch-general',
                message: 'My second grouped message today',
                create_at: todayTs + 120_000,
              },
              'post-system-1': {
                id: 'post-system-1',
                user_id: 'user-me',
                channel_id: 'ch-general',
                message: 'me joined the channel.',
                type: 'system_join_channel',
                create_at: todayTs + 180_000,
              },
              'post-ws-target': {
                id: 'post-ws-target',
                user_id: 'user-me',
                channel_id: 'ch-general',
                message: 'Message removed via websocket',
                create_at: now,
              },
            },
            users: {
              'user-me': { id: 'user-me', username: 'me', display_name: 'Me' },
              'user-alice': { id: 'user-alice', username: 'alice', display_name: 'Alice' },
            },
          });
        }

        const deleteMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
        if (deleteMatch && req.method === 'DELETE') {
          const postId = decodeURIComponent(deleteMatch[1]);
          if (postId === 'post-fail-delete') {
            return Response.json({ error: 'Cannot delete post right now' }, { status: 403 });
          }
          deletedPostIds.push(postId);
          return Response.json({ status: 'OK' });
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

  test('shows delete button only for own posts, confirms before deleting, updates grouping and date dividers', async () => {
    const result = (await webview.evaluate(`(async () => {
      let attempts = 0;
      while (!document.querySelector('article[data-post-id="post-me-1"]') && attempts < 60) {
        await new Promise(r => setTimeout(r, 30));
        attempts++;
      }

      const alicePost = document.querySelector('article[data-post-id="post-alice-1"]');
      const systemPost = document.querySelector('article[data-post-id="post-system-1"]');
      const me1Post = document.querySelector('article[data-post-id="post-me-1"]');
      const me2Post = document.querySelector('article[data-post-id="post-me-2"]');
      const yesterdayPost = document.querySelector('article[data-post-id="post-yesterday"]');

      const aliceHasDelete = !!alicePost?.querySelector('button[aria-label="Delete message"]');
      const systemHasDelete = !!systemPost?.querySelector('button[aria-label="Delete message"]');
      const me1HasDelete = !!me1Post?.querySelector('button[aria-label="Delete message"]');
      const me2InitiallyGrouped = !me2Post?.querySelector('header');

      // Open modal and cancel via Escape
      me1Post?.querySelector('button[aria-label="Delete message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      const modalOpened = !!document.querySelector('#delete-message-modal');
      const modalShowsPreview = document.querySelector('#delete-message-modal')?.textContent?.includes('My first grouped message today') ?? false;

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const modalClosedOnEsc = !document.querySelector('#delete-message-modal');
      const me1KeptAfterCancel = !!document.querySelector('article[data-post-id="post-me-1"]');

      // Confirm deleting post-me-1 -> post-me-2 should promote to ungrouped with header & avatar
      document.querySelector('article[data-post-id="post-me-1"] button[aria-label="Delete message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('#delete-modal-confirm-button')?.click();

      let waitRemoved = 0;
      while (document.querySelector('article[data-post-id="post-me-1"]') && waitRemoved < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitRemoved++;
      }

      const me2PromotedToUngrouped = !!document.querySelector('article[data-post-id="post-me-2"] header');

      // Delete yesterday's sole message -> Yesterday divider must disappear
      const dividersBefore = document.querySelectorAll('[data-date-divider]').length;
      yesterdayPost?.querySelector('button[aria-label="Delete message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('#delete-modal-confirm-button')?.click();

      let waitYesterdayRemoved = 0;
      while (document.querySelector('article[data-post-id="post-yesterday"]') && waitYesterdayRemoved < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitYesterdayRemoved++;
      }
      const dividersAfter = document.querySelectorAll('[data-date-divider]').length;

      return {
        aliceHasDelete,
        systemHasDelete,
        me1HasDelete,
        me2InitiallyGrouped,
        modalOpened,
        modalShowsPreview,
        modalClosedOnEsc,
        me1KeptAfterCancel,
        me1Removed: !document.querySelector('article[data-post-id="post-me-1"]'),
        me2PromotedToUngrouped,
        dividersBefore,
        dividersAfter,
      };
    })()`)) as {
      aliceHasDelete: boolean;
      systemHasDelete: boolean;
      me1HasDelete: boolean;
      me2InitiallyGrouped: boolean;
      modalOpened: boolean;
      modalShowsPreview: boolean;
      modalClosedOnEsc: boolean;
      me1KeptAfterCancel: boolean;
      me1Removed: boolean;
      me2PromotedToUngrouped: boolean;
      dividersBefore: number;
      dividersAfter: number;
    };

    expect(result.aliceHasDelete).toBe(false);
    expect(result.systemHasDelete).toBe(false);
    expect(result.me1HasDelete).toBe(true);
    expect(result.me2InitiallyGrouped).toBe(true);
    expect(result.modalOpened).toBe(true);
    expect(result.modalShowsPreview).toBe(true);
    expect(result.modalClosedOnEsc).toBe(true);
    expect(result.me1KeptAfterCancel).toBe(true);
    expect(result.me1Removed).toBe(true);
    expect(result.me2PromotedToUngrouped).toBe(true);
    expect(result.dividersBefore).toBe(2);
    expect(result.dividersAfter).toBe(1);
    expect(deletedPostIds).toEqual(['post-me-1', 'post-yesterday']);
  });

  test('displays error when delete fails and removes local failed posts without API call', async () => {
    const result = (await webview.evaluate(`(async () => {
      if (window.__hmr_state__) {
        window.__hmr_state__.posts = [
          {
            id: 'post-fail-delete',
            user_id: 'user-me',
            channel_id: 'ch-general',
            message: 'Server rejects deleting me',
            create_at: Date.now() - 5000,
          },
          {
            id: 'temp_failed_local',
            tempId: 'temp_failed_local',
            user_id: 'user-me',
            channel_id: 'ch-general',
            message: 'Unsent failed message',
            create_at: Date.now(),
            status: 'failed',
          },
        ];
      }
      window.__render_app__?.();
      await new Promise(r => setTimeout(r, 40));

      // Trigger server 403 error on post-fail-delete
      document.querySelector('article[data-post-id="post-fail-delete"] button[aria-label="Delete message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('#delete-modal-confirm-button')?.click();
      await new Promise(r => setTimeout(r, 120));

      const modalStillOpenWithError =
        document.querySelector('#delete-message-modal')?.textContent?.includes('Cannot delete post right now') ?? false;
      const failPostKept = !!document.querySelector('article[data-post-id="post-fail-delete"]');

      document.querySelector('#delete-modal-cancel-button')?.click();
      await new Promise(r => setTimeout(r, 30));

      // Delete failed local message -> removed without API call
      document.querySelector('article[data-post-id="temp_failed_local"] button[aria-label="Delete message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('#delete-modal-confirm-button')?.click();
      await new Promise(r => setTimeout(r, 40));

      return {
        modalStillOpenWithError,
        failPostKept,
        tempFailedRemoved: !document.querySelector('article[data-post-id="temp_failed_local"]'),
      };
    })()`)) as {
      modalStillOpenWithError: boolean;
      failPostKept: boolean;
      tempFailedRemoved: boolean;
    };

    expect(result.modalStillOpenWithError).toBe(true);
    expect(result.failPostKept).toBe(true);
    expect(result.tempFailedRemoved).toBe(true);
    expect(deletedPostIds).not.toContain('temp_failed_local');
  });

  test('shows empty state when last remaining message is deleted', async () => {
    const result = (await webview.evaluate(`(async () => {
      if (window.__hmr_state__) {
        window.__hmr_state__.posts = [
          {
            id: 'post-only-one',
            user_id: 'user-me',
            channel_id: 'ch-general',
            message: 'Last message in channel',
            create_at: Date.now(),
          },
        ];
      }
      window.__render_app__?.();
      await new Promise(r => setTimeout(r, 40));

      document.querySelector('article[data-post-id="post-only-one"] button[aria-label="Delete message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      document.querySelector('#delete-modal-confirm-button')?.click();

      let waitEmpty = 0;
      while (document.querySelector('article[data-post-id="post-only-one"]') && waitEmpty < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitEmpty++;
      }

      return {
        postRemoved: !document.querySelector('article[data-post-id="post-only-one"]'),
        showsEmptyState: document.body.textContent?.includes('No messages yet') ?? false,
      };
    })()`)) as { postRemoved: boolean; showsEmptyState: boolean };

    expect(result.postRemoved).toBe(true);
    expect(result.showsEmptyState).toBe(true);
    expect(deletedPostIds).toContain('post-only-one');
  });
});
