import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { api, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { useMeta } from '../../lib/meta';
import { formatDateTime, formatNumber, formatRelative, formatShortDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorMessage,
  Loading,
  PageHeader,
  type BadgeTone,
} from '../../components/ui';
import { BrandTag, IconRefresh, PlatformIcon } from '../../components/icons';
import { ACTOR_TYPE_LABELS, COMMENT_STATUSES, STATUS_LABELS } from '../../../../shared/constants';
import type { AuditLogEntry, MeResponse, MockStatsResponse } from '../../../../shared/types';
import './mock.css';

/** POST /api/mock/reset 的回應；me 為 null 代表目前帳號不在新的示範資料中，已被登出 */
interface MockResetResponse {
  summary: Record<string, number>;
  me: MeResponse | null;
}

/** 示範留言的時間以建立當下推算，超過這個時間就建議重設 */
const STALE_AFTER_MS = 3 * 60 * 60_000;
const RECENT_LIMIT = 20;

const STAT_ITEMS: Array<{ key: keyof MockStatsResponse['totals']; label: string }> = [
  { key: 'brands', label: '品牌' },
  { key: 'users', label: '人員' },
  { key: 'accounts', label: '社群帳號' },
  { key: 'posts', label: '貼文' },
  { key: 'comments', label: '留言' },
  { key: 'replies', label: '品牌回覆' },
  { key: 'auditLogs', label: '操作紀錄' },
];

const ACTOR_TONE: Record<AuditLogEntry['actorType'], BadgeTone> = { user: 'gray', ai: 'purple', rule: 'teal', system: 'gray' };

function ActorCell({ entry }: { entry: AuditLogEntry }) {
  if (entry.actorType === 'user') return <span className="nowrap">{entry.actorName ?? '（人員資料已不存在）'}</span>;
  return <Badge tone={ACTOR_TONE[entry.actorType]}>{ACTOR_TYPE_LABELS[entry.actorType]}</Badge>;
}

export default function MockDataPage() {
  const { applyMe, logout } = useAuth();
  const { reload: reloadMeta } = useMeta();
  const toast = useToast();
  const navigate = useNavigate();
  const stats = useQuery(() => api.get<MockStatsResponse>('/mock/stats'), []);
  const recent = useQuery(() => api.get<AuditLogEntry[]>('/audit/recent', { limit: RECENT_LIMIT }), []);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const doReset = async () => {
    setResetting(true);
    try {
      const res = await api.post<MockResetResponse>('/mock/reset', { confirm: true });
      setConfirmOpen(false);
      if (res.me) {
        applyMe(res.me);
        toast.success('示範資料已重設');
        void stats.reload();
        void recent.reload();
        void reloadMeta();
      } else {
        toast.info('示範資料已重設。你的帳號不在示範資料中，請改用示範帳號登入');
        await logout();
        navigate('/login', { replace: true });
      }
    } catch (err) {
      toast.error(`重設失敗：${errorMessage(err)}`);
    } finally {
      setResetting(false);
    }
  };

  const data = stats.data;
  const seededAt = data?.seededAt ?? null;
  const isStale = seededAt !== null && Date.now() - Date.parse(seededAt) > STALE_AFTER_MS;

  return (
    <div className="mock-page">
      <PageHeader
        title="模擬資料"
        description="第一版以模擬留言跑通完整流程。平台串接設計為可替換的 adapter，日後接上真實 API 即可取代模擬資料。"
        actions={
          <Button variant="danger" icon={<IconRefresh />} onClick={() => setConfirmOpen(true)} disabled={resetting}>
            重設示範資料
          </Button>
        }
      />

      {stats.error && !data ? (
        <ErrorMessage error={stats.error} onRetry={stats.reload} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          {isStale && (
            <Alert tone="warning">
              示範留言的時間是以建立當下計算的，現在多數留言可能已超時。建議重設示範資料，讓留言時間回到「剛剛發生」。
            </Alert>
          )}

          <div className="mock-stats">
            {STAT_ITEMS.map((s) => (
              <div key={s.key} className="card stat">
                <div className="label">{s.label}</div>
                <div className="value">{formatNumber(data.totals[s.key])}</div>
              </div>
            ))}
          </div>

          <p className="mock-seeded">
            <span className="muted">資料建立時間：</span>
            {seededAt ? (
              <>
                {formatDateTime(seededAt)}
                <span className="muted">（{formatRelative(seededAt)}）</span>
              </>
            ) : (
              <span className="muted">未記錄（目前的資料不是由示範資料建立）</span>
            )}
          </p>

          <Card title="各品牌資料量" bodyClassName="">
            {data.byBrand.length === 0 ? (
              <EmptyState title="目前沒有任何品牌" description="重設示範資料後會重新建立示範品牌。" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>品牌</th>
                      <th className="num">帳號</th>
                      <th className="num">貼文</th>
                      <th className="num">留言</th>
                      <th>各平台留言</th>
                      <th>各狀態</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byBrand.map((b) => {
                      const platforms = Object.entries(b.byPlatform);
                      const statuses = COMMENT_STATUSES.filter((s) => (b.byStatus[s] ?? 0) > 0);
                      return (
                        <tr key={b.brandId}>
                          <td>
                            <BrandTag name={b.brandName} color={b.brandColor} />
                          </td>
                          <td className="num">{formatNumber(b.accounts)}</td>
                          <td className="num">{formatNumber(b.posts)}</td>
                          <td className="num">{formatNumber(b.comments)}</td>
                          <td>
                            {platforms.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              <span className="mock-chips">
                                {platforms.map(([platform, n]) => (
                                  <Badge key={platform}>
                                    <PlatformIcon platform={platform} size={14} />
                                    {formatNumber(n)}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </td>
                          <td>
                            {statuses.length === 0 ? (
                              <span className="muted">—</span>
                            ) : (
                              <span className="mock-chips">
                                {statuses.map((s) => (
                                  <Badge key={s}>
                                    {STATUS_LABELS[s]} {formatNumber(b.byStatus[s] ?? 0)}
                                  </Badge>
                                ))}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      <Card title="最近操作紀錄" bodyClassName="">
        {recent.error && !recent.data ? (
          <div className="card-body">
            <ErrorMessage error={recent.error} onRetry={recent.reload} />
          </div>
        ) : !recent.data ? (
          <Loading />
        ) : recent.data.length === 0 ? (
          <EmptyState title="還沒有操作紀錄" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>時間</th>
                  <th>執行者</th>
                  <th>品牌</th>
                  <th>內容</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.map((e) => (
                  <tr key={e.id}>
                    <td className="nowrap" title={formatDateTime(e.createdAt)}>
                      {formatShortDateTime(e.createdAt)}
                    </td>
                    <td>
                      <ActorCell entry={e} />
                    </td>
                    <td className="nowrap">{e.brandName ?? <span className="muted">—</span>}</td>
                    <td className="mock-summary">{e.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small mock-note">這裡只列出最近 {RECENT_LIMIT} 筆，完整的操作紀錄頁將在階段 5 提供。</p>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        danger
        title="重設示範資料"
        confirmText="重設示範資料"
        busy={resetting}
        message={
          <div className="stack">
            <p>會清空所有資料（留言、回覆、人員、設定、操作紀錄）並重新建立示範資料，這個動作無法復原。</p>
            <p className="muted">目前登入的帳號若仍存在於示範資料中會保持登入；否則會回到登入頁，請改用示範帳號登入。</p>
          </div>
        }
        onConfirm={() => void doReset()}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
