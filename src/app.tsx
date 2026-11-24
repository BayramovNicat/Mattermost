import './style.css';
import { ChatHeader } from './components/chat-header';
import { ExtractModal } from './components/extract-modal';
import { BellIcon, BellOffIcon } from './components/icons';
import { MessageInput } from './components/message-input';
import { MessageList, type MessageListHandle } from './components/message-list';
import { SearchPanel, type SearchPanelHandle } from './components/search-panel';
import { Sidebar } from './components/sidebar';
import {
  getNotificationPermission,
  isUserMentioned,
  requestNotificationPermission,
  showDesktopNotification,
} from './services/notifications';
import { playMentionChime, playMessageChime } from './services/sound';
import type { AppState, Channel, FileAttachment, Post, User } from './types';
import { formatChannelName } from './utils/channel-name';
import { extractChatData } from './utils/chat-extractor';

const root = document.querySelector('#app') as HTMLElement;
const usersMap = new Map<string, User>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
let typingTimer: ReturnType<typeof setTimeout> | null = null;
let errorTimer: ReturnType<typeof setTimeout> | null = null;
let scrollContainer: HTMLElement | null = null;
let messageListSlotEl: HTMLElement | null = null;
let messageListHandle: MessageListHandle | null = null;
let searchSlotEl: HTMLElement | null = null;
let searchPanelHandle: SearchPanelHandle | null = null;
let scrollRafPending = false;
let jumpRequestSeq = 0;

const initialSoundEnabled =
  typeof localStorage !== 'undefined' ? localStorage.getItem('mm_sound') !== 'false' : true;
const initialNotificationsEnabled =
  typeof localStorage !== 'undefined'
    ? localStorage.getItem('mm_notifications') !== 'false'
    : true;
const initialSidebarOpen =
  typeof localStorage !== 'undefined' ? localStorage.getItem('mm_sidebar_open') !== 'false' : true;

const APP_TITLE = import.meta.env?.VITE_APP_TITLE || 'Sharp Volta (Mattermost)';

const state: AppState = {
  currentUser: null,
  channels: [],
  searchTerm: '',
  activeChannelId: null,
  posts: [],
  oldestPostId: null,
  newestPostId: null,
  hasMoreOlderPosts: true,
  hasMoreNewerPosts: false,
  isLoadingOlder: false,
  isLoadingNewer: false,
  isConnected: false,
  typingText: '',
  errorMessage: null,
  unreadChannelIds: new Set(),
  mentionChannelIds: new Set(),
  soundEnabled: initialSoundEnabled,
  notificationsEnabled: initialNotificationsEnabled,
  isSidebarOpen: initialSidebarOpen,
  isSearchOpen: false,
};

const updateDocumentTitle = () => {
  if (typeof document === 'undefined') return;
  const activeChannel = state.channels.find((c) => c.id === state.activeChannelId);
  const mentionCount = state.mentionChannelIds.size;
  const badge = mentionCount > 0 ? `(${mentionCount}) ` : '';

  if (activeChannel) {
    const details = formatChannelName(activeChannel, usersMap, state.currentUser?.id);
    document.title = details.title ? `${badge}${details.title} · ${APP_TITLE}` : `${badge}${APP_TITLE}`;
  } else {
    document.title = `${badge}${APP_TITLE}`;
  }
};

updateDocumentTitle();

const patchTypingIndicator = (text: string) => {
  state.typingText = text;
  const el = document.querySelector('#chat-typing-indicator');
  if (el) {
    el.textContent = text;
  }
};

const patchErrorMessage = (message: string | null) => {
  state.errorMessage = message;
  const el = document.querySelector('#chat-error-banner');
  if (el) {
    el.textContent = message || '';
  }
};

const patchConnectionStatus = (isConnected: boolean) => {
  state.isConnected = isConnected;
  const badge = document.querySelector('#connection-status-badge');
  const dot = document.querySelector('#connection-status-dot');
  const text = document.querySelector('#connection-status-text');
  if (badge && dot && text) {
    badge.className = `text-xs px-2.5 py-0.5 rounded-full flex items-center gap-1.5 font-medium ${
      isConnected ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'
    }`;
    dot.className = `size-1.5 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-amber-400'}`;
    text.textContent = isConnected ? 'Connected' : 'Reconnecting';
  }
};

const patchSidebarSearch = (term: string) => {
  state.searchTerm = term;
  const lowerTerm = term.trim().toLowerCase();
  const buttons = document.querySelectorAll<HTMLElement>('[data-channel-id]');
  for (let i = 0; i < buttons.length; i++) {
    const btn = buttons[i];
    const searchTerms = btn.getAttribute('data-search-terms') || '';
    const isVisible = !lowerTerm || searchTerms.includes(lowerTerm);
    btn.style.display = isVisible ? 'flex' : 'none';
  }
};

const patchChannelBadge = (channelId: string) => {
  const badgeContainer = document.querySelector(`[data-badge-for="${channelId}"]`);
  if (!badgeContainer) return;
  const isMentioned = state.mentionChannelIds.has(channelId);
  const isUnread = state.unreadChannelIds.has(channelId);

  badgeContainer.replaceChildren(
    isMentioned ? (
      <span class="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-500 text-white shrink-0 leading-none">
        @
      </span>
    ) : isUnread ? (
      <span class="size-2 rounded-full bg-indigo-500 shrink-0" />
    ) : (
      document.createDocumentFragment()
    )
  );
};

const patchUserStatus = (userId: string, status: string) => {
  const dots = document.querySelectorAll(`[data-user-status="${userId}"]`);
  const STATUS_COLORS: Record<string, string> = {
    online: 'bg-emerald-500',
    away: 'bg-amber-500',
    dnd: 'bg-rose-500',
    offline: 'bg-zinc-600',
  };
  const color = STATUS_COLORS[status] ?? 'bg-zinc-600';
  for (let i = 0; i < dots.length; i++) {
    const dot = dots[i] as HTMLElement;
    dot.className = dot.className.replace(/bg-(emerald|amber|rose|zinc)-[0-9]+/g, color);
    dot.setAttribute('title', status);
  }
};

const patchNotificationToggle = (isActive: boolean) => {
  const btn = document.querySelector('#notifications-toggle-button');
  if (!btn) return;
  btn.className = `size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
    isActive
      ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20'
      : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
  }`;
  btn.setAttribute(
    'title',
    isActive
      ? 'Notifications and audio chime enabled (click to mute)'
      : 'Notifications and audio chime muted (click to enable)'
  );
  btn.replaceChildren(isActive ? <BellIcon class="size-4" /> : <BellOffIcon class="size-4" />);
};

const patchSidebarToggle = (isOpen: boolean) => {
  state.isSidebarOpen = isOpen;
  try {
    localStorage.setItem('mm_sidebar_open', String(isOpen));
  } catch {}

  const sidebar = document.querySelector('#chat-sidebar');
  if (sidebar) {
    if (isOpen) {
      sidebar.classList.remove('-ml-70', 'pointer-events-none');
      sidebar.classList.add('ml-0');
      sidebar.removeAttribute('aria-hidden');
    } else {
      sidebar.classList.remove('ml-0');
      sidebar.classList.add('-ml-70', 'pointer-events-none');
      sidebar.setAttribute('aria-hidden', 'true');
    }
  }

  const headerBtn = document.querySelector('#sidebar-toggle-button');
  if (headerBtn) {
    headerBtn.setAttribute('title', isOpen ? 'Hide sidebar (⌘B)' : 'Show sidebar (⌘B)');
    headerBtn.setAttribute('aria-label', isOpen ? 'Hide sidebar' : 'Show sidebar');
    headerBtn.className = `size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
      isOpen
        ? 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
        : 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20'
    }`;
  }
};

const toggleSidebar = () => {
  patchSidebarToggle(!state.isSidebarOpen);
};

const handleToggleNotifications = async () => {
  if (!state.notificationsEnabled || !state.soundEnabled) {
    if (getNotificationPermission() === 'default') {
      await requestNotificationPermission();
    }
    state.soundEnabled = true;
    state.notificationsEnabled = true;
    localStorage.setItem('mm_sound', 'true');
    localStorage.setItem('mm_notifications', 'true');
    patchNotificationToggle(true);
    playMessageChime();
  } else {
    state.soundEnabled = false;
    state.notificationsEnabled = false;
    localStorage.setItem('mm_sound', 'false');
    localStorage.setItem('mm_notifications', 'false');
    patchNotificationToggle(false);
  }
};

const patchExtractButton = () => {
  const btn = document.querySelector<HTMLButtonElement>('#extract-chat-button');
  if (btn) {
    const count = state.posts.length;
    const isEnabled = Boolean(state.activeChannelId || count > 0);
    btn.disabled = !isEnabled;
    btn.className = `size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
      isEnabled
        ? 'text-zinc-400 hover:text-indigo-400 hover:bg-zinc-800'
        : 'text-zinc-600 opacity-40 cursor-not-allowed'
    }`;
    btn.title = isEnabled
      ? `Extract ${count} loaded message(s) for LLM (todos, tasks, media)`
      : 'Select a conversation to extract';
  }
};

const handleExtractChat = () => {
  const activeChannel =
    state.channels.find((c) => c.id === state.activeChannelId) ||
    (state.activeChannelId
      ? {
          id: state.activeChannelId,
          name: 'conversation',
          display_name: 'Conversation',
          type: 'O' as const,
        }
      : undefined);

  if (!activeChannel && state.posts.length === 0) return;

  const existingModal = document.querySelector('#extract-chat-modal');
  if (existingModal) {
    existingModal.remove();
  }

  const extracted = extractChatData(
    activeChannel,
    state.posts,
    usersMap,
    state.currentUser?.id
  );

  let modalEl: HTMLElement | null = null;
  const closeModal = () => {
    if (modalEl) {
      modalEl.remove();
      modalEl = null;
    }
  };

  modalEl = (<ExtractModal extracted={extracted} onClose={closeModal} />) as HTMLElement;
  document.body.appendChild(modalEl);
};

const patchSearchButton = (isOpen: boolean) => {
  const btn = document.querySelector<HTMLButtonElement>('#search-chat-button');
  if (!btn) return;
  const hasChannel = Boolean(state.activeChannelId);
  btn.disabled = !hasChannel;
  btn.className = `size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer ${
    !hasChannel
      ? 'text-zinc-600 opacity-40 cursor-not-allowed'
      : isOpen
        ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20'
        : 'text-zinc-400 hover:text-indigo-400 hover:bg-zinc-800'
  }`;
  btn.title = hasChannel ? 'Search in conversation (⌘F)' : 'Select a conversation to search';
};

const mergeUsers = (incomingUsers: Record<string, User>) => {
  for (const uid in incomingUsers) {
    const existing = usersMap.get(uid);
    const merged = { ...existing, ...incomingUsers[uid] };
    usersMap.set(uid, merged);
    if (merged.status) {
      patchUserStatus(uid, merged.status);
    }
  }
};

const createMessageList = () => (
  <MessageList
    posts={state.posts}
    usersMap={usersMap}
    currentUserId={state.currentUser?.id}
    isLoadingOlder={state.isLoadingOlder}
    hasMoreOlderPosts={state.hasMoreOlderPosts}
    isLoadingNewer={state.isLoadingNewer}
    hasMoreNewerPosts={state.hasMoreNewerPosts}
    onJumpToLatest={() => {
      jumpToLatest();
    }}
    scrollRef={(el) => {
      scrollContainer = el;
    }}
    handleRef={(handle) => {
      messageListHandle = handle;
    }}
    onScroll={handleScroll}
    onRetry={(failedPost) => {
      sendMessage(failedPost.message, { retryPost: failedPost });
    }}
  />
);

const mountMessageList = () => {
  messageListHandle?.destroy();
  messageListHandle = null;
  if (!messageListSlotEl) {
    render();
    return;
  }
  messageListSlotEl.replaceChildren(createMessageList());
  patchExtractButton();
};

const createSearchPanel = (channel: Channel | undefined) => (
  <SearchPanel
    channel={channel}
    usersMap={usersMap}
    currentUserId={state.currentUser?.id}
    onClose={() => closeSearchPanel()}
    onJumpToPost={(post) => jumpToPost(post)}
    onUsersLoaded={mergeUsers}
    handleRef={(handle) => {
      searchPanelHandle = handle;
    }}
  />
);

const mountSearchPanel = () => {
  searchPanelHandle?.destroy();
  searchPanelHandle = null;
  if (!searchSlotEl) return;

  if (!state.isSearchOpen || !state.activeChannelId) {
    searchSlotEl.replaceChildren();
    return;
  }

  const activeChannel = state.channels.find((c) => c.id === state.activeChannelId);
  searchSlotEl.replaceChildren(createSearchPanel(activeChannel));
  const currentHandle = searchPanelHandle as SearchPanelHandle | null;
  currentHandle?.focus();
};

const openSearchPanel = () => {
  if (!state.activeChannelId) return;
  if (state.isSearchOpen && searchPanelHandle) {
    searchPanelHandle.focus();
    return;
  }
  state.isSearchOpen = true;
  patchSearchButton(true);
  mountSearchPanel();
};

const closeSearchPanel = () => {
  if (!state.isSearchOpen) return;
  state.isSearchOpen = false;
  patchSearchButton(false);
  mountSearchPanel();
};

const toggleSearchPanel = () => {
  if (state.isSearchOpen) {
    closeSearchPanel();
  } else {
    openSearchPanel();
  }
};

const render = () => {
  messageListHandle?.destroy();
  searchPanelHandle?.destroy();
  searchPanelHandle = null;
  updateDocumentTitle();
  const activeChannel = state.channels.find((c) => c.id === state.activeChannelId);

  root.replaceChildren(
    <div class="size-full flex overflow-hidden bg-zinc-950 font-sans">
      <Sidebar
        channels={state.channels}
        activeChannelId={state.activeChannelId}
        unreadChannelIds={state.unreadChannelIds}
        mentionChannelIds={state.mentionChannelIds}
        currentUser={state.currentUser}
        isConnected={state.isConnected}
        searchTerm={state.searchTerm}
        isSidebarOpen={state.isSidebarOpen}
        usersMap={usersMap}
        onSearchChange={(term) => {
          patchSidebarSearch(term);
        }}
        onSelectChannel={(id) => {
          selectChannel(id);
        }}
      />

      <main class="flex-1 flex flex-col bg-zinc-950/80 h-dvh overflow-hidden min-w-0">
        <ChatHeader
          channel={activeChannel}
          notificationsActive={state.soundEnabled && state.notificationsEnabled}
          onToggleNotifications={handleToggleNotifications}
          isSidebarOpen={state.isSidebarOpen}
          onToggleSidebar={toggleSidebar}
          isSearchOpen={state.isSearchOpen}
          onToggleSearch={toggleSearchPanel}
          loadedMessagesCount={state.posts.length}
          onExtractChat={handleExtractChat}
        />

        <div class="flex-1 flex min-h-0 overflow-hidden">
          <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
            <div
              ref={(el) => {
                messageListSlotEl = el;
              }}
              class="contents"
            >
              {createMessageList()}
            </div>

            <MessageInput
              typingText={state.typingText}
              errorMessage={state.errorMessage}
              onSend={(text, files) => {
                sendMessage(text, { files });
              }}
            />
          </div>

          <div
            ref={(el) => {
              searchSlotEl = el;
            }}
            class="contents"
          >
            {state.isSearchOpen && activeChannel ? createSearchPanel(activeChannel) : null}
          </div>
        </div>
      </main>
    </div>
  );
};

if (typeof window !== 'undefined') {
  (window as unknown as { __render_app__?: () => void }).__render_app__ = render;
}

const handleScroll = (e: Event) => {
  const target = (e.currentTarget || e.target) as HTMLElement | null;
  if (!target || scrollRafPending) return;

  scrollRafPending = true;
  requestAnimationFrame(() => {
    scrollRafPending = false;
    if (target.scrollTop <= 150 && !state.isLoadingOlder && state.hasMoreOlderPosts) {
      loadOlderMessages();
    }
    const distanceFromBottom = target.scrollHeight - target.clientHeight - target.scrollTop;
    if (distanceFromBottom <= 150 && !state.isLoadingNewer && state.hasMoreNewerPosts) {
      loadNewerMessages();
    }
  });
};

const scrollToBottom = () => {
  if (messageListHandle) {
    messageListHandle.scrollToBottom();
  } else if (scrollContainer) {
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }
};

const loadChannels = async () => {
  try {
    const res = await fetch('/api/channels');
    const channels: Channel[] = await res.json();
    state.channels = channels;

    for (const ch of channels) {
      if (ch.otherUser) {
        usersMap.set(ch.otherUser.id, ch.otherUser);
      }
    }

    render();

    if (!state.activeChannelId && channels.length > 0) {
      selectChannel(channels[0].id);
    }
  } catch (err) {
    console.error('Failed to load channels:', err);
  }
};

const selectChannel = async (channelId: string) => {
  state.activeChannelId = channelId;
  state.unreadChannelIds.delete(channelId);
  state.mentionChannelIds.delete(channelId);
  patchChannelBadge(channelId);
  updateDocumentTitle();

  state.posts = [];
  state.oldestPostId = null;
  state.newestPostId = null;
  state.hasMoreOlderPosts = true;
  state.hasMoreNewerPosts = false;
  state.isLoadingOlder = false;
  state.isLoadingNewer = false;
  state.typingText = '';
  state.errorMessage = null;
  jumpRequestSeq++;
  render();

  try {
    const res = await fetch(`/api/channels/${channelId}/posts?per_page=30`);
    const data = await res.json();
    if (state.activeChannelId !== channelId) return;

    if (data.users) {
      mergeUsers(data.users);
    }

    const order: string[] = data.order || [];
    const postsObj: Record<string, Post> = data.posts || {};

    if (order.length > 0) {
      state.oldestPostId = order[order.length - 1];
      state.posts = [...order].reverse().map((id) => postsObj[id]).filter(Boolean);
      state.newestPostId = state.posts[state.posts.length - 1]?.id ?? null;
    } else {
      state.hasMoreOlderPosts = false;
    }

    render();
    scrollToBottom();
  } catch (err) {
    console.error('Failed to load posts:', err);
  }
};

const jumpToLatest = async () => {
  const channelId = state.activeChannelId;
  if (!channelId) return;
  const reqSeq = ++jumpRequestSeq;

  try {
    const res = await fetch(`/api/channels/${channelId}/posts?per_page=30`);
    const data = await res.json();
    if (reqSeq !== jumpRequestSeq || state.activeChannelId !== channelId) return;

    if (data.users) {
      mergeUsers(data.users);
    }

    const order: string[] = data.order || [];
    const postsObj: Record<string, Post> = data.posts || {};

    state.isLoadingOlder = false;
    state.isLoadingNewer = false;
    state.hasMoreNewerPosts = false;

    if (order.length > 0) {
      state.oldestPostId = order[order.length - 1];
      state.posts = [...order].reverse().map((id) => postsObj[id]).filter(Boolean);
      state.newestPostId = state.posts[state.posts.length - 1]?.id ?? null;
      state.hasMoreOlderPosts = true;
    } else {
      state.posts = [];
      state.oldestPostId = null;
      state.newestPostId = null;
      state.hasMoreOlderPosts = false;
    }

    mountMessageList();
    scrollToBottom();
  } catch (err) {
    console.error('Failed to jump to latest:', err);
  }
};

const jumpToPost = async (post: Post) => {
  const channelId = post.channel_id || state.activeChannelId;
  if (!channelId || channelId !== state.activeChannelId) return;

  if (state.posts.some((p) => p.id === post.id) && messageListHandle?.scrollToPost(post.id)) {
    return;
  }

  const reqSeq = ++jumpRequestSeq;
  const contextSize = 15;

  try {
    const [beforeRes, afterRes] = await Promise.all([
      fetch(
        `/api/channels/${channelId}/posts?before=${encodeURIComponent(post.id)}&per_page=${contextSize}`
      ),
      fetch(
        `/api/channels/${channelId}/posts?after=${encodeURIComponent(post.id)}&per_page=${contextSize}`
      ),
    ]);
    const [beforeData, afterData] = await Promise.all([beforeRes.json(), afterRes.json()]);
    if (reqSeq !== jumpRequestSeq || state.activeChannelId !== channelId) return;

    if (beforeData.users) mergeUsers(beforeData.users);
    if (afterData.users) mergeUsers(afterData.users);

    const beforeOrder: string[] = beforeData.order || [];
    const afterOrder: string[] = afterData.order || [];
    const beforePosts = [...beforeOrder]
      .reverse()
      .map((id) => beforeData.posts?.[id])
      .filter((p): p is Post => Boolean(p));
    const afterPosts = [...afterOrder]
      .reverse()
      .map((id) => afterData.posts?.[id])
      .filter((p): p is Post => Boolean(p));

    const deduped = new Map<string, Post>();
    for (const p of [...beforePosts, post, ...afterPosts]) {
      deduped.set(p.id, p);
    }
    const windowPosts = [...deduped.values()].sort((a, b) => a.create_at - b.create_at);

    state.posts = windowPosts;
    state.oldestPostId = windowPosts[0]?.id ?? null;
    state.newestPostId = windowPosts[windowPosts.length - 1]?.id ?? null;
    state.hasMoreOlderPosts = beforeOrder.length > 0;
    state.hasMoreNewerPosts = afterOrder.length >= contextSize;
    state.isLoadingOlder = false;
    state.isLoadingNewer = false;

    mountMessageList();
    (messageListHandle as MessageListHandle | null)?.scrollToPost(post.id, { instant: true });
  } catch (err) {
    console.error('Failed to jump to post:', err);
  }
};

const loadNewerMessages = async () => {
  if (
    state.isLoadingNewer ||
    !state.hasMoreNewerPosts ||
    !state.newestPostId ||
    !state.activeChannelId
  ) {
    return;
  }

  const channelId = state.activeChannelId;
  const reqSeq = jumpRequestSeq;
  state.isLoadingNewer = true;
  messageListHandle?.setLoadingNewer(true);

  try {
    const res = await fetch(
      `/api/channels/${channelId}/posts?after=${encodeURIComponent(state.newestPostId)}&per_page=30`
    );
    const data = await res.json();
    if (reqSeq !== jumpRequestSeq || state.activeChannelId !== channelId) return;

    if (data.users) {
      mergeUsers(data.users);
    }

    const order: string[] = data.order || [];
    const postsObj: Record<string, Post> = data.posts || {};

    state.isLoadingNewer = false;
    messageListHandle?.setLoadingNewer(false);

    if (order.length === 0) {
      state.hasMoreNewerPosts = false;
      messageListHandle?.setHasMoreNewer(false);
      return;
    }

    const existingIds = new Set(state.posts.map((p) => p.id));
    const newerPosts = [...order]
      .reverse()
      .map((id) => postsObj[id])
      .filter((p): p is Post => Boolean(p) && !existingIds.has(p.id));

    if (newerPosts.length > 0) {
      state.posts.push(...newerPosts);
      state.newestPostId = state.posts[state.posts.length - 1]?.id ?? state.newestPostId;
      patchExtractButton();
      messageListHandle?.appendPosts(newerPosts);
    }

    if (order.length < 30) {
      state.hasMoreNewerPosts = false;
      messageListHandle?.setHasMoreNewer(false);
    }
  } catch {
    state.isLoadingNewer = false;
    messageListHandle?.setLoadingNewer(false);
  }
};

const loadOlderMessages = async () => {
  if (
    state.isLoadingOlder ||
    !state.hasMoreOlderPosts ||
    !state.oldestPostId ||
    !state.activeChannelId
  ) {
    return;
  }

  state.isLoadingOlder = true;
  if (messageListHandle) {
    messageListHandle.setLoadingOlder(true);
  } else {
    render();
  }

  const prevScrollHeight = scrollContainer ? scrollContainer.scrollHeight : 0;
  const prevScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

  try {
    const res = await fetch(
      `/api/channels/${state.activeChannelId}/posts?before=${encodeURIComponent(
        state.oldestPostId
      )}&per_page=30`
    );
    const data = await res.json();

    if (data.users) {
      for (const uid in data.users) {
        const existing = usersMap.get(uid);
        const merged = { ...existing, ...data.users[uid] };
        usersMap.set(uid, merged);
        if (merged.status) {
          patchUserStatus(uid, merged.status);
        }
      }
    }

    const order: string[] = data.order || [];
    const postsObj: Record<string, Post> = data.posts || {};

    state.isLoadingOlder = false;

    if (order.length === 0) {
      state.hasMoreOlderPosts = false;
      if (messageListHandle) {
        messageListHandle.setLoadingOlder(false);
      } else {
        render();
      }
      return;
    }

    state.oldestPostId = order[order.length - 1];
    const olderPosts = [...order].reverse().map((id) => postsObj[id]).filter(Boolean);

    state.posts.unshift(...olderPosts);
    patchExtractButton();

    if (messageListHandle) {
      messageListHandle.setLoadingOlder(false);
      messageListHandle.prependPosts(olderPosts, prevScrollHeight, prevScrollTop);
    } else {
      render();
      requestAnimationFrame(() => {
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight - prevScrollHeight + prevScrollTop;
        }
      });
    }
  } catch (err) {
    state.isLoadingOlder = false;
    if (messageListHandle) {
      messageListHandle.setLoadingOlder(false);
    } else {
      render();
    }
  }
};

const uploadChannelFiles = async (
  channelId: string,
  files: File[]
): Promise<FileAttachment[]> => {
  const formData = new FormData();
  formData.append('channel_id', channelId);
  for (const file of files) {
    formData.append('files', file, file.name);
  }

  const res = await fetch('/api/files', {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Upload failed with status ${res.status}`);
  }

  const data = await res.json();
  return data.file_infos || [];
};

const sendMessage = async (
  text: string,
  options?: { files?: File[]; retryPost?: Post }
) => {
  const filesToSend = options?.files || [];
  if ((!text && filesToSend.length === 0) || !state.activeChannelId) return;

  if (state.hasMoreNewerPosts) {
    await jumpToLatest();
  }

  const channelId = state.activeChannelId;
  const retryPost = options?.retryPost;
  const tempId =
    retryPost?.tempId ||
    retryPost?.id ||
    `temp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  const optimisticFiles: FileAttachment[] = filesToSend.map((f, i) => ({
    id: `temp_file_${Date.now()}_${i}`,
    name: f.name,
    extension: f.name.split('.').pop() || '',
    size: f.size,
    mime_type: f.type,
    has_preview_image: f.type.startsWith('image/'),
    preview_url: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
  }));

  if (retryPost) {
    const existingIdx = state.posts.findIndex((p) => p.id === tempId || p.tempId === tempId);
    if (existingIdx !== -1) {
      state.posts[existingIdx].status = 'sending';
      const pendingPost = state.posts[existingIdx];
      messageListHandle?.reconcilePost(tempId, pendingPost);
    }
  } else {
    const optimisticPost: Post = {
      id: tempId,
      tempId,
      user_id: state.currentUser?.id || 'me',
      channel_id: channelId,
      message: text,
      create_at: Date.now(),
      status: 'sending',
      metadata: optimisticFiles.length > 0 ? { files: optimisticFiles } : undefined,
    };

    state.posts.push(optimisticPost);
    patchExtractButton();
    if (messageListHandle) {
      messageListHandle.appendPost(optimisticPost);
    } else {
      render();
      scrollToBottom();
    }
  }

  try {
    let uploadedFileIds: string[] = [];
    if (filesToSend.length > 0) {
      const uploaded = await uploadChannelFiles(channelId, filesToSend);
      uploadedFileIds = uploaded.map((f) => f.id);
    }

    const res = await fetch(`/api/channels/${channelId}/posts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        file_ids: uploadedFileIds,
      }),
    });

    if (!res.ok) {
      throw new Error(`Server returned ${res.status}`);
    }

    const serverPost: Post = await res.json();
    serverPost.status = 'sent';

    const idx = state.posts.findIndex((p) => p.id === tempId || p.tempId === tempId);
    if (idx !== -1) {
      state.posts[idx] = serverPost;
    } else if (!state.posts.some((p) => p.id === serverPost.id)) {
      state.posts.push(serverPost);
    }

    patchErrorMessage(null);
    if (messageListHandle) {
      messageListHandle.reconcilePost(tempId, serverPost);
    } else {
      render();
      scrollToBottom();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const idx = state.posts.findIndex((p) => p.id === tempId || p.tempId === tempId);
    if (idx !== -1) {
      state.posts[idx].status = 'failed';
    }

    if (messageListHandle) {
      messageListHandle.markPostFailed(tempId);
    } else {
      render();
    }

    patchErrorMessage(`Failed to send: ${message}`);
    if (errorTimer) clearTimeout(errorTimer);
    errorTimer = setTimeout(() => {
      patchErrorMessage(null);
    }, 5000);
  }
};

const connectWebSocket = () => {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const wsTarget = import.meta.env?.VITE_WS_TARGET;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = wsTarget || `${protocol}//${location.host}/ws`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    patchConnectionStatus(true);
    if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {}
      }
    }, 25000);
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'pong') return;
      if (data.event === 'posted') {
        const post: Post =
          typeof data.data?.post === 'string' ? JSON.parse(data.data.post) : data.data?.post;
        if (!post || !post.id) return;

        if (!usersMap.has(post.user_id) && data.data?.sender_name) {
          const cleanName = String(data.data.sender_name).replace(/^@/, '');
          usersMap.set(post.user_id, {
            id: post.user_id,
            username: cleanName,
            display_name: cleanName,
          });
        }

        const isFromMe = post.user_id === state.currentUser?.id;
        const messageText =
          post.message ||
          (post.props?.attachments && post.props.attachments.length > 0
            ? post.props.attachments
                .map((a) => [a.title, a.text || a.fallback || a.pretext].filter(Boolean).join('\n'))
                .filter(Boolean)
                .join('\n\n')
            : '');
        const isMention =
          !isFromMe && isUserMentioned(messageText, state.currentUser?.username);
        const isCurrentChannel = post.channel_id === state.activeChannelId;
        const isWindowHidden =
          typeof document !== 'undefined' && (document.hidden || !document.hasFocus());

        if (isCurrentChannel) {
          if (state.hasMoreNewerPosts) {
            messageListHandle?.setHasMoreNewer(true, 'New messages available');
          } else {
            if (isFromMe) {
              const pendingIdx = state.posts.findIndex(
                (p) => (p.status === 'sending' || p.tempId) && p.message === post.message
              );
              if (pendingIdx !== -1) {
                const tempId = state.posts[pendingIdx].tempId || state.posts[pendingIdx].id;
                post.status = 'sent';
                state.posts[pendingIdx] = post;
                if (messageListHandle) {
                  messageListHandle.reconcilePost(tempId, post);
                }
                return;
              }
            }

            if (!state.posts.some((p) => p.id === post.id)) {
              state.posts.push(post);
              state.newestPostId = post.id;
              patchExtractButton();
              if (messageListHandle) {
                messageListHandle.appendPost(post);
              } else {
                render();
                scrollToBottom();
              }
            }
          }
        } else if (!isFromMe) {
          state.unreadChannelIds.add(post.channel_id);
          if (isMention) {
            state.mentionChannelIds.add(post.channel_id);
          }
          patchChannelBadge(post.channel_id);
          updateDocumentTitle();
        }

        if (!isFromMe) {
          const author = usersMap.get(post.user_id);
          const authorName =
            post.props?.override_username ||
            author?.display_name ||
            author?.username ||
            (data.data?.sender_name ? String(data.data.sender_name).replace(/^@/, '') : 'Someone');
          const targetChannel = state.channels.find((c) => c.id === post.channel_id);
          const channelTitle = targetChannel
            ? formatChannelName(targetChannel, usersMap, state.currentUser?.id).title
            : 'chat';

          if (state.soundEnabled) {
            if (isMention) {
              playMentionChime();
            } else {
              playMessageChime();
            }
          }

          if (state.notificationsEnabled && (!isCurrentChannel || isWindowHidden)) {
            showDesktopNotification({
              title: isMention
                ? `@${authorName} mentioned you in ${channelTitle}`
                : `${channelTitle} - @${authorName}`,
              body: (messageText || 'Sent an attachment').slice(0, 120),
              tag: `channel-${post.channel_id}`,
              onClick: () => {
                selectChannel(post.channel_id);
              },
            });
          }
        }
      } else if (data.event === 'post_edited' || data.event === 'post_updated') {
        const post: Post =
          typeof data.data?.post === 'string' ? JSON.parse(data.data.post) : data.data?.post;

        if (post && post.channel_id === state.activeChannelId) {
          const idx = state.posts.findIndex((p) => p.id === post.id);
          if (idx !== -1) {
            state.posts[idx] = { ...state.posts[idx], ...post };
            if (messageListHandle) {
              messageListHandle.updatePost(state.posts[idx]);
            } else {
              render();
            }
          } else {
            state.posts.push(post);
            if (messageListHandle) {
              messageListHandle.appendPost(post);
            } else {
              render();
              scrollToBottom();
            }
          }
        }
      } else if (data.event === 'typing') {
        if (data.broadcast?.channel_id === state.activeChannelId && data.data?.parent_id === '') {
          patchTypingIndicator('Someone is typing...');
          if (typingTimer) clearTimeout(typingTimer);
          typingTimer = setTimeout(() => {
            patchTypingIndicator('');
          }, 2500);
        }
      } else if (data.event === 'status_change') {
        const uid = data.data?.user_id;
        const status = data.data?.status;
        if (uid && status) {
          const user = usersMap.get(uid);
          if (user) {
            user.status = status;
            patchUserStatus(uid, status);
          }
        }
      }
    } catch {}
  };

  ws.onclose = () => {
    if (wsHeartbeatTimer) {
      clearInterval(wsHeartbeatTimer);
      wsHeartbeatTimer = null;
    }
    ws = null;
    patchConnectionStatus(false);
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectWebSocket();
      }, 3000);
    }
  };
};

const ensureWebSocketConnected = () => {
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    connectWebSocket();
  }
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', ensureWebSocketConnected);
  window.addEventListener('focus', ensureWebSocketConnected);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      ensureWebSocketConnected();
    }
  });
}

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    toggleSidebar();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (!state.isSidebarOpen) {
      patchSidebarToggle(true);
    }
    const searchInput = document.querySelector('#sidebar-search-input') as HTMLInputElement;
    if (searchInput) {
      searchInput.focus();
      searchInput.select();
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
    if (state.activeChannelId) {
      e.preventDefault();
      openSearchPanel();
    }
  } else if (e.key === 'Escape') {
    const searchInput = document.querySelector('#sidebar-search-input') as HTMLInputElement;
    if (document.activeElement === searchInput) {
      searchInput.value = '';
      patchSidebarSearch('');
      searchInput.blur();
    } else if (state.isSearchOpen) {
      closeSearchPanel();
    }
  }
});

const init = async () => {
  try {
    const meRes = await fetch('/api/me');
    state.currentUser = await meRes.json();
    if (state.currentUser) {
      usersMap.set(state.currentUser.id, state.currentUser);
    }
    await loadChannels();
    connectWebSocket();
  } catch (err) {
    console.error('Init error:', err);
  }
};

init();
render();
