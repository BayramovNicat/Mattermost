import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Server } from 'bun';
import { buildChannelSearchTerms, hasExplicitInModifier } from '../src/utils/search';
import { MattermostAPI } from './api';
import type { WebSocketMessage } from './types';
import { MattermostWebSocketClient } from './websocket';

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const TOPIC_CHAT = 'mattermost_chat';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

function getBrowserDir(): string {
  if (process.env.BROWSER_DIR) return process.env.BROWSER_DIR;
  const localBrowser = path.join(import.meta.dir, 'browser');
  if (existsSync(localBrowser)) return localBrowser;
  const distBrowser = path.join(import.meta.dir, '../dist/browser');
  if (existsSync(distBrowser)) return distBrowser;
  const rootPublic = path.join(import.meta.dir, '../public');
  return rootPublic;
}

export function startServerWithFallback(
  options: Parameters<typeof Bun.serve>[0],
  maxAttempts = 20
): Server<unknown> {
  const initialPort = Number(options.port) || 3000;
  if (initialPort === 0) return Bun.serve(options);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const currentPort = initialPort + attempt;
    try {
      return Bun.serve({ ...options, port: currentPort } as Parameters<typeof Bun.serve>[0]);
    } catch (err: unknown) {
      const inUse =
        err instanceof Error &&
        (('code' in err && (err as { code: string }).code === 'EADDRINUSE') ||
          err.message.includes('in use') ||
          err.message.includes('Failed to start server'));
      if (!inUse || attempt === maxAttempts - 1) throw err;
      console.warn(`[Server] Port ${currentPort} is in use, trying ${currentPort + 1}...`);
    }
  }
  throw new Error(
    `Could not find an available port after ${maxAttempts} attempts starting from ${initialPort}`
  );
}

export interface StartServerOptions {
  api?: MattermostAPI;
  enableWebSocket?: boolean;
}

export function startServer(port = PORT, options: StartServerOptions = {}): Server<unknown> {
  const api = options.api ?? new MattermostAPI();
  let serverInstance: Server<unknown> | null = null;
  let defaultTeamId = '';
  const channelMetaCache = new Map<
    string,
    { id: string; name: string; type: string; team_id?: string; otherUsername?: string }
  >();

  const resolveTeamId = async (preferredTeamId?: string): Promise<string> => {
    if (preferredTeamId) return preferredTeamId;
    if (defaultTeamId) return defaultTeamId;
    const teams = await api.getMyTeams();
    defaultTeamId = teams[0]?.id || '';
    return defaultTeamId;
  };

  const resolveChannelSearchMeta = async (channelId: string) => {
    const cached = channelMetaCache.get(channelId);
    if (cached) return cached;

    const ch = await api.getChannel(channelId);
    let otherUsername: string | undefined;
    if (ch.type === 'D') {
      const me = (await api.getMe()) as { id: string };
      const parts = ch.name.split('__');
      const otherId = parts.find((id) => id !== me.id) || me.id;
      const otherUser = await api.getUser(otherId);
      otherUsername = otherUser.username;
    }

    const meta = {
      id: ch.id,
      name: ch.name,
      type: ch.type,
      team_id: ch.team_id || undefined,
      otherUsername,
    };
    channelMetaCache.set(channelId, meta);
    return meta;
  };

  const handleSearch = async (req: Request, url: URL, pathChannelId?: string): Promise<Response> => {
    try {
      let query = url.searchParams.get('q') ?? url.searchParams.get('terms') ?? '';
      let targetChannelId = pathChannelId || url.searchParams.get('channel_id') || '';
      let explicitTeamId = url.searchParams.get('team_id') || '';
      let isOrSearch = url.searchParams.get('is_or_search') === 'true';
      let page = Number.parseInt(url.searchParams.get('page') || '0', 10) || 0;
      let perPage = Number.parseInt(url.searchParams.get('per_page') || '30', 10) || 30;
      let timeZoneOffset = Number.parseInt(url.searchParams.get('time_zone_offset') || '0', 10) || 0;

      if (req.method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as {
          q?: string;
          terms?: string;
          channel_id?: string;
          team_id?: string;
          is_or_search?: boolean;
          page?: number;
          per_page?: number;
          time_zone_offset?: number;
        };
        query = body.q ?? body.terms ?? query;
        targetChannelId = pathChannelId || body.channel_id || targetChannelId;
        explicitTeamId = body.team_id || explicitTeamId;
        if (typeof body.is_or_search === 'boolean') isOrSearch = body.is_or_search;
        if (typeof body.page === 'number') page = body.page;
        if (typeof body.per_page === 'number') perPage = body.per_page;
        if (typeof body.time_zone_offset === 'number') timeZoneOffset = body.time_zone_offset;
      }

      const trimmedQuery = query.trim();
      page = Math.max(0, page);
      perPage = Math.min(100, Math.max(1, perPage));

      if (!trimmedQuery) {
        return Response.json({
          order: [],
          posts: {},
          matches: {},
          users: {},
          query: '',
          terms: '',
          channelId: targetChannelId || null,
          page,
          perPage,
        });
      }

      let meta:
        | { id: string; name: string; type: string; team_id?: string; otherUsername?: string }
        | undefined;
      let terms = trimmedQuery;
      const userExplicitIn = hasExplicitInModifier(trimmedQuery);

      if (targetChannelId) {
        meta = await resolveChannelSearchMeta(targetChannelId);
        terms = buildChannelSearchTerms(trimmedQuery, {
          name: meta.name,
          type: meta.type,
          otherUser: meta.otherUsername ? { username: meta.otherUsername } : undefined,
        });
      }

      const teamId = await resolveTeamId(explicitTeamId || meta?.team_id);

      let searchData = await api.searchPosts({
        terms,
        teamId: teamId || undefined,
        isOrSearch,
        timeZoneOffset,
        page,
        perPage,
      });

      if (
        meta?.type === 'G' &&
        !userExplicitIn &&
        (!searchData.order || searchData.order.length === 0)
      ) {
        searchData = await api.searchPosts({
          terms: trimmedQuery,
          teamId: teamId || undefined,
          isOrSearch,
          timeZoneOffset,
          page,
          perPage,
        });
      }

      const rawOrder = searchData.order || [];
      const rawPosts = searchData.posts || {};
      const rawMatches = searchData.matches || {};

      const shouldFilterByChannel = Boolean(targetChannelId && !userExplicitIn);
      const order: string[] = [];
      const posts: Record<string, (typeof rawPosts)[string]> = {};
      const matches: Record<string, string[]> = {};
      const userIds = new Set<string>();

      for (const pid of rawOrder) {
        const post = rawPosts[pid];
        if (!post) continue;
        if (shouldFilterByChannel && post.channel_id !== targetChannelId) continue;
        order.push(pid);
        posts[pid] = post;
        if (rawMatches[pid]) {
          matches[pid] = rawMatches[pid];
        }
        if (post.user_id) {
          userIds.add(post.user_id);
        }
      }

      const users: Record<string, { id: string; username: string; display_name: string }> = {};
      if (userIds.size > 0) {
        try {
          const userList = await api.getUsersByIds([...userIds]);
          for (const u of userList) {
            users[u.id] = {
              id: u.id,
              username: u.username,
              display_name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username,
            };
          }
        } catch (e) {
          console.error('Failed to fetch users for search results:', e);
        }
      }

      return Response.json({
        order,
        posts,
        matches,
        users,
        query: trimmedQuery,
        terms,
        channelId: targetChannelId || null,
        page,
        perPage,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Response.json({ error: message }, { status: 500 });
    }
  };

  const mmWs =
    options.enableWebSocket === false
      ? null
      : new MattermostWebSocketClient((event: WebSocketMessage) => {
          if (serverInstance) {
            serverInstance.publish(TOPIC_CHAT, JSON.stringify(event));
          }
        });
  mmWs?.connect();

  const browserDir = getBrowserDir();

  serverInstance = startServerWithFallback({
    port,
    async fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        const success = server.upgrade(req, { data: undefined });
        if (success) return undefined;
        return new Response('WebSocket upgrade failed', { status: 400 });
      }

      if (url.pathname === '/api/me') {
        try {
          const me = await api.getMe();
          return Response.json(me);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === '/api/teams') {
        try {
          const teams = await api.getMyTeams();
          return Response.json(teams);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === '/api/statuses') {
        try {
          const userIds = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
          const statuses = await api.getUserStatuses(userIds);
          return Response.json(statuses);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      if (url.pathname === '/api/channels') {
        try {
          const me = (await api.getMe()) as { id: string };
          const teams = await api.getMyTeams();
          if (teams.length === 0) return Response.json([]);
          defaultTeamId = teams[0].id;

          const channels = (await api.getChannelsForTeam(teams[0].id)) as Array<
            Record<string, unknown> & { id: string; name: string; type: string; last_post_at?: number; otherUserId?: string; otherUser?: unknown }
          >;

          const otherUserIds: string[] = [];
          for (const ch of channels) {
            if (ch.type === 'D') {
              const parts = (ch.name as string).split('__');
              const otherId = parts.find((id) => id !== me.id) || me.id;
              ch.otherUserId = otherId;
              otherUserIds.push(otherId);
            }
          }

          if (otherUserIds.length > 0) {
            try {
              const uniqueIds = [...new Set(otherUserIds)];
              await api.getUsersByIds(uniqueIds);
              const statuses = await api.getUserStatuses(uniqueIds);

              for (const ch of channels) {
                if (ch.otherUserId) {
                  const u = await api.getUser(ch.otherUserId);
                  ch.otherUser = {
                    id: u.id,
                    username: u.username,
                    display_name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username,
                    email: u.email,
                    status: statuses[ch.otherUserId] || 'offline',
                  };
                }
              }
            } catch (e) {
              console.error('Failed to batch fetch users:', e);
            }
          }

          channels.sort((a, b) => (b.last_post_at || 0) - (a.last_post_at || 0));
          for (const ch of channels) {
            const other = ch.otherUser as { username?: string } | undefined;
            channelMetaCache.set(ch.id, {
              id: ch.id,
              name: ch.name,
              type: ch.type,
              team_id: typeof ch.team_id === 'string' && ch.team_id ? ch.team_id : undefined,
              otherUsername: other?.username,
            });
          }
          return Response.json(channels);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      const channelSearchMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/search$/);
      if (channelSearchMatch && (req.method === 'GET' || req.method === 'POST')) {
        return handleSearch(req, url, channelSearchMatch[1]);
      }

      if (url.pathname === '/api/search' && (req.method === 'GET' || req.method === 'POST')) {
        return handleSearch(req, url);
      }

      const postsMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/posts$/);
      if (postsMatch) {
        const channelId = postsMatch[1];
        if (req.method === 'GET') {
          try {
            const before = url.searchParams.get('before') || '';
            const after = url.searchParams.get('after') || '';
            const page = url.searchParams.get('page') || '0';
            const perPage = url.searchParams.get('per_page') || '30';

            const postsData = (await api.getChannelPosts(channelId, {
              before,
              after,
              page,
              perPage,
            })) as {
              posts?: Record<string, { id?: string; user_id: string; root_id?: string; [key: string]: unknown }>;
              order?: string[];
            };

            const userIds = new Set<string>();
            const missingRootIds = new Set<string>();
            if (postsData.posts) {
              for (const pid of Object.keys(postsData.posts)) {
                const post = postsData.posts[pid];
                if (post.user_id) {
                  userIds.add(post.user_id);
                }
                if (post.root_id && !postsData.posts[post.root_id]) {
                  missingRootIds.add(post.root_id);
                }
              }
            }

            const referencedPosts: Record<string, { id: string; user_id: string; channel_id: string; [key: string]: unknown }> = {};
            if (missingRootIds.size > 0) {
              const settled = await Promise.allSettled(
                [...missingRootIds].map((rootId) => api.getPost(rootId))
              );
              for (const result of settled) {
                if (result.status === 'fulfilled' && result.value?.id) {
                  referencedPosts[result.value.id] = result.value;
                  if (result.value.user_id) {
                    userIds.add(result.value.user_id);
                  }
                }
              }
            }

            const users: Record<string, { id: string; username: string; display_name: string }> = {};
            if (userIds.size > 0) {
              try {
                const userList = await api.getUsersByIds([...userIds]);
                for (const u of userList) {
                  users[u.id] = {
                    id: u.id,
                    username: u.username,
                    display_name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username,
                  };
                }
              } catch (e) {
                console.error('Failed to fetch users for posts:', e);
              }
            }

            return Response.json({
              ...postsData,
              ...(Object.keys(referencedPosts).length > 0
                ? { referenced_posts: referencedPosts }
                : {}),
              users,
            });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return Response.json({ error: message }, { status: 500 });
          }
        }
        if (req.method === 'POST') {
          try {
            const body = (await req.json()) as { message: string; root_id?: string; file_ids?: string[] };
            const post = await api.createPost(channelId, body.message, body.root_id || '', body.file_ids || []);
            return Response.json(post);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return Response.json({ error: message }, { status: 500 });
          }
        }
      }

      const postMatch = url.pathname.match(/^\/api\/posts\/([^/]+)$/);
      if (postMatch && req.method === 'GET') {
        try {
          const postId = decodeURIComponent(postMatch[1]);
          const post = await api.getPost(postId);
          if (url.searchParams.get('include_users') === '1') {
            const users: Record<string, { id: string; username: string; display_name: string }> = {};
            if (post.user_id) {
              try {
                const userList = await api.getUsersByIds([post.user_id]);
                for (const u of userList) {
                  users[u.id] = {
                    id: u.id,
                    username: u.username,
                    display_name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username,
                  };
                }
              } catch (e) {
                console.error('Failed to fetch user for post:', e);
              }
            }
            return Response.json({ post, users });
          }
          return Response.json(post);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const statusMatch = message.match(/Mattermost API Error \((\d+)\)/);
          const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 500;
          return Response.json({ error: message }, { status });
        }
      }
      if (postMatch && req.method === 'DELETE') {
        try {
          const postId = decodeURIComponent(postMatch[1]);
          const result = await api.deletePost(postId);
          return Response.json(result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          const statusMatch = message.match(/Mattermost API Error \((\d+)\)/);
          const status = statusMatch ? Number.parseInt(statusMatch[1], 10) : 500;
          return Response.json({ error: message }, { status });
        }
      }

      if (url.pathname === '/api/files' && req.method === 'POST') {
        try {
          const formData = await req.formData();
          const data = await api.uploadFiles(formData);
          return Response.json(data);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: message }, { status: 500 });
        }
      }

      const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)$/);
      if (fileMatch) {
        try {
          const fileId = fileMatch[1];
          const res = await api.getFile(fileId);
          return new Response(res.body, {
            headers: {
              'Content-Type': res.headers.get('content-type') || 'application/octet-stream',
              'Cache-Control': 'public, max-age=86400, immutable',
            },
          });
        } catch {
          return new Response('File not found', { status: 404 });
        }
      }

      const previewMatch = url.pathname.match(/^\/api\/files\/([^/]+)\/preview$/);
      if (previewMatch) {
        try {
          const fileId = previewMatch[1];
          const res = await api.getFilePreview(fileId);
          return new Response(res.body, {
            headers: {
              'Content-Type': res.headers.get('content-type') || 'image/jpeg',
              'Cache-Control': 'public, max-age=86400, immutable',
            },
          });
        } catch {
          return new Response('Preview not found', { status: 404 });
        }
      }

      const avatarMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/avatar$/);
      if (avatarMatch) {
        try {
          const userId = avatarMatch[1];
          const res = await api.getUserAvatar(userId);
          return new Response(res.body, {
            headers: {
              'Content-Type': res.headers.get('content-type') || 'image/png',
              'Cache-Control': 'public, max-age=3600',
            },
          });
        } catch {
          return new Response('Avatar not found', { status: 404 });
        }
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const indexHtml = path.join(browserDir, 'index.html');
        const file = Bun.file(indexHtml);
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          });
        }
      }

      const cleanPath = url.pathname.replace(/^\/+/, '');
      const filePath = path.join(browserDir, cleanPath);
      const staticFile = Bun.file(filePath);

      if (await staticFile.exists()) {
        const ext = path.extname(cleanPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || staticFile.type || 'application/octet-stream';
        const isHashedAsset = cleanPath.startsWith('assets/');
        return new Response(staticFile, {
          headers: {
            'Content-Type': contentType,
            'Cache-Control': isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
          },
        });
      }

      if (req.headers.get('accept')?.includes('text/html')) {
        const indexHtml = path.join(browserDir, 'index.html');
        const file = Bun.file(indexHtml);
        if (await file.exists()) {
          return new Response(file, {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          });
        }
      }

      return new Response('Not Found', { status: 404 });
    },

    websocket: {
      idleTimeout: 0,
      sendPings: true,
      open(ws) {
        ws.subscribe(TOPIC_CHAT);
      },
      message(ws, raw) {
        if (typeof raw === 'string' && raw.includes('"ping"')) {
          ws.send('{"type":"pong"}');
        }
      },
      close(ws) {
        ws.unsubscribe(TOPIC_CHAT);
      },
    },
  });

  return serverInstance;
}

if (import.meta.main) {
  const server = startServer();
  console.log(`\n======================================================`);
  console.log(`🚀 Mattermost Bun Server is running!`);
  console.log(`👉 http://localhost:${server.port}`);
  console.log(`======================================================\n`);
}
