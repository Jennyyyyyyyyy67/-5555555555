// 社群帳號頁上方：連結真實 Instagram 帳號（Instagram 登入）、立即同步、中斷連結。
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatDateTime, formatRelative } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Card, ConfirmDialog, Select } from '../../components/ui';
import { IconRefresh, PlatformIcon } from '../../components/icons';
import type { InstagramStatus, SyncResult } from '../../../../shared/types';

function CopyField({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div className="ig-copy">
      <span className="muted small">{label}</span>
      <code>{value}</code>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => toast.success('已複製'), () => {});
        }}
      >
        複製
      </Button>
    </div>
  );
}

export function InstagramConnect({ onChanged }: { onChanged: () => void }) {
  const { can } = useAuth();
  const { activeBrands, currentBrand } = useBrandScope();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const status = useQuery(() => api.get<InstagramStatus>('/integrations/instagram'), []);
  const [brandId, setBrandId] = useState<number>(currentBrand?.id ?? activeBrands[0]?.id ?? 0);
  const [syncing, setSyncing] = useState<number | null>(null);
  const [disconnect, setDisconnect] = useState<InstagramStatus['accounts'][number] | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const canManage = can('manageAccounts');
  const [welcome] = useState(() => params.get('welcome') === '1');

  // Instagram 授權完成後帶回的結果
  useEffect(() => {
    const ok = params.get('ig');
    const err = params.get('ig_error');
    if (params.get('welcome')) {
      const next = new URLSearchParams(params);
      next.delete('welcome');
      setParams(next, { replace: true });
    }
    if (!ok && !err) return;
    if (ok === 'connected') {
      setNotice({ tone: 'success', text: `已連結 Instagram 帳號 @${params.get('username') ?? ''}，並匯入 ${params.get('imported') ?? 0} 則現有留言（舊留言不會自動回覆，之後的新留言才會套用自動回覆規則）。` });
      onChanged();
    } else if (err) setNotice({ tone: 'danger', text: err });
    const next = new URLSearchParams(params);
    ['ig', 'ig_error', 'username', 'imported'].forEach((k) => next.delete(k));
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = status.data;
  const sync = async (accountId: number) => {
    setSyncing(accountId);
    try {
      const r = await api.post<SyncResult>(`/integrations/sync/${accountId}`);
      if (r.ok) toast.success(r.message);
      else toast.error(r.message);
      await status.reload();
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSyncing(null);
    }
  };

  return (
    <Card
      title={
        <h2 className="row" style={{ gap: 8 }}>
          <PlatformIcon platform="instagram" size={20} /> 真實 Instagram 帳號
        </h2>
      }
    >
      <div className="stack">
        {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
        {welcome && (
          <Alert tone="success">
            <strong>歡迎加入！</strong>帳號已建立。第一步：按下方「連結 Instagram 帳號」，用你的 Instagram 專業帳號（商家或創作者）登入並允許，系統就會開始幫你整理留言。接著到「自動回覆」設定要自動回覆的關鍵字。
          </Alert>
        )}
        {!s ? (
          <span className="muted small">讀取中…</span>
        ) : !s.configured ? (
          <Alert tone="warning">
            <div className="stack" style={{ gap: 6 }}>
              <strong>尚未設定 Instagram 串接</strong>
              <span>請先在 Meta 開發者後台建立應用程式，並在 Vercel 設定環境變數 INSTAGRAM_APP_ID、INSTAGRAM_APP_SECRET（詳細步驟見專案說明文件「Instagram 串接教學」）。</span>
              <CopyField label="OAuth 重新導向網址（貼到 Meta 後台）" value={s.redirectUri} />
            </div>
          </Alert>
        ) : (
          <>
            {canManage && (
              <div className="row-wrap">
                <span className="small">連結到品牌：</span>
                <Select value={brandId} onChange={(e) => setBrandId(Number(e.target.value))} aria-label="連結到品牌" style={{ width: 'auto' }}>
                  {activeBrands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
                <Button variant="primary" disabled={!brandId} onClick={() => (window.location.href = `/api/integrations/instagram/start?brandId=${brandId}`)}>
                  連結 Instagram 帳號
                </Button>
                <span className="muted small">需使用 Instagram 專業帳號（商業或創作者）登入。</span>
              </div>
            )}
            {s.accounts.length === 0 ? (
              <p className="muted small" style={{ margin: 0 }}>
                還沒有連結任何真實 Instagram 帳號。
              </p>
            ) : (
              <ul className="ig-list">
                {s.accounts.map((a) => (
                  <li key={a.accountId}>
                    <div>
                      <strong>@{a.username}</strong> <span className="muted small">・{a.brandName}</span>{' '}
                      <Badge tone={a.status === 'connected' ? 'green' : a.status === 'error' ? 'red' : 'gray'}>
                        {a.status === 'connected' ? '已連線' : a.status === 'error' ? '同步失敗' : '已中斷'}
                      </Badge>
                      <div className="muted small">
                        上次同步：{a.lastSyncedAt ? formatRelative(a.lastSyncedAt) : '尚未同步'}
                        {a.tokenExpiresAt && `・授權有效至 ${formatDateTime(a.tokenExpiresAt)}（會自動延長）`}
                      </div>
                    </div>
                    <div className="row">
                      <Button size="sm" icon={<IconRefresh />} loading={syncing === a.accountId} onClick={() => void sync(a.accountId)}>
                        立即同步
                      </Button>
                      {canManage && (
                        <Button size="sm" variant="ghost" onClick={() => setDisconnect(a)}>
                          中斷連結
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <details className="ig-help">
              <summary className="small">運作方式與設定網址</summary>
              <ul className="small">
                <li>收件匣開著時，每 45 秒左右會自動向 Instagram 抓新留言；也可以按「立即同步」。</li>
                <li>新留言會套用「自動回覆」頁的規則（例如關鍵字回覆）；客訴、退款、敏感或負面留言一律交給人工。</li>
                <li>設定 Webhook 後，就算沒人開著網頁，有新留言時也會立刻處理。</li>
              </ul>
              <CopyField label="OAuth 重新導向網址" value={s.redirectUri} />
              <CopyField label="Webhook 回呼網址" value={s.webhookUrl} />
              {!s.webhookConfigured && <p className="muted small">尚未設定 INSTAGRAM_WEBHOOK_VERIFY_TOKEN，Webhook 為選用。</p>}
            </details>
          </>
        )}
      </div>
      <ConfirmDialog
        open={!!disconnect}
        title="中斷 Instagram 連結？"
        message={`中斷後系統不會再抓取 @${disconnect?.username ?? ''} 的留言，也無法回覆；已匯入的留言與紀錄會保留。之後可以重新連結。`}
        confirmText="中斷連結"
        danger
        onCancel={() => setDisconnect(null)}
        onConfirm={async () => {
          if (!disconnect) return;
          try {
            await api.post(`/integrations/instagram/${disconnect.accountId}/disconnect`);
            toast.success('已中斷連結');
            setDisconnect(null);
            await status.reload();
            onChanged();
          } catch (err) {
            toast.error(errorMessage(err));
          }
        }}
      />
    </Card>
  );
}
