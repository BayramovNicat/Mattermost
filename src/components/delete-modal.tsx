import type { Post } from '../types';
import { SpinnerIcon, TrashIcon, XIcon } from './icons';

interface DeleteModalProps {
  post: Post;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

const getPreviewText = (post: Post): string => {
  if (post.message?.trim()) {
    return post.message.trim();
  }
  if (post.props?.attachments && post.props.attachments.length > 0) {
    const text = post.props.attachments
      .map((a) => [a.title, a.text || a.fallback || a.pretext].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  const fileCount = post.metadata?.files?.length || post.file_ids?.length || 0;
  if (fileCount > 0) {
    return `${fileCount} ${fileCount === 1 ? 'attachment' : 'attachments'}`;
  }
  return '(empty message)';
};

export const DeleteModal = ({ post, onConfirm, onClose }: DeleteModalProps) => {
  let isDeleting = false;

  const errorEl = (
    <p class="hidden text-xs text-rose-400 bg-rose-500/10 border border-rose-500/25 rounded-lg px-3 py-2" />
  ) as HTMLParagraphElement;
  const cancelBtn = (
    <button
      id="delete-modal-cancel-button"
      type="button"
      class="px-3.5 py-1.5 rounded-lg text-xs font-medium bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition-colors cursor-pointer disabled:opacity-50"
    >
      Cancel
    </button>
  ) as HTMLButtonElement;
  const closeBtn = (
    <button
      id="delete-modal-close-button"
      type="button"
      aria-label="Close delete dialog"
      class="size-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer disabled:opacity-50"
    >
      <XIcon class="size-4" />
    </button>
  ) as HTMLButtonElement;
  const confirmBtn = (
    <button
      id="delete-modal-confirm-button"
      type="button"
      class="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer disabled:opacity-60"
    >
      <span>Delete</span>
    </button>
  ) as HTMLButtonElement;

  const setDeletingState = (deleting: boolean) => {
    isDeleting = deleting;
    cancelBtn.disabled = deleting;
    closeBtn.disabled = deleting;
    confirmBtn.disabled = deleting;
    if (deleting) {
      confirmBtn.replaceChildren(
        <SpinnerIcon class="size-3.5 text-white" />,
        <span>Deleting...</span>
      );
    } else {
      confirmBtn.replaceChildren(<span>Delete</span>);
    }
  };

  const cleanup = () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', handleKeyDown);
    }
  };

  const close = () => {
    if (isDeleting) return;
    cleanup();
    onClose();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
    }
  };

  const handleConfirm = async () => {
    if (isDeleting) return;
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
    setDeletingState(true);

    try {
      await onConfirm();
      cleanup();
    } catch (err: unknown) {
      setDeletingState(false);
      errorEl.textContent = err instanceof Error ? err.message : 'Failed to delete message';
      errorEl.classList.remove('hidden');
    }
  };

  cancelBtn.addEventListener('click', close);
  closeBtn.addEventListener('click', close);
  confirmBtn.addEventListener('click', handleConfirm);

  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeyDown);
    requestAnimationFrame(() => {
      cancelBtn.focus();
    });
  }

  return (
    <div
      id="delete-message-modal"
      class="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          close();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-modal-title"
        class="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden"
      >
        <header class="px-5 py-4 border-b border-zinc-800/80 flex items-center justify-between gap-3">
          <div class="flex items-center gap-2.5 min-w-0">
            <div class="size-8 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400 shrink-0">
              <TrashIcon class="size-4" />
            </div>
            <h3 id="delete-modal-title" class="text-sm font-bold text-zinc-100">
              Delete Message
            </h3>
          </div>
          {closeBtn}
        </header>

        <div class="p-5 space-y-3">
          <p class="text-xs text-zinc-300 leading-relaxed">
            Are you sure you want to delete this message? This action cannot be undone.
          </p>

          <div class="p-3 rounded-xl border border-zinc-800 bg-zinc-950/70 text-xs text-zinc-300 line-clamp-4 wrap-break-word whitespace-pre-wrap">
            {getPreviewText(post)}
          </div>

          {errorEl}
        </div>

        <footer class="px-5 py-3.5 border-t border-zinc-800/80 bg-zinc-900/60 flex items-center justify-end gap-2">
          {cancelBtn}
          {confirmBtn}
        </footer>
      </div>
    </div>
  );
};
