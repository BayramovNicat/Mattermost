import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { MattermostAPI } from '../server/api';
import { startServer } from '../server/index';
import { createDevServer } from '../vite';

describe('reply to message API and server routes', () => {
  let mockMattermost: Server<unknown>;
  let appServer: Server<unknown>;
  const receivedPosts: Array<{ channel_id: string; message: string; root_id: string }> = [];

  beforeAll(() => {
    mockMattermost = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (req.method === 'GET' && url.pathname === '/api/v4/channels/ch-1/posts') {
          return Response.json({
            order: ['post-reply-to-old'],
            posts: {
              'post-reply-to-old': {
                id: 'post-reply-to-old',
                user_id: 'user-me',
                channel_id: 'ch-1',
                message: 'Replying to an older post',
                root_id: 'post-old-parent',
                create_at: 2000,
              },
            },
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/v4/posts/post-old-parent') {
          return Response.json({
            id: 'post-old-parent',
            user_id: 'user-alice',
            channel_id: 'ch-1',
            message: 'Older root message from yesterday',
            create_at: 1000,
          });
        }

        if (req.method === 'GET' && url.pathname === '/api/v4/posts/post-missing') {
          return Response.json({ message: 'Not found' }, { status: 404 });
        }

        if (req.method === 'POST' && url.pathname === '/api/v4/users/ids') {
          const ids = (await req.json()) as string[];
          const catalog: Record<string, { id: string; username: string; first_name: string; last_name: string }> = {
            'user-me': { id: 'user-me', username: 'me', first_name: 'Me', last_name: '' },
            'user-alice': { id: 'user-alice', username: 'alice', first_name: 'Alice', last_name: 'Smith' },
          };
          return Response.json(ids.map((id) => catalog[id]).filter(Boolean));
        }

        if (req.method === 'POST' && url.pathname === '/api/v4/posts') {
          const body = (await req.json()) as { channel_id: string; message: string; root_id: string };
          receivedPosts.push(body);
          return Response.json({
            id: `created-${receivedPosts.length}`,
            user_id: 'user-me',
            channel_id: body.channel_id,
            message: body.message,
            root_id: body.root_id,
            create_at: Date.now(),
          });
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

  test('GET /api/channels/:id/posts hydrates missing root_id posts into referenced_posts and users', async () => {
    const res = await fetch(`http://localhost:${appServer.port}/api/channels/ch-1/posts`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      order: string[];
      posts: Record<string, { id: string; root_id?: string }>;
      referenced_posts?: Record<string, { id: string; message: string; user_id: string }>;
      users?: Record<string, { id: string; username: string; display_name: string }>;
    };

    expect(data.order).toEqual(['post-reply-to-old']);
    expect(data.referenced_posts?.['post-old-parent']?.message).toBe(
      'Older root message from yesterday'
    );
    expect(data.users?.['user-alice']?.display_name).toBe('Alice Smith');
  });

  test('GET /api/posts/:id returns post with optional user info and propagates 404', async () => {
    const res = await fetch(
      `http://localhost:${appServer.port}/api/posts/post-old-parent?include_users=1`
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      post: { id: string; message: string };
      users: Record<string, { id: string; username: string }>;
    };
    expect(data.post.id).toBe('post-old-parent');
    expect(data.users['user-alice'].username).toBe('alice');

    const missingRes = await fetch(`http://localhost:${appServer.port}/api/posts/post-missing`);
    expect(missingRes.status).toBe(404);
  });

  test('POST /api/channels/:id/posts forwards root_id for replies', async () => {
    const res = await fetch(`http://localhost:${appServer.port}/api/channels/ch-1/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Reply body', root_id: 'post-old-parent' }),
    });
    expect(res.status).toBe(200);
    const post = (await res.json()) as { id: string; root_id: string };
    expect(post.root_id).toBe('post-old-parent');
    expect(receivedPosts).toContainEqual({
      channel_id: 'ch-1',
      message: 'Reply body',
      root_id: 'post-old-parent',
    });
  });
});

describe('reply to message UI flow', () => {
  let server: Server<unknown>;
  let mockBackend: Server<unknown>;
  let webview: Bun.WebView;
  let prevProxyTarget: string | undefined;
  const sentPayloads: Array<{ message: string; root_id?: string }> = [];

  beforeAll(async () => {
    prevProxyTarget = process.env.VITE_PROXY_TARGET;
    const now = Date.now();

    mockBackend = Bun.serve({
      port: 0,
      websocket: {
        open(ws) {
          ws.subscribe('chat');
        },
        message() {},
      },
      async fetch(req, serverInstance) {
        const url = new URL(req.url);

        if (url.pathname === '/ws') {
          return serverInstance.upgrade(req, { data: undefined })
            ? undefined
            : new Response('Upgrade failed', { status: 400 });
        }

        if (url.pathname === '/api/me') {
          return Response.json({ id: 'user-me', username: 'me', display_name: 'Me' });
        }

        if (url.pathname === '/api/channels') {
          return Response.json([
            { id: 'ch-general', name: 'general', display_name: 'General', type: 'O' },
          ]);
        }

        if (url.pathname === '/api/channels/ch-general/posts' && req.method === 'GET') {
          const before = url.searchParams.get('before');
          const after = url.searchParams.get('after');

          if (before === 'post-old-root') {
            return Response.json({ order: [], posts: {}, users: {} });
          }
          if (after === 'post-old-root') {
            return Response.json({
              order: ['post-reply-old'],
              posts: {
                'post-reply-old': {
                  id: 'post-reply-old',
                  user_id: 'user-me',
                  channel_id: 'ch-general',
                  message: 'Reply to archived root',
                  root_id: 'post-old-root',
                  create_at: now - 30_000,
                },
              },
              users: {
                'user-me': { id: 'user-me', username: 'me', display_name: 'Me' },
              },
            });
          }

          return Response.json({
            order: ['post-reply-old', 'post-system-1', 'post-alice-1'],
            posts: {
              'post-alice-1': {
                id: 'post-alice-1',
                user_id: 'user-alice',
                channel_id: 'ch-general',
                message: 'Can someone review the PR?',
                create_at: now - 120_000,
              },
              'post-system-1': {
                id: 'post-system-1',
                user_id: 'user-alice',
                channel_id: 'ch-general',
                message: 'alice joined the channel.',
                type: 'system_join_channel',
                create_at: now - 60_000,
              },
              'post-reply-old': {
                id: 'post-reply-old',
                user_id: 'user-me',
                channel_id: 'ch-general',
                message: 'Reply to archived root',
                root_id: 'post-old-root',
                create_at: now - 30_000,
              },
            },
            referenced_posts: {
              'post-old-root': {
                id: 'post-old-root',
                user_id: 'user-alice',
                channel_id: 'ch-general',
                message: 'Archived root message',
                create_at: now - 86_400_000,
              },
            },
            users: {
              'user-me': { id: 'user-me', username: 'me', display_name: 'Me' },
              'user-alice': { id: 'user-alice', username: 'alice', display_name: 'Alice' },
            },
          });
        }

        if (url.pathname === '/api/channels/ch-general/posts' && req.method === 'POST') {
          const body = (await req.json()) as { message: string; root_id?: string };
          sentPayloads.push({ message: body.message, root_id: body.root_id });
          return Response.json({
            id: `post-server-${sentPayloads.length}`,
            user_id: 'user-me',
            channel_id: 'ch-general',
            message: body.message,
            root_id: body.root_id || '',
            create_at: Date.now(),
          });
        }

        const deleteMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
        if (deleteMatch && req.method === 'DELETE') {
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

  test('renders reply action, previews & cancels reply while keeping draft, sends root_id, and jumps to parent', async () => {
    const result = (await webview.evaluate(`(async () => {
      let attempts = 0;
      while (!document.querySelector('article[data-post-id="post-alice-1"]') && attempts < 60) {
        await new Promise(r => setTimeout(r, 30));
        attempts++;
      }

      const alicePost = document.querySelector('article[data-post-id="post-alice-1"]');
      const systemPost = document.querySelector('article[data-post-id="post-system-1"]');
      const replyOldPost = document.querySelector('article[data-post-id="post-reply-old"]');

      const aliceHasReply = !!alicePost?.querySelector('button[aria-label="Reply to message"]');
      const systemHasReply = !!systemPost?.querySelector('button[aria-label="Reply to message"]');
      const oldQuoteText = replyOldPost?.querySelector('[data-reply-quote="post-old-root"]')?.textContent || '';

      // Put draft text in composer before clicking Reply
      const textarea = document.querySelector('#chat-message-input');
      if (textarea) {
        textarea.value = 'On it now!';
      }

      alicePost?.querySelector('button[aria-label="Reply to message"]')?.click();
      await new Promise(r => setTimeout(r, 30));

      const previewEl = document.querySelector('#chat-reply-preview');
      const previewVisible = !!previewEl && !previewEl.classList.contains('hidden');
      const previewText = previewEl?.textContent || '';
      const draftKeptOnReply = textarea?.value === 'On it now!';
      const textareaFocused = document.activeElement === textarea;

      // Cancel via Escape -> preview hides, draft preserved
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 30));
      const previewHiddenOnEsc = previewEl?.classList.contains('hidden') ?? false;
      const draftKeptOnCancel = textarea?.value === 'On it now!';

      // Reply again and submit
      alicePost?.querySelector('button[aria-label="Reply to message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      textarea?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      let waitCreated = 0;
      while (!document.querySelector('article[data-post-id="post-server-1"]') && waitCreated < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitCreated++;
      }

      const createdReplyEl = document.querySelector('article[data-post-id="post-server-1"]');
      const createdQuoteEl = createdReplyEl?.querySelector('[data-reply-quote="post-alice-1"]');
      const createdQuoteText = createdQuoteEl?.textContent || '';
      const previewClearedAfterSend = previewEl?.classList.contains('hidden') ?? false;

      // Clicking the quote scrolls to and highlights Alice's message
      createdQuoteEl?.click();
      await new Promise(r => setTimeout(r, 30));
      const aliceHighlighted = alicePost?.classList.contains('ring-indigo-500/70') ?? false;

      // Replying to a reply uses the thread's root_id (post-alice-1), not post-server-1
      createdReplyEl?.querySelector('button[aria-label="Reply to message"]')?.click();
      await new Promise(r => setTimeout(r, 30));
      if (textarea) {
        textarea.value = 'Nested reply in same thread';
      }
      textarea?.form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

      let waitNested = 0;
      while (!document.querySelector('article[data-post-id="post-server-2"]') && waitNested < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitNested++;
      }

      // Clicking archived reply quote jumps to post-old-root via jumpToPost
      const archivedQuoteEl = document.querySelector('[data-reply-quote="post-old-root"]');
      archivedQuoteEl?.click();
      let waitArchived = 0;
      while (!document.querySelector('article[data-post-id="post-old-root"]') && waitArchived < 60) {
        await new Promise(r => setTimeout(r, 30));
        waitArchived++;
      }
      const jumpedToArchivedRoot = !!document.querySelector('article[data-post-id="post-old-root"]');

      return {
        aliceHasReply,
        systemHasReply,
        oldQuoteText,
        previewVisible,
        previewText,
        draftKeptOnReply,
        textareaFocused,
        previewHiddenOnEsc,
        draftKeptOnCancel,
        createdQuoteText,
        previewClearedAfterSend,
        aliceHighlighted,
        jumpedToArchivedRoot,
      };
    })()`)) as {
      aliceHasReply: boolean;
      systemHasReply: boolean;
      oldQuoteText: string;
      previewVisible: boolean;
      previewText: string;
      draftKeptOnReply: boolean;
      textareaFocused: boolean;
      previewHiddenOnEsc: boolean;
      draftKeptOnCancel: boolean;
      createdQuoteText: string;
      previewClearedAfterSend: boolean;
      aliceHighlighted: boolean;
      jumpedToArchivedRoot: boolean;
    };

    expect(result.aliceHasReply).toBe(true);
    expect(result.systemHasReply).toBe(false);
    expect(result.oldQuoteText).toContain('Alice');
    expect(result.oldQuoteText).toContain('Archived root message');
    expect(result.previewVisible).toBe(true);
    expect(result.previewText).toContain('Replying to Alice');
    expect(result.previewText).toContain('Can someone review the PR?');
    expect(result.draftKeptOnReply).toBe(true);
    expect(result.textareaFocused).toBe(true);
    expect(result.previewHiddenOnEsc).toBe(true);
    expect(result.draftKeptOnCancel).toBe(true);
    expect(result.createdQuoteText).toContain('Alice');
    expect(result.createdQuoteText).toContain('Can someone review the PR?');
    expect(result.previewClearedAfterSend).toBe(true);
    expect(result.aliceHighlighted).toBe(true);
    expect(result.jumpedToArchivedRoot).toBe(true);
    expect(sentPayloads).toEqual([
      { message: 'On it now!', root_id: 'post-alice-1' },
      { message: 'Nested reply in same thread', root_id: 'post-alice-1' },
    ]);
  });
});
