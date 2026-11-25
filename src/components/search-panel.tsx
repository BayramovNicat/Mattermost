import type { Channel, Post, SearchResultResponse, User } from '../types';
import { formatChannelName } from '../utils/channel-name';
import { extractHighlightTerms, splitHighlightedText } from '../utils/search';
import { UserAvatar } from './avatar';
import { PaperclipIcon, SearchIcon, SpinnerIcon, XIcon } from './icons';

export interface SearchPanelHandle {
  focus: () => void;
  removePost: (postId: string) => void;
  destroy: () => void;
}

interface SearchPanelProps {
  channel: Channel | undefined;
  usersMap: Map<string, User>;
  currentUserId: string | undefined;
  onClose: () => void;
  onJumpToPost: (post: Post) => Promise<void> | void;
  onUsersLoaded?: (users: Record<string, User>) => void;
  handleRef?: (handle: SearchPanelHandle | null) => void;
}

const PER_PAGE = 25;
const DEBOUNCE_MS = 280;

const timeFormatter = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const shortDateFormatter = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });

const formatResultTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const time = timeFormatter.format(date);
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return `Today at ${time}`;
  const isSameYear = date.getFullYear() === now.getFullYear();
  return `${isSameYear ? shortDateFormatter.format(date) : dateFormatter.format(date)} at ${time}`;
};

const getPostText = (post: Post): string => {
  if (post.message) return post.message;
  if (post.props?.attachments && post.props.attachments.length > 0) {
    return post.props.attachments
      .map((a) => [a.title, a.text || a.fallback || a.pretext].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
};

const renderHighlightedText = (text: string, terms: string[]) => {
  const segments = splitHighlightedText(text, terms);
  return segments.map((seg, idx) =>
    seg.highlighted ? (
      <mark key={idx} class="bg-indigo-500/30 text-indigo-200 rounded-xs px-0.5 font-medium">
        {seg.text}
      </mark>
    ) : (
      seg.text
    ),
  );
};

export const SearchPanel = ({
  channel,
  usersMap,
  currentUserId,
  onClose,
  onJumpToPost,
  onUsersLoaded,
  handleRef,
}: SearchPanelProps) => {
  let query = '';
  let page = 0;
  let hasMore = false;
  let isLoading = false;
  let jumpingPostId: string | null = null;
  let activeResultId: string | null = null;
  let errorMessage: string | null = null;
  let results: Post[] = [];
  let matchesMap: Record<string, string[]> = {};
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null = null;
  let inputEl: HTMLInputElement | null = null;
  let clearBtnEl: HTMLButtonElement | null = null;
  let bodyEl: HTMLElement | null = null;
  let statusEl: HTMLElement | null = null;

  const channelDetails = formatChannelName(channel, usersMap, currentUserId);
  const scopeLabel = channel ? channelDetails.title : 'conversation';

  const cancelPending = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
  };

  const updateClearButton = () => {
    if (!clearBtnEl) return;
    clearBtnEl.style.display = query.length > 0 ? 'flex' : 'none';
  };

  const handleJumpClick = async (post: Post) => {
    if (jumpingPostId === post.id) return;
    jumpingPostId = post.id;
    activeResultId = post.id;
    renderBody();
    try {
      await onJumpToPost(post);
    } finally {
      if (jumpingPostId === post.id) {
        jumpingPostId = null;
        renderBody();
      }
    }
  };

  const renderBody = () => {
    if (!bodyEl || !statusEl) return;

    const trimmed = query.trim();

    if (!trimmed) {
      statusEl.textContent = '';
      bodyEl.replaceChildren(
        <div class="p-6 text-center space-y-2">
          <div class="size-10 mx-auto rounded-xl bg-zinc-800/70 flex items-center justify-center text-zinc-400">
            <SearchIcon class="size-4.5" />
          </div>
          <p class="text-xs font-medium text-zinc-300">Search in {scopeLabel}</p>
          <p class="text-[11px] text-zinc-500 leading-relaxed">
            Find messages in this conversation. Supports{' '}
            <code class="px-1 py-0.5 rounded-xs bg-zinc-800 text-zinc-300 font-mono">
              from:@user
            </code>
            ,{' '}
            <code class="px-1 py-0.5 rounded-xs bg-zinc-800 text-zinc-300 font-mono">
              before:YYYY-MM-DD
            </code>
            , and{' '}
            <code class="px-1 py-0.5 rounded-xs bg-zinc-800 text-zinc-300 font-mono">
              "exact phrase"
            </code>
            .
          </p>
        </div>,
      );
      return;
    }

    if (isLoading && results.length === 0) {
      statusEl.textContent = 'Searching...';
      bodyEl.replaceChildren(
        <div class="p-8 flex flex-col items-center justify-center gap-2 text-zinc-400">
          <SpinnerIcon class="size-5 text-indigo-400" />
          <span class="text-xs">Searching {scopeLabel}...</span>
        </div>,
      );
      return;
    }

    if (errorMessage) {
      statusEl.textContent = 'Search failed';
      bodyEl.replaceChildren(
        <div class="p-6 text-center space-y-2">
          <p class="text-xs text-rose-400 font-medium">{errorMessage}</p>
          <button
            type="button"
            onClick={() => runSearch(trimmed, 0)}
            class="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors cursor-pointer"
          >
            Try again
          </button>
        </div>,
      );
      return;
    }

    if (results.length === 0) {
      statusEl.textContent = '0 results';
      bodyEl.replaceChildren(
        <div class="p-8 text-center space-y-1.5">
          <p class="text-xs font-medium text-zinc-300">No messages found</p>
          <p class="text-[11px] text-zinc-500 wrap-break-word">
            Nothing in {scopeLabel} matched "{trimmed}".
          </p>
        </div>,
      );
      return;
    }

    statusEl.textContent = `${results.length}${hasMore ? '+' : ''} ${
      results.length === 1 ? 'result' : 'results'
    }`;

    const fragment = document.createDocumentFragment();

    for (const post of results) {
      const author = usersMap.get(post.user_id);
      const authorName =
        post.props?.override_username || author?.display_name || author?.username || 'user';
      const isMe = post.user_id === currentUserId;
      const text = getPostText(post);
      const highlightTerms = extractHighlightTerms(trimmed, matchesMap[post.id]);
      const filesCount = post.metadata?.files?.length || post.file_ids?.length || 0;
      const isJumping = jumpingPostId === post.id;
      const isActiveResult = activeResultId === post.id;

      fragment.appendChild(
        <article
          data-search-post-id={post.id}
          class={`p-3 rounded-xl border transition-colors ${
            isActiveResult
              ? 'bg-indigo-500/10 border-indigo-500/40'
              : 'bg-zinc-900/70 border-zinc-800/80 hover:border-zinc-700'
          }`}
        >
          <button
            type="button"
            onClick={() => handleJumpClick(post)}
            class="w-full text-left cursor-pointer space-y-2 focus:outline-hidden"
          >
            <div class="flex items-center justify-between gap-2 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <UserAvatar
                  userId={post.user_id}
                  name={authorName}
                  avatarUrl={post.props?.override_icon_url}
                  sizeClass="size-6"
                  textClass="text-[10px]"
                  lastPictureUpdate={author?.last_picture_update}
                  status={author?.status || (isMe ? 'online' : 'offline')}
                  showStatus={false}
                />
                <span
                  class={`text-xs font-semibold truncate ${
                    isMe ? 'text-indigo-400' : 'text-zinc-100'
                  }`}
                >
                  {authorName}
                </span>
              </div>
              <span class="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-xs bg-zinc-800/90 text-zinc-300 shrink-0">
                {isJumping ? <SpinnerIcon class="size-3 text-indigo-400" /> : 'Jump'}
              </span>
            </div>

            {text && (
              <p class="text-xs text-zinc-300 leading-relaxed whitespace-pre-wrap wrap-break-word line-clamp-5">
                {renderHighlightedText(text, highlightTerms)}
              </p>
            )}

            <div class="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
              <time class="font-mono">{formatResultTimestamp(post.create_at)}</time>
              {filesCount > 0 && (
                <span class="inline-flex items-center gap-1 text-zinc-400">
                  <PaperclipIcon class="size-3" />
                  <span>
                    {filesCount} {filesCount === 1 ? 'file' : 'files'}
                  </span>
                </span>
              )}
            </div>
          </button>
        </article>,
      );
    }

    if (hasMore) {
      fragment.appendChild(
        <div class="pt-1 pb-2 flex justify-center">
          <button
            type="button"
            disabled={isLoading}
            onClick={() => runSearch(trimmed, page + 1, true)}
            class="w-full py-2 rounded-lg text-xs font-medium bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition-colors cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {isLoading && <SpinnerIcon class="size-3.5 text-indigo-400" />}
            <span>{isLoading ? 'Loading more...' : 'Load more results'}</span>
          </button>
        </div>,
      );
    }

    bodyEl.replaceChildren(fragment);
  };

  const runSearch = async (searchText: string, targetPage = 0, append = false) => {
    const trimmed = searchText.trim();
    if (!channel || !trimmed) {
      cancelPending();
      results = [];
      matchesMap = {};
      hasMore = false;
      isLoading = false;
      errorMessage = null;
      renderBody();
      return;
    }

    if (abortController) {
      abortController.abort();
    }
    abortController = new AbortController();
    const signal = abortController.signal;

    isLoading = true;
    errorMessage = null;
    if (!append) {
      results = [];
      matchesMap = {};
      page = 0;
    }
    renderBody();

    try {
      const params = new URLSearchParams({
        q: trimmed,
        page: String(targetPage),
        per_page: String(PER_PAGE),
      });
      const res = await fetch(`/api/channels/${channel.id}/search?${params.toString()}`, {
        signal,
      });
      const contentType = res.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');
      const data = (isJson ? await res.json() : null) as
        | (SearchResultResponse & { error?: string })
        | null;

      if (!res.ok || !data) {
        const text = !isJson ? (await res.text()).trim() : '';
        if (res.status === 404) {
          throw new Error('Search API not found (404). Restart the server to load the new route.');
        }
        throw new Error(data?.error || text || `Search failed (${res.status})`);
      }

      if (signal.aborted) return;

      if (data.users) {
        onUsersLoaded?.(data.users);
      }

      const fetchedPosts = (data.order || [])
        .map((id) => data.posts?.[id])
        .filter((p): p is Post => Boolean(p));

      if (append) {
        const existingIds = new Set(results.map((p) => p.id));
        for (const post of fetchedPosts) {
          if (!existingIds.has(post.id)) {
            results.push(post);
          }
        }
        matchesMap = { ...matchesMap, ...(data.matches || {}) };
      } else {
        results = fetchedPosts;
        matchesMap = data.matches || {};
      }

      page = targetPage;
      hasMore = fetchedPosts.length >= PER_PAGE;
      isLoading = false;
      renderBody();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      isLoading = false;
      errorMessage = err instanceof Error ? err.message : 'Search failed';
      renderBody();
    }
  };

  const handleInput = (e: Event) => {
    query = (e.currentTarget as HTMLInputElement).value;
    updateClearButton();
    if (debounceTimer) clearTimeout(debounceTimer);

    if (!query.trim()) {
      runSearch('');
      return;
    }

    debounceTimer = setTimeout(() => {
      runSearch(query, 0);
    }, DEBOUNCE_MS);
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    runSearch(query, 0);
  };

  const handle: SearchPanelHandle = {
    focus: () => {
      if (inputEl) {
        inputEl.focus();
        inputEl.select();
      }
    },
    removePost: (postId: string) => {
      const prevLen = results.length;
      results = results.filter((p) => p.id !== postId);
      if (results.length !== prevLen) {
        delete matchesMap[postId];
        if (activeResultId === postId) activeResultId = null;
        if (jumpingPostId === postId) jumpingPostId = null;
        renderBody();
      }
    },
    destroy: () => {
      cancelPending();
    },
  };

  handleRef?.(handle);

  const panel = (
    <aside
      aria-label="Search in conversation"
      class="w-full sm:w-90 bg-zinc-950 border-l border-zinc-800/80 flex flex-col shrink-0 min-h-0 overflow-hidden"
    >
      <header class="px-4 py-3 border-b border-zinc-800/80 flex items-center justify-between gap-2 bg-zinc-900/40 shrink-0">
        <div class="min-w-0">
          <h3 class="text-xs font-bold text-zinc-100 truncate">Search in {scopeLabel}</h3>
          <span
            ref={(el) => {
              statusEl = el;
            }}
            class="text-[10px] text-zinc-500 font-mono block min-h-3.5"
          />
        </div>
        <button
          id="search-panel-close-button"
          type="button"
          onClick={() => {
            cancelPending();
            onClose();
          }}
          class="size-7 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer shrink-0"
          title="Close search (Esc)"
          aria-label="Close search"
        >
          <XIcon class="size-4" />
        </button>
      </header>

      <form onSubmit={handleSubmit} class="p-3 border-b border-zinc-800/60 bg-zinc-900/20 shrink-0">
        <div class="relative flex items-center">
          <SearchIcon class="size-3.5 text-zinc-500 absolute left-2.5 pointer-events-none" />
          <input
            ref={(el) => {
              inputEl = el;
            }}
            id="conversation-search-input"
            type="text"
            name="search"
            autoComplete="off"
            placeholder={`Search in ${scopeLabel}...`}
            onInput={handleInput}
            class="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-8 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:outline-hidden focus:border-indigo-500 transition-colors"
          />
          <button
            ref={(el) => {
              clearBtnEl = el;
            }}
            type="button"
            style={{ display: 'none' }}
            onClick={() => {
              query = '';
              if (inputEl) {
                inputEl.value = '';
                inputEl.focus();
              }
              updateClearButton();
              runSearch('');
            }}
            class="size-6 rounded-md items-center justify-center text-zinc-500 hover:text-zinc-200 absolute right-1.5 cursor-pointer"
            aria-label="Clear search"
          >
            <XIcon class="size-3.5" />
          </button>
        </div>
      </form>

      <div
        ref={(el) => {
          bodyEl = el;
        }}
        class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-3 space-y-2"
      />
    </aside>
  );

  renderBody();
  requestAnimationFrame(() => {
    inputEl?.focus();
  });

  return panel;
};
