import type { FileAttachment, Post, User } from '../types';
import { UserAvatar } from './avatar';
import { AlertCircleIcon, ClockIcon, PaperclipIcon, ReplyIcon, TrashIcon } from './icons';

interface MessageItemProps {
  post: Post;
  author: User | undefined;
  isMe: boolean;
  isGrouped?: boolean;
  postsMap?: Map<string, Post>;
  usersMap?: Map<string, User>;
  onRetry?: (post: Post) => void;
  onDelete?: (post: Post) => void;
  onReply?: (post: Post) => void;
  onJumpToRoot?: (rootId: string) => void;
}

const timeFormatter = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });
const dateFormatter = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });

const INLINE_TOKEN_REGEX = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s]+)/g;
const CODE_BLOCK_REGEX = /(```[\s\S]*?```)/g;
const TRIM_NEWLINES_REGEX = /^\n+|\n+$/g;

const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = timeFormatter.format(date);
  return isToday ? `Today at ${time}` : `${dateFormatter.format(date)} at ${time}`;
};

const parseInlineElements = (text: string) => {
  const tokens = text.split(INLINE_TOKEN_REGEX);
  return tokens.map((token, idx) => {
    if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
      return (
        <code key={idx} class="px-1.5 py-0.5 bg-zinc-800 rounded text-xs font-mono text-indigo-300">
          {token.slice(1, -1)}
        </code>
      );
    }
    if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
      return (
        <strong key={idx} class="font-semibold text-zinc-100">
          {token.slice(2, -2)}
        </strong>
      );
    }
    if (token.startsWith('http://') || token.startsWith('https://')) {
      return (
        <a key={idx} href={token} target="_blank" rel="noopener noreferrer" class="text-indigo-400 hover:underline break-all">
          {token}
        </a>
      );
    }
    return token;
  });
};

const renderFormattedText = (text: string) => {
  if (!text) return null;
  const blocks = text.split(CODE_BLOCK_REGEX);
  return blocks.map((block, i) => {
    if (block.startsWith('```') && block.endsWith('```')) {
      const code = block.slice(3, -3).replace(TRIM_NEWLINES_REGEX, '');
      return (
        <pre key={i} class="p-3 bg-zinc-950/80 border border-zinc-800/80 rounded-lg text-xs font-mono my-2 overflow-x-auto max-w-full text-zinc-300">
          <code>{code}</code>
        </pre>
      );
    }
    return <span key={i} class="whitespace-pre-wrap">{parseInlineElements(block)}</span>;
  });
};

const extractMessageText = (post: Post): string => {
  if (post.message) return post.message;
  if (post.props?.attachments && post.props.attachments.length > 0) {
    return post.props.attachments
      .map((a) => [a.title, a.text || a.fallback || a.pretext].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
};

const MAX_IMAGE_WIDTH = 320;
const MAX_IMAGE_HEIGHT = 224;

const getImageDisplaySize = (width?: number, height?: number) => {
  if (!width || !height || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, MAX_IMAGE_WIDTH / width, MAX_IMAGE_HEIGHT / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const renderAttachments = (files: FileAttachment[]) => {
  return (
    <div class="mt-2.5 flex flex-wrap gap-2 max-w-full">
      {files.map((file) => {
        const fileUrl = file.preview_url || `/api/files/${file.id}`;
        const previewUrl = file.preview_url || `/api/files/${file.id}/preview`;

        if (file.mime_type?.startsWith('image/')) {
          const displaySize = getImageDisplaySize(file.width, file.height);
          return (
            <a
              key={file.id}
              href={fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="max-w-xs max-h-56 rounded-lg overflow-hidden border border-zinc-800 bg-black cursor-pointer hover:border-indigo-500/50 transition-colors block"
            >
              <img
                src={previewUrl}
                alt={file.name}
                width={displaySize?.width}
                height={displaySize?.height}
                loading="lazy"
                class="block max-w-full max-h-56 h-auto object-cover"
              />
            </a>
          );
        }
        return (
          <a
            key={file.id}
            href={fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center gap-2 px-3 py-2 bg-zinc-950/80 border border-zinc-800 rounded-lg text-xs hover:border-zinc-700 transition-colors"
          >
            <PaperclipIcon class="size-4 text-zinc-400 shrink-0" />
            <span class="text-zinc-200 truncate max-w-xs font-mono">{file.name}</span>
          </a>
        );
      })}
    </div>
  );
};

const getReplyPreviewText = (post: Post): string => {
  const text = extractMessageText(post).trim().replace(/\s+/g, ' ');
  if (text) return text;
  const fileCount = post.metadata?.files?.length || post.file_ids?.length || 0;
  if (fileCount > 0) {
    return `${fileCount} ${fileCount === 1 ? 'attachment' : 'attachments'}`;
  }
  return '(empty message)';
};

const renderReplyReference = (
  rootId: string,
  postsMap?: Map<string, Post>,
  usersMap?: Map<string, User>,
  onJumpToRoot?: (rootId: string) => void
) => {
  const parentPost = postsMap?.get(rootId);
  const parentAuthor = parentPost ? usersMap?.get(parentPost.user_id) : undefined;
  const parentAuthorName = parentPost
    ? parentPost.props?.override_username ||
      parentAuthor?.display_name ||
      parentAuthor?.username ||
      'user'
    : null;
  const snippet = parentPost ? getReplyPreviewText(parentPost) : 'Original message unavailable';

  return (
    <button
      type="button"
      data-reply-quote={rootId}
      onClick={(e) => {
        e.stopPropagation();
        onJumpToRoot?.(rootId);
      }}
      class="max-w-full flex items-center gap-1.5 text-left px-2.5 py-1 mb-1.5 rounded-r-lg border-l-2 border-indigo-500/70 bg-zinc-900/80 hover:bg-zinc-800/70 transition-colors text-[11px] min-w-0 cursor-pointer"
      title={parentAuthorName ? `Jump to ${parentAuthorName}'s message` : 'Jump to original message'}
    >
      <ReplyIcon class="size-3 text-indigo-400 shrink-0" />
      {parentAuthorName && (
        <span class="font-semibold text-indigo-300 shrink-0">{parentAuthorName}</span>
      )}
      <span class="text-zinc-400 truncate min-w-0">{snippet}</span>
    </button>
  );
};

const renderActionToolbar = ({
  post,
  canReply,
  canDelete,
  onReply,
  onDelete,
}: {
  post: Post;
  canReply: boolean;
  canDelete: boolean;
  onReply?: (post: Post) => void;
  onDelete?: (post: Post) => void;
}) => {
  const showReply = canReply && Boolean(onReply);
  const showDelete = canDelete && Boolean(onDelete);
  if (!showReply && !showDelete) return null;

  return (
    <div class="absolute right-2 -top-2.5 z-10 flex items-center gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/95 p-0.5 shadow-sm opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity">
      {showReply && onReply && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onReply(post);
          }}
          class="size-6 rounded-md flex items-center justify-center text-zinc-400 hover:text-indigo-400 hover:bg-indigo-500/15 transition-colors cursor-pointer"
          title="Reply to message"
          aria-label="Reply to message"
        >
          <ReplyIcon class="size-3.5" />
        </button>
      )}
      {showDelete && onDelete && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(post);
          }}
          class="size-6 rounded-md flex items-center justify-center text-zinc-400 hover:text-rose-400 hover:bg-rose-500/15 transition-colors cursor-pointer"
          title="Delete message"
          aria-label="Delete message"
        >
          <TrashIcon class="size-3.5" />
        </button>
      )}
    </div>
  );
};

export const MessageItem = ({
  post,
  author,
  isMe,
  isGrouped = false,
  postsMap,
  usersMap,
  onRetry,
  onDelete,
  onReply,
  onJumpToRoot,
}: MessageItemProps) => {
  const authorName =
    post.props?.override_username ||
    author?.display_name ||
    author?.username ||
    'user';
  const initial = authorName.charAt(0).toUpperCase();
  const dateStr = formatTimestamp(post.create_at);
  const gutterTime = timeFormatter.format(new Date(post.create_at));
  const files: FileAttachment[] =
    post.metadata?.files && post.metadata.files.length > 0
      ? post.metadata.files
      : (post.file_ids || []).map((id) => ({
          id,
          name: 'Attachment',
          extension: '',
          size: 0,
          mime_type: 'image/jpeg',
        }));
  const isSending = post.status === 'sending';
  const isFailed = post.status === 'failed';
  const isSystem = Boolean(post.type?.startsWith('system_'));
  const canReply = !isSending && !isFailed && !post.id.startsWith('temp_') && !isSystem;
  const canDelete = (isMe || isFailed) && !isSending && !isSystem;
  const messageText = extractMessageText(post);
  const replyRootId = post.root_id && post.root_id !== post.id ? post.root_id : '';
  const toolbar = renderActionToolbar({ post, canReply, canDelete, onReply, onDelete });

  if (isGrouped) {
    const containerClasses = [
      'relative flex gap-3 items-start min-w-0 max-w-full px-2 py-0.5 -mx-2 rounded-lg transition-all group mt-0.5',
      isSending ? 'opacity-70' : 'hover:bg-zinc-800/30',
      isFailed ? 'border-l-2 border-rose-500 pl-2 bg-rose-500/5' : '',
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <article data-post-id={post.id} class={containerClasses}>
        {toolbar}
        <div class="w-9 shrink-0 flex items-center justify-end pr-1 select-none pt-0.5 min-h-4">
          {isSending ? (
            <ClockIcon class="size-3.5 animate-pulse text-indigo-400" />
          ) : isFailed ? (
            <AlertCircleIcon class="size-3.5 text-rose-400" />
          ) : (
            <span
              class="opacity-0 group-hover:opacity-100 text-[10px] text-zinc-500 font-mono transition-opacity select-none leading-none tabular-nums"
              title={dateStr}
            >
              {gutterTime}
            </span>
          )}
        </div>

        <div class="grow min-w-0 max-w-full">
          {isSending && (
            <div class="inline-flex items-center gap-1 text-[10px] text-indigo-400 font-mono mb-0.5">
              <span>Sending...</span>
            </div>
          )}
          {isFailed && (
            <div class="inline-flex items-center gap-1 text-[10px] text-rose-400 font-medium mb-0.5">
              <AlertCircleIcon class="size-3" />
              <span>Failed to send</span>
              <button
                type="button"
                onClick={() => onRetry?.(post)}
                class="text-indigo-400 hover:text-indigo-300 underline font-semibold ml-1 cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {messageText && (
            <div class="text-xs text-zinc-200 leading-relaxed wrap-break-word">
              {renderFormattedText(messageText)}
            </div>
          )}

          {files.length > 0 && renderAttachments(files)}
        </div>
      </article>
    );
  }

  const containerClasses = [
    'relative flex gap-3 items-start min-w-0 max-w-full px-2 py-1 -mx-2 rounded-lg transition-all group mt-3.5 first:mt-0',
    isSending ? 'opacity-70' : 'hover:bg-zinc-800/30',
    isFailed ? 'border-l-2 border-rose-500 pl-2 bg-rose-500/5' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article data-post-id={post.id} class={containerClasses}>
      {toolbar}
      <UserAvatar
        userId={post.user_id}
        name={authorName}
        avatarUrl={post.props?.override_icon_url}
        sizeClass="size-9"
        textClass="text-xs"
        lastPictureUpdate={author?.last_picture_update}
        status={author?.status || (isMe ? 'online' : 'offline')}
        showStatus={true}
      />

      <div class="grow min-w-0 max-w-full">
        <header class="flex items-baseline gap-2 mb-1 flex-wrap">
          <span class={`text-xs font-semibold ${isMe ? 'text-indigo-400' : 'text-zinc-100'}`}>
            {authorName}
          </span>
          {isSending ? (
            <span class="inline-flex items-center gap-1 text-[10px] text-zinc-400 font-mono">
              <ClockIcon class="size-3 animate-pulse text-indigo-400" />
              <span>Sending...</span>
            </span>
          ) : isFailed ? (
            <span class="inline-flex items-center gap-1 text-[10px] text-rose-400 font-medium">
              <AlertCircleIcon class="size-3" />
              <span>Failed to send</span>
              <button
                type="button"
                onClick={() => onRetry?.(post)}
                class="text-indigo-400 hover:text-indigo-300 underline font-semibold ml-1 cursor-pointer"
              >
                Retry
              </button>
            </span>
          ) : (
            <time class="text-[10px] text-zinc-500 font-mono">{dateStr}</time>
          )}
        </header>

        {replyRootId && renderReplyReference(replyRootId, postsMap, usersMap, onJumpToRoot)}

        {messageText && (
          <div class="text-xs text-zinc-200 leading-relaxed wrap-break-word">
            {renderFormattedText(messageText)}
          </div>
        )}

        {files.length > 0 && renderAttachments(files)}
      </div>
    </article>
  );
};
