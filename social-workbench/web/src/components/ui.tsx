// 共用 UI 元件。頁面請優先使用這些元件，維持一致的外觀與行為。
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../lib/api';
import { IconX } from './icons';
import type { CommentStatus, Priority } from '../../../shared/constants';

// ---------- 按鈕 ----------
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
  /** 只有圖示的方形按鈕（記得提供 aria-label） */
  iconOnly?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, iconOnly, className = '', children, disabled, type = 'button', ...rest },
  ref,
) {
  const cls = ['btn', `btn-${variant}`, size === 'sm' ? 'btn-sm' : '', iconOnly ? 'btn-icon' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button ref={ref} type={type} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
    </button>
  );
});

// ---------- 標籤 ----------
export type BadgeTone = 'gray' | 'blue' | 'green' | 'orange' | 'red' | 'purple' | 'teal' | 'solid-red' | 'solid-orange';
/** 留言處理狀態與優先順序的標籤顏色（各頁面共用，維持一致） */
export const STATUS_TONE: Record<CommentStatus, BadgeTone> = {
  pending: 'blue',
  in_progress: 'purple',
  waiting: 'teal',
  transferred: 'orange',
  no_action: 'gray',
  done: 'green',
};
export const PRIORITY_TONE: Record<Priority, BadgeTone> = { high: 'red', medium: 'orange', low: 'gray' };

export function Badge({ tone = 'gray', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone === 'gray' ? '' : `badge-${tone}`}`} title={title}>
      {children}
    </span>
  );
}

// ---------- 版面 ----------
export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="desc">{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  bodyClassName = 'card-body',
  className = '',
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          {typeof title === 'string' ? <h2>{title}</h2> : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Loading({ text = '載入中…' }: { text?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden />
      {text}
    </div>
  );
}

export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="alert alert-danger" role="alert">
      <div style={{ flex: 1 }}>{errorMessage(error)}</div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          重試
        </Button>
      )}
    </div>
  );
}

export function Alert({ tone = 'info', children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; children: ReactNode }) {
  return (
    <div className={`alert alert-${tone}`} role={tone === 'danger' ? 'alert' : undefined}>
      <div>{children}</div>
    </div>
  );
}

// ---------- 表單 ----------
export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {required && <span className="req">*</span>}
      </label>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  function TextInput({ className = '', invalid, ...rest }, ref) {
    return <input ref={ref} className={`input ${className}`} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }>(
  function Select({ className = '', invalid, children, ...rest }, ref) {
    return (
      <select ref={ref} className={`select ${className}`} aria-invalid={invalid || undefined} {...rest}>
        {children}
      </select>
    );
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }>(
  function Textarea({ className = '', invalid, ...rest }, ref) {
    return <textarea ref={ref} className={`textarea ${className}`} aria-invalid={invalid || undefined} {...rest} />;
  },
);

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Switch({
  label,
  checked,
  onChange,
  disabled,
}: {
  label?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" aria-hidden />
      {label && <span>{label}</span>}
    </label>
  );
}

// ---------- 對話框 ----------
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  closeOnBackdrop?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const focusable = node?.querySelector<HTMLElement>('input, select, textarea, button:not([data-close])');
    (focusable ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
      if (e.key === 'Tab' && node) {
        const items = [...node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="ghost" size="sm" iconOnly aria-label="關閉" data-close onClick={onClose} icon={<IconX />} />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 確認對話框。高風險動作（刪除、封鎖、停用等）一律使用；requireReason 時必須填寫理由才能確認。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '確認',
  cancelText = '取消',
  danger,
  requireReason,
  reasonLabel = '理由',
  reasonPlaceholder = '請說明原因（會記錄在操作紀錄中）',
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const canConfirm = !requireReason || reason.trim().length > 0;
  return (
    <Modal
      open={open}
      title={title}
      onClose={busy ? () => {} : onCancel}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelText}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={() => onConfirm(reason.trim())} disabled={!canConfirm} loading={busy}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div>{message}</div>
        {requireReason && (
          <Field label={reasonLabel} required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonPlaceholder} rows={3} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---------- 下拉選單 ----------
export function Dropdown({
  trigger,
  children,
  align = 'right',
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div className="menu" role="menu" style={align === 'left' ? { left: 0, right: 'auto' } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ---------- 人員頭像 ----------
const AVATAR_COLORS = ['#3355d6', '#7b4fe0', '#0e7490', '#b45309', '#15803d', '#be185d', '#4b5563'];
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  const code = [...name].reduce((s, ch) => s + ch.codePointAt(0)!, 0);
  const initial = [...name].slice(-2).join('');
  return (
    <span className={`avatar ${size === 'sm' ? 'avatar-sm' : ''}`} style={{ background: AVATAR_COLORS[code % AVATAR_COLORS.length] }} aria-hidden>
      {size === 'sm' ? [...name].slice(-1).join('') : initial}
    </span>
  );
}
