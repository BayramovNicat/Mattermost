import type { Post, User } from '../types';
import {
  formatDateDivider,
  getDateKey,
  isSameDay,
  shouldGroupPosts,
} from '../utils/message-grouping';
import { MessageSquareIcon, SpinnerIcon } from './icons';
import { MessageItem } from './message-item';

export interface MessageListHandle {
  appendPost: (post: Post) => void;
  appendPosts: (posts: Post[]) => void;
  updatePost: (post: Post) => void;
  reconcilePost: (tempId: string, serverPost: Post) => void;
  markPostFailed: (tempId: string) => void;
  prependPosts: (posts: Post[], prevScrollHeight: number, prevScrollTop: number) => void;
  setLoadingOlder: (loading: boolean) => void;
  setLoadingNewer: (loading: boolean) => void;
  setHasMoreNewer: (hasMore: boolean, label?: string) => void;
  scrollToBottom: () => void;
  scrollToPost: (postId: string, options?: { instant?: boolean }) => boolean;
  getScrollContainer: () => HTMLElement | null;
  destroy: () => void;
}

interface MessageListProps {
  posts: Post[];
  usersMap: Map<string, User>;
  currentUserId: string | undefined;
  isLoadingOlder: boolean;
  hasMoreOlderPosts: boolean;
  isLoadingNewer?: boolean;
  hasMoreNewerPosts?: boolean;
  onJumpToLatest?: () => void;
  onScroll?: (e: Event) => void;
  scrollRef?: (el: HTMLElement | null) => void;
  handleRef?: (handle: MessageListHandle | null) => void;
  onRetry?: (post: Post) => void;
}

export const DateDivider = ({ timestamp }: { timestamp: number }) => {
  const dateKey = getDateKey(timestamp);
  const label = formatDateDivider(timestamp);
  return (
    <div
      data-date-divider={dateKey}
      class="relative flex items-center justify-center my-4 py-1 select-none"
    >
      <div class="absolute inset-0 flex items-center" aria-hidden="true">
        <div class="w-full border-t border-zinc-800/80" />
      </div>
      <div class="relative px-3.5 py-0.5 bg-zinc-900 border border-zinc-800 rounded-full text-[11px] font-medium text-zinc-400 shadow-xs tracking-wide">
        {label}
      </div>
    </div>
  );
};

export const MessageList = ({
  posts: initialPosts,
  usersMap,
  currentUserId,
  isLoadingOlder,
  hasMoreOlderPosts,
  isLoadingNewer = false,
  hasMoreNewerPosts = false,
  onJumpToLatest,
  onScroll,
  scrollRef,
  handleRef,
  onRetry,
}: MessageListProps) => {
  if (initialPosts.length === 0) {
    scrollRef?.(null);
    handleRef?.(null);
    return (
      <div class="flex-1 flex flex-col items-center justify-center text-zinc-500 gap-2 p-6">
        <MessageSquareIcon class="size-8 opacity-40" />
        <p class="text-xs">No messages yet. Send a message to start the conversation!</p>
      </div>
    );
  }

  const BOTTOM_THRESHOLD = 60;
  const posts = [...initialPosts];
  let containerEl: HTMLElement | null = null;
  let itemsContainerEl: HTMLElement | null = null;
  let loadingSpinnerEl: HTMLElement | null = null;
  let loadingNewerEl: HTMLElement | null = null;
  let jumpBannerEl: HTMLElement | null = null;
  let jumpBannerLabelEl: HTMLElement | null = null;
  let stickToBottom = false;
  let pinnedPostId: string | null = null;
  let lastScrollTop = 0;
  let isProgrammaticScroll = false;
  let resizeObserver: ResizeObserver | null = null;

  const createItem = (post: Post, isGrouped: boolean = false) => (
    <MessageItem
      key={post.id}
      post={post}
      author={usersMap.get(post.user_id)}
      isMe={post.user_id === currentUserId}
      isGrouped={isGrouped}
      onRetry={onRetry}
    />
  );

  const isPostGroupedAtIndex = (index: number): boolean => {
    if (index <= 0) return false;
    return shouldGroupPosts(posts[index - 1], posts[index]);
  };

  const isNearBottom = (threshold = BOTTOM_THRESHOLD): boolean => {
    if (!containerEl) return false;
    return containerEl.scrollHeight - containerEl.clientHeight - containerEl.scrollTop <= threshold;
  };

  const snapToBottom = () => {
    if (!containerEl) return;
    const prevTop = containerEl.scrollTop;
    const targetTop = Math.max(0, containerEl.scrollHeight - containerEl.clientHeight);
    if (Math.abs(targetTop - prevTop) > 0.5) {
      isProgrammaticScroll = true;
      containerEl.scrollTop = containerEl.scrollHeight;
      lastScrollTop = containerEl.scrollTop;
      requestAnimationFrame(() => {
        isProgrammaticScroll = false;
      });
    } else {
      lastScrollTop = containerEl.scrollTop;
    }
  };

  const centerPinnedPost = () => {
    if (!pinnedPostId || !containerEl || !itemsContainerEl) return;
    const escapedId =
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(pinnedPostId) : pinnedPostId;
    const pinnedEl = itemsContainerEl.querySelector<HTMLElement>(
      `article[data-post-id="${escapedId}"]`
    );
    if (!pinnedEl) return;
    isProgrammaticScroll = true;
    pinnedEl.scrollIntoView({ behavior: 'auto', block: 'center' });
    lastScrollTop = containerEl.scrollTop;
    requestAnimationFrame(() => {
      isProgrammaticScroll = false;
    });
  };

  const scrollToBottom = () => {
    pinnedPostId = null;
    stickToBottom = true;
    snapToBottom();
    requestAnimationFrame(() => {
      if (stickToBottom) {
        snapToBottom();
      }
    });
  };

  const handleContainerScroll = (e: Event) => {
    if (!containerEl) return;
    const currentScrollTop = containerEl.scrollTop;

    if (!isProgrammaticScroll) {
      pinnedPostId = null;
    }

    if (isNearBottom()) {
      stickToBottom = true;
    } else if (currentScrollTop < lastScrollTop) {
      stickToBottom = false;
    }
    lastScrollTop = currentScrollTop;

    if (isProgrammaticScroll) {
      isProgrammaticScroll = false;
      return;
    }

    onScroll?.(e);
  };

  const setupObservers = () => {
    if (!containerEl || !itemsContainerEl) return;
    if (resizeObserver || typeof ResizeObserver === 'undefined') return;

    resizeObserver = new ResizeObserver(() => {
      if (!containerEl?.isConnected) {
        resizeObserver?.disconnect();
        resizeObserver = null;
        return;
      }
      if (stickToBottom) {
        snapToBottom();
      } else if (pinnedPostId) {
        centerPinnedPost();
      }
    });

    resizeObserver.observe(itemsContainerEl);
    resizeObserver.observe(containerEl);
  };

  const handle: MessageListHandle = {
    appendPost: (post: Post) => {
      if (posts.some((p) => p.id === post.id)) return;
      const shouldStick =
        stickToBottom || isNearBottom(100) || post.user_id === currentUserId;

      const lastPost = posts[posts.length - 1];
      const needsDivider = !lastPost || !isSameDay(lastPost.create_at, post.create_at);
      const isGrouped = shouldGroupPosts(lastPost, post);

      posts.push(post);
      if (itemsContainerEl) {
        if (needsDivider) {
          itemsContainerEl.appendChild(<DateDivider timestamp={post.create_at} />);
        }
        itemsContainerEl.appendChild(createItem(post, isGrouped));
      }

      if (shouldStick) {
        scrollToBottom();
      }
    },

    appendPosts: (newerPosts: Post[]) => {
      if (newerPosts.length === 0) return;
      pinnedPostId = null;

      const fragment = document.createDocumentFragment();
      let prev: Post | undefined = posts[posts.length - 1];
      let lastDateKey = prev ? getDateKey(prev.create_at) : '';
      const existingIds = new Set(posts.map((p) => p.id));

      for (const post of newerPosts) {
        if (existingIds.has(post.id)) continue;
        existingIds.add(post.id);

        const dateKey = getDateKey(post.create_at);
        if (dateKey !== lastDateKey) {
          fragment.appendChild(<DateDivider timestamp={post.create_at} />);
          lastDateKey = dateKey;
          prev = undefined;
        }
        const isGrouped = shouldGroupPosts(prev, post);
        fragment.appendChild(createItem(post, isGrouped));
        posts.push(post);
        prev = post;
      }

      if (itemsContainerEl) {
        itemsContainerEl.appendChild(fragment);
      }
    },

    updatePost: (updatedPost: Post) => {
      const idx = posts.findIndex((p) => p.id === updatedPost.id);
      if (idx !== -1) {
        posts[idx] = updatedPost;
        if (itemsContainerEl) {
          const existingEl = itemsContainerEl.querySelector(`article[data-post-id="${updatedPost.id}"]`);
          if (existingEl) {
            const isGrouped = isPostGroupedAtIndex(idx);
            existingEl.replaceWith(createItem(updatedPost, isGrouped));
          }
        }
      } else {
        handle.appendPost(updatedPost);
      }
    },

    reconcilePost: (tempId: string, serverPost: Post) => {
      const idx = posts.findIndex((p) => p.id === tempId || p.tempId === tempId);
      if (idx !== -1) {
        posts[idx] = serverPost;
      } else if (!posts.some((p) => p.id === serverPost.id)) {
        posts.push(serverPost);
      }

      if (itemsContainerEl) {
        const existingEl = itemsContainerEl.querySelector(`article[data-post-id="${tempId}"]`);
        if (existingEl) {
          const targetIdx = posts.findIndex((p) => p.id === serverPost.id);
          const isGrouped = isPostGroupedAtIndex(targetIdx);
          existingEl.replaceWith(createItem(serverPost, isGrouped));
        }
      }
    },

    markPostFailed: (tempId: string) => {
      const idx = posts.findIndex((p) => p.id === tempId || p.tempId === tempId);
      if (idx !== -1) {
        posts[idx].status = 'failed';
        const failedPost = posts[idx];
        if (itemsContainerEl) {
          const existingEl = itemsContainerEl.querySelector(`article[data-post-id="${tempId}"]`);
          if (existingEl) {
            const isGrouped = isPostGroupedAtIndex(idx);
            existingEl.replaceWith(createItem(failedPost, isGrouped));
          }
        }
      }
    },

    prependPosts: (olderPosts: Post[], prevScrollHeight: number, prevScrollTop: number) => {
      if (olderPosts.length === 0) return;

      const previouslyFirstPost = posts[0];
      const fragment = document.createDocumentFragment();
      let prev: Post | undefined = undefined;
      let lastDateKey = '';

      for (let i = 0; i < olderPosts.length; i++) {
        const post = olderPosts[i];
        const dateKey = getDateKey(post.create_at);
        if (dateKey !== lastDateKey) {
          fragment.appendChild(<DateDivider timestamp={post.create_at} />);
          lastDateKey = dateKey;
          prev = undefined;
        }
        const isGrouped = shouldGroupPosts(prev, post);
        fragment.appendChild(createItem(post, isGrouped));
        prev = post;
      }

      // Check boundary between olderPosts and previouslyFirstPost
      if (previouslyFirstPost && itemsContainerEl) {
        const lastOlderPost = olderPosts[olderPosts.length - 1];
        const prevFirstDateKey = getDateKey(previouslyFirstPost.create_at);

        if (prevFirstDateKey === lastDateKey) {
          const redundantDivider = itemsContainerEl.querySelector(
            `[data-date-divider="${prevFirstDateKey}"]`
          );
          if (redundantDivider) {
            redundantDivider.remove();
          }
          if (shouldGroupPosts(lastOlderPost, previouslyFirstPost)) {
            const existingFirstArticle = itemsContainerEl.querySelector(
              `article[data-post-id="${previouslyFirstPost.id}"]`
            );
            if (existingFirstArticle) {
              existingFirstArticle.replaceWith(createItem(previouslyFirstPost, true));
            }
          }
        }
      }

      pinnedPostId = null;
      stickToBottom = false;
      posts.unshift(...olderPosts);
      if (itemsContainerEl) {
        itemsContainerEl.prepend(fragment);
      }

      if (containerEl) {
        isProgrammaticScroll = true;
        containerEl.scrollTop = containerEl.scrollHeight - prevScrollHeight + prevScrollTop;
        lastScrollTop = containerEl.scrollTop;
        requestAnimationFrame(() => {
          isProgrammaticScroll = false;
        });
      }
    },

    setLoadingOlder: (loading: boolean) => {
      if (loadingSpinnerEl) {
        loadingSpinnerEl.style.display = loading ? 'flex' : 'none';
      }
    },

    setLoadingNewer: (loading: boolean) => {
      if (loadingNewerEl) {
        loadingNewerEl.style.display = loading ? 'flex' : 'none';
      }
    },

    setHasMoreNewer: (hasMore: boolean, label?: string) => {
      if (jumpBannerEl) {
        jumpBannerEl.classList.toggle('flex', hasMore);
        jumpBannerEl.classList.toggle('hidden', !hasMore);
      }
      if (jumpBannerLabelEl && label) {
        jumpBannerLabelEl.textContent = label;
      }
    },

    scrollToBottom,
    scrollToPost: (postId: string, options?: { instant?: boolean }) => {
      if (!containerEl || !itemsContainerEl) return false;
      const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(postId) : postId;
      const targetEl = itemsContainerEl.querySelector<HTMLElement>(
        `article[data-post-id="${escapedId}"]`
      );
      if (!targetEl) return false;

      const useInstant = Boolean(options?.instant);
      stickToBottom = false;
      pinnedPostId = useInstant ? postId : null;
      isProgrammaticScroll = true;
      targetEl.scrollIntoView({ behavior: useInstant ? 'auto' : 'smooth', block: 'center' });
      lastScrollTop = containerEl.scrollTop;

      requestAnimationFrame(() => {
        isProgrammaticScroll = false;
        if (pinnedPostId === postId) {
          centerPinnedPost();
        }
      });

      targetEl.classList.add('ring-1', 'ring-indigo-500/70', 'bg-indigo-500/15');
      setTimeout(() => {
        targetEl.classList.remove('ring-1', 'ring-indigo-500/70', 'bg-indigo-500/15');
      }, 2400);
      return true;
    },
    getScrollContainer: () => containerEl,
    destroy: () => {
      pinnedPostId = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
    },
  };

  handleRef?.(handle);

  return (
    <div class="flex-1 flex flex-col min-h-0 relative">
      <div
        ref={(el) => {
          containerEl = el;
          el?.addEventListener(
            'load',
            () => {
              if (stickToBottom) {
                snapToBottom();
              } else if (pinnedPostId) {
                centerPinnedPost();
              }
            },
            true
          );
          setupObservers();
          scrollRef?.(el);
        }}
        onScroll={handleContainerScroll}
        class="flex-1 overflow-y-auto overflow-x-hidden p-6"
      >
        <div
          ref={(el) => {
            loadingSpinnerEl = el;
          }}
          class={`py-2 items-center justify-center gap-2 text-xs text-zinc-500 ${
            isLoadingOlder ? 'flex' : 'hidden'
          }`}
        >
          <SpinnerIcon class="size-3.5 text-indigo-400" />
          <span>Loading older messages...</span>
        </div>

        {!hasMoreOlderPosts && (
          <div class="text-center py-4 border-b border-dashed border-zinc-800/80 mb-2">
            <span class="text-[11px] text-zinc-500 font-mono tracking-wider uppercase">
              Beginning of message history
            </span>
          </div>
        )}

        <div
          ref={(el) => {
            itemsContainerEl = el;
            setupObservers();
          }}
          class="flex flex-col min-w-0"
        >
          {(() => {
            const elements: HTMLElement[] = [];
            let prev: Post | undefined = undefined;
            let lastDateKey = '';

            for (let i = 0; i < posts.length; i++) {
              const post = posts[i];
              const dateKey = getDateKey(post.create_at);
              if (dateKey !== lastDateKey) {
                elements.push(<DateDivider timestamp={post.create_at} /> as HTMLElement);
                lastDateKey = dateKey;
                prev = undefined;
              }
              const isGrouped = shouldGroupPosts(prev, post);
              elements.push(createItem(post, isGrouped) as HTMLElement);
              prev = post;
            }
            return elements;
          })()}
        </div>

        <div
          ref={(el) => {
            loadingNewerEl = el;
          }}
          class={`py-2 items-center justify-center gap-2 text-xs text-zinc-500 ${
            isLoadingNewer ? 'flex' : 'hidden'
          }`}
        >
          <SpinnerIcon class="size-3.5 text-indigo-400" />
          <span>Loading newer messages...</span>
        </div>
      </div>

      <div
        ref={(el) => {
          jumpBannerEl = el;
        }}
        class={`px-4 py-2 border-t border-indigo-500/20 bg-zinc-900/95 backdrop-blur-xs items-center justify-between gap-3 text-xs shrink-0 ${
          hasMoreNewerPosts ? 'flex' : 'hidden'
        }`}
      >
        <span
          ref={(el) => {
            jumpBannerLabelEl = el;
          }}
          class="text-zinc-300"
        >
          Viewing older messages
        </span>
        <button
          id="jump-to-latest-button"
          type="button"
          onClick={onJumpToLatest}
          class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors cursor-pointer"
        >
          Jump to latest
        </button>
      </div>
    </div>
  );
};
