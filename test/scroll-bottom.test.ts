import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { createDevServer } from '../vite';

const SVG_IMAGE = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="224"><rect width="320" height="224" fill="#4f46e5"/></svg>`;

describe('MessageList scroll-to-latest on refresh with delayed images', () => {
  let server: Server<unknown>;
  let mockBackend: Server<unknown>;
  let webview: Bun.WebView;
  let prevProxyTarget: string | undefined;

  beforeAll(async () => {
    prevProxyTarget = process.env.VITE_PROXY_TARGET;

    mockBackend = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === '/api/me') {
          return Response.json({ id: 'user-me', username: 'me' });
        }

        if (url.pathname === '/api/channels') {
          return Response.json([
            { id: 'ch-images', name: 'images', display_name: 'Images', type: 'O' },
          ]);
        }

        if (url.pathname === '/api/channels/ch-images/posts') {
          if (url.searchParams.get('before')) {
            return Response.json({ order: [], posts: {}, users: {} });
          }

          const now = Date.now();
          const posts: Record<string, unknown> = {};
          const order: string[] = [];

          for (let i = 24; i >= 0; i--) {
            const id = `post-${i}`;
            order.push(id);
            const isRecentImageNoDims = i >= 20 && i <= 23;
            const isRecentImageWithDims = i === 24;

            posts[id] = {
              id,
              user_id: i % 2 === 0 ? 'user-me' : 'user-other',
              channel_id: 'ch-images',
              message: `Message number ${i}`,
              create_at: now - (25 - i) * 6 * 60 * 1000,
              metadata: isRecentImageNoDims
                ? {
                    files: [
                      {
                        id: `img-nodims-${i}`,
                        name: `photo-${i}.svg`,
                        extension: 'svg',
                        size: 1024,
                        mime_type: 'image/svg+xml',
                      },
                    ],
                  }
                : isRecentImageWithDims
                  ? {
                      files: [
                        {
                          id: 'img-withdims-24',
                          name: 'sized-photo.svg',
                          extension: 'svg',
                          size: 2048,
                          mime_type: 'image/svg+xml',
                          width: 1600,
                          height: 800,
                        },
                      ],
                    }
                  : undefined,
            };
          }

          return Response.json({
            order,
            posts,
            users: {
              'user-me': { id: 'user-me', username: 'me', display_name: 'Me' },
              'user-other': { id: 'user-other', username: 'alex', display_name: 'Alex' },
            },
          });
        }

        if (url.pathname.startsWith('/api/files/') && url.pathname.endsWith('/preview')) {
          const delay = url.pathname.includes('img-nodims-23') ? 350 : 120;
          await new Promise((r) => setTimeout(r, delay));
          return new Response(SVG_IMAGE, {
            headers: { 'Content-Type': 'image/svg+xml' },
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

  test('stays scrolled to latest message after delayed images load on initial refresh', async () => {
    await webview.navigate(`http://localhost:${server.port}/?reload=${Date.now()}`);

    const result = (await webview.evaluate(`(async () => {
      let attempts = 0;
      while (!document.querySelector('article[data-post-id="post-24"]') && attempts < 60) {
        await new Promise(r => setTimeout(r, 20));
        attempts++;
      }

      const container = document.querySelector('article[data-post-id]')?.closest('.overflow-y-auto');
      const initialScrollHeight = container ? container.scrollHeight : -1;

      const imgs = Array.from(document.querySelectorAll('article img'));
      let imgWait = 0;
      while (imgs.some(img => !img.complete || img.naturalHeight === 0) && imgWait < 60) {
        await new Promise(r => setTimeout(r, 30));
        imgWait++;
      }

      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const sizedImg = document.querySelector('article[data-post-id="post-24"] img');

      return {
        imgCount: imgs.length,
        allLoaded: imgs.every(img => img.complete && img.naturalHeight > 0),
        initialScrollHeight,
        scrollTop: container ? container.scrollTop : -1,
        clientHeight: container ? container.clientHeight : -1,
        scrollHeight: container ? container.scrollHeight : -1,
        distanceFromBottom: container
          ? container.scrollHeight - container.clientHeight - container.scrollTop
          : -1,
        sizedImgWidthAttr: sizedImg?.getAttribute('width') || '',
        sizedImgHeightAttr: sizedImg?.getAttribute('height') || '',
      };
    })()`)) as {
      imgCount: number;
      allLoaded: boolean;
      initialScrollHeight: number;
      scrollTop: number;
      clientHeight: number;
      scrollHeight: number;
      distanceFromBottom: number;
      sizedImgWidthAttr: string;
      sizedImgHeightAttr: string;
    };

    expect(result.imgCount).toBe(5);
    expect(result.allLoaded).toBe(true);
    expect(result.scrollHeight).toBeGreaterThan(result.initialScrollHeight);
    expect(result.scrollHeight).toBeGreaterThan(result.clientHeight);
    expect(result.distanceFromBottom).toBeLessThanOrEqual(4);
    expect(result.sizedImgWidthAttr).toBe('320');
    expect(result.sizedImgHeightAttr).toBe('160');
  });

  test('does not yank scroll back to bottom after user scrolls up', async () => {
    const result = (await webview.evaluate(`(async () => {
      const container = document.querySelector('article[data-post-id]')?.closest('.overflow-y-auto');
      if (!container) return { stayedUp: false, scrollTop: -1 };

      container.scrollTop = 200;
      container.dispatchEvent(new Event('scroll'));
      await new Promise(r => setTimeout(r, 40));

      const lastArticle = document.querySelector('article[data-post-id="post-24"]');
      const extraBlock = document.createElement('div');
      extraBlock.style.minHeight = '300px';
      lastArticle?.appendChild(extraBlock);

      await new Promise(r => setTimeout(r, 80));

      return {
        stayedUp: Math.abs(container.scrollTop - 200) <= 2,
        scrollTop: container.scrollTop,
      };
    })()`)) as { stayedUp: boolean; scrollTop: number };

    expect(result.stayedUp).toBe(true);
  });
});
