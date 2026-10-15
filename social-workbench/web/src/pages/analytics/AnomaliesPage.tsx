// 異常事件：AI 從大量留言中整理出值得注意的情況（負面增加、產品問題、湧入留言、低星評論、重複詢問、話題、商機、熱烈討論）。
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useBrandScope } from '../../brand/BrandScope';
import { api, errorMessage } from '../../lib/api';
import { useQuery } from '../../lib/useQuery';
import { formatShortDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Badge, Button, Card, EmptyState, ErrorMessage, Field, Loading, Modal, PageHeader, Textarea } from '../../components/ui';
import { IconRefresh } from '../../components/icons';
import type { AnomaliesResponse, AnomalyEvent } from '../../../../shared/types';
import './analytics.css';

const SEVERITY: Record<AnomalyEvent['severity'], { label: string; tone: 'red' | 'orange' | 'gray' }> = {
  high: { label: '重要', tone: 'red' },
  medium: { label: '注意', tone: 'orange' },
  low: { label: '參考', tone: 'gray' },
};

export default function AnomaliesPage() {
  const { brandParam } = useBrandScope();
  const q = useQuery(() => api.get<AnomaliesResponse>('/analytics/anomalies', { brand: brandParam }), [brandParam]);
  const [showDone, setShowDone] = useState(false);
  const [acking, setAcking] = useState<AnomalyEvent | null>(null);
  const events = q.data?.events ?? [];
  const open = events.filter((e) => !e.ack);
  const done = events.filter((e) => e.ack);
  const list = showDone ? done : open;

  return (
    <>
      <PageHeader
        title="異常事件"
        description="系統持續比對最近 24～48 小時與前 7 天的留言，自動整理出值得注意的情況，不需要從大量留言中自己找。處理後可標記「已處理」並留下說明。"
        actions={
          <Button icon={<IconRefresh />} onClick={() => void q.reload()} loading={q.loading && !!q.data}>
            重新偵測
          </Button>
        }
      />
      <div className="am-tabs" role="tablist">
        <button role="tab" aria-selected={!showDone} className={`am-tab ${!showDone ? 'active' : ''}`} onClick={() => setShowDone(false)}>
          待注意（{open.length}）
        </button>
        <button role="tab" aria-selected={showDone} className={`am-tab ${showDone ? 'active' : ''}`} onClick={() => setShowDone(true)}>
          已處理（{done.length}）
        </button>
      </div>
      {q.loading && !q.data ? (
        <Loading />
      ) : q.error ? (
        <ErrorMessage error={q.error} onRetry={() => void q.reload()} />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState title={showDone ? '沒有已處理的事件' : '目前沒有異常事件'} description={showDone ? undefined : '社群狀況平穩。有負面留言增加、某篇內容湧入大量留言等情況時，會出現在這裡。'} />
        </Card>
      ) : (
        <ul className="an-events">
          {list.map((e) => (
            <li key={e.key} className={`an-event sev-${e.severity}`}>
              <div className="an-event-head">
                <Badge tone={SEVERITY[e.severity].tone}>{SEVERITY[e.severity].label}</Badge>
                <Badge>{e.typeLabel}</Badge>
                <span className="muted small">{e.brandName}</span>
              </div>
              <h3>{e.title}</h3>
              <p className="small">{e.description}</p>
              {e.examples.length > 0 && (
                <ul className="an-examples small">
                  {e.examples.map((x) => (
                    <li key={x.commentId}>
                      <Link to={`/inbox/${x.commentId}`}>
                        <strong>{x.authorName}</strong>：{x.body}
                      </Link>
                      <span className="muted">　{formatShortDateTime(x.occurredAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="row-wrap">
                <Link className="btn btn-secondary btn-sm" to={e.link}>
                  查看相關留言
                </Link>
                {!e.ack && (
                  <Button size="sm" variant="ghost" onClick={() => setAcking(e)}>
                    標記已處理
                  </Button>
                )}
                {e.ack && (
                  <span className="small muted">
                    ✓ {e.ack.userName} 於 {formatShortDateTime(e.ack.createdAt)} 標記已處理{e.ack.note ? `：${e.ack.note}` : ''}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {acking && <AckModal event={acking} onClose={() => setAcking(null)} onDone={() => { setAcking(null); void q.reload(); }} />}
    </>
  );
}

function AckModal({ event, onClose, onDone }: { event: AnomalyEvent; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/analytics/anomalies/ack', { key: event.key, brandId: event.brandId, title: event.title, type: event.type, note: note.trim() || undefined });
      toast.success('已標記為已處理');
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title="標記已處理"
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            標記已處理
          </Button>
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0 }}>{event.title}</p>
        <Field label="處理說明（選填）" hint="會記錄在操作紀錄，例如「已通知品管」「已發布說明貼文」。">
          <Textarea rows={3} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
