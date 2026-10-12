// 頂部通知鈴：@提及、指派、轉交、被接手
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { formatRelative } from '../lib/format';
import { Dropdown } from '../components/ui';
import type { NotificationsResponse } from '../../../shared/types';

const BellIcon = () => (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

export function NotificationBell() {
  const navigate = useNavigate();
  const [data, setData] = useState<NotificationsResponse | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get<NotificationsResponse>('/notifications'));
    } catch {
      /* 通知失敗不影響主畫面 */
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const unread = data?.unread ?? 0;
  return (
    <Dropdown
      trigger={({ toggle, open }) => (
        <button
          className="btn btn-ghost btn-icon bell"
          onClick={() => {
            if (!open) void load();
            toggle();
          }}
          aria-label={unread ? `通知（${unread} 則未讀）` : '通知'}
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <BellIcon />
          {unread > 0 && <span className="bell-badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="bell-menu">
          <div className="bell-head">
            <strong>通知</strong>
            {unread > 0 && (
              <button
                className="link-btn"
                onClick={async () => {
                  await api.post('/notifications/read').catch(() => {});
                  void load();
                }}
              >
                全部標為已讀
              </button>
            )}
          </div>
          {!data || data.items.length === 0 ? (
            <p className="muted small" style={{ padding: '8px 12px' }}>
              目前沒有通知。被指派、轉交或在備註中被 @ 時會通知你。
            </p>
          ) : (
            <ul>
              {data.items.map((n) => (
                <li key={n.id}>
                  <button
                    className={`bell-item ${n.isRead ? '' : 'unread'}`}
                    onClick={async () => {
                      close();
                      if (!n.isRead) await api.post('/notifications/read', { ids: [n.id] }).catch(() => {});
                      void load();
                      if (n.commentId) navigate(`/inbox/${n.commentId}?tab=all`);
                    }}
                  >
                    <span>{n.message}</span>
                    <span className="muted small">{formatRelative(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dropdown>
  );
}
