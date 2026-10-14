// 回覆區：AI 多版本建議（引用知識庫、標示知識不足）、送出前檢查、需要確認的提醒。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { formatShortDateTime } from '../../lib/format';
import { useToast } from '../../components/Toast';
import { Alert, Badge, Button, Modal, Textarea } from '../../components/ui';
import { KNOWLEDGE_CATEGORY_LABELS } from '../../../../shared/constants';
import type { CommentDetail, ReplyCheckResult, ReplyInput, ReplyWarning, SuggestionSet, SuggestionsResponse, SuggestionVariant } from '../../../../shared/types';

interface Props {
  commentId: number;
  disabled: boolean;
  lockMine: boolean;
  onFocusStart: () => void;
  onSent: (d: CommentDetail, message: string) => void;
}

export function ReplyComposer({ commentId, disabled, lockMine, onFocusStart, onSent }: Props) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [picked, setPicked] = useState<SuggestionVariant | null>(null);
  const [set, setSet] = useState<SuggestionSet | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);
  const [warnings, setWarnings] = useState<ReplyWarning[]>([]);
  const [confirm, setConfirm] = useState<{ statusAfter: ReplyInput['statusAfter']; warnings: ReplyWarning[] } | null>(null);
  const [openHit, setOpenHit] = useState<number | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  // 載入之前產生過的建議
  useEffect(() => {
    let alive = true;
    api
      .get<SuggestionsResponse>(`/comments/${commentId}/suggestions`)
      .then((r) => alive && setSet(r.latest))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [commentId]);

  // 輸入時即時檢查（禁用詞、承諾、查無根據的金額日期）
  useEffect(() => {
    if (!body.trim()) {
      setWarnings([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .post<ReplyCheckResult>(`/comments/${commentId}/check-reply`, { body })
        .then((r) => setWarnings(r.warnings))
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [body, commentId]);

  const generate = async () => {
    setGenerating(true);
    try {
      const r = await api.post<SuggestionsResponse>(`/comments/${commentId}/suggestions`);
      setSet(r.latest);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  const use = (v: SuggestionVariant) => {
    if (!lockMine) onFocusStart();
    setPicked(v);
    setBody(v.body);
    setTimeout(() => ref.current?.focus(), 0);
  };

  const send = async (statusAfter: ReplyInput['statusAfter'], confirmWarnings = false) => {
    setSending(true);
    try {
      const input: ReplyInput = { body: body.trim(), statusAfter, suggestionId: picked?.id ?? null, confirmWarnings };
      const d = await api.post<CommentDetail>(`/comments/${commentId}/reply`, input);
      setBody('');
      setPicked(null);
      setConfirm(null);
      onSent(d, statusAfter === 'done' ? '已回覆並完成' : '已回覆，等待對方回應');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'reply_warnings') {
        setConfirm({ statusAfter, warnings: (err.details as { warnings: ReplyWarning[] }).warnings });
      } else toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  const empty = body.trim().length === 0;
  const blocked = warnings.some((w) => w.level === 'block');
  const edited = picked ? picked.body.trim() !== body.trim() : false;

  return (
    <section className="reply-box">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <label className="small strong" htmlFor="reply-body">
          回覆留言（會公開顯示在平台上）
        </label>
        <Button size="sm" onClick={() => void generate()} loading={generating} disabled={disabled}>
          ✨ {set ? '重新產生建議' : 'AI 回覆建議'}
        </Button>
      </div>

      {set && (
        <div className="suggest">
          {set.notes.map((n) => (
            <Alert key={n} tone={n.startsWith('知識不足') || n.includes('人工判斷') ? 'warning' : 'info'}>
              {n}
            </Alert>
          ))}
          {set.guidance && (
            <p className="small suggest-guide">
              <strong>品牌處理指引：</strong>
              {set.guidance}
            </p>
          )}
          {set.hits.length > 0 && (
            <div className="suggest-hits">
              <span className="small muted">引用知識：</span>
              {set.hits.map((h) => (
                <span key={h.id}>
                  <button className="chip" onClick={() => setOpenHit(openHit === h.id ? null : h.id)} aria-expanded={openHit === h.id}>
                    📘 {h.title}
                  </button>
                </span>
              ))}
              {set.hits
                .filter((h) => h.id === openHit)
                .map((h) => (
                  <div key={h.id} className="suggest-hit-body small">
                    <Badge>{KNOWLEDGE_CATEGORY_LABELS[h.category]}</Badge> {h.content}
                    {h.matched.length > 0 && <div className="muted">命中關鍵字：{h.matched.join('、')}</div>}
                  </div>
                ))}
            </div>
          )}
          <div className="suggest-variants">
            {set.variants.map((v) => (
              <div key={v.id ?? v.key} className={`variant ${picked?.id === v.id ? 'picked' : ''}`}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <Badge tone="purple">{v.label}</Badge>
                  <Button size="sm" variant={picked?.id === v.id ? 'primary' : 'secondary'} onClick={() => use(v)} disabled={disabled}>
                    {picked?.id === v.id ? '使用中' : '使用這個版本'}
                  </Button>
                </div>
                <p>{v.body}</p>
                {v.warnings.length > 0 && <p className="small warn-text">⚠ {v.warnings.map((w) => w.message).join('；')}</p>}
              </div>
            ))}
          </div>
          {set.forbiddenPromises.length > 0 && (
            <details className="small">
              <summary className="muted">品牌不可承諾的事項（{set.forbiddenPromises.length}）</summary>
              <ul className="suggest-list">
                {set.forbiddenPromises.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            第 {set.round} 次產生・{formatShortDateTime(set.createdAt)}
            {set.requestedByName ? `・${set.requestedByName}` : ''}。AI 只會引用已審核的品牌知識，送出前請務必確認內容。
          </p>
        </div>
      )}

      <Textarea
        id="reply-body"
        ref={ref}
        rows={4}
        value={body}
        disabled={disabled}
        placeholder={disabled ? '別人正在處理這則留言' : '輸入回覆內容，或從上方選一個 AI 建議版本再修改…'}
        onFocus={() => {
          if (!lockMine) onFocusStart();
        }}
        onChange={(e) => setBody(e.target.value)}
        maxLength={2000}
      />
      {picked && (
        <div className="row small">
          <Badge tone="purple">
            {edited ? '修改自' : '採用'} AI 建議：{picked.label}
          </Badge>
          <button className="link-btn" onClick={() => setPicked(null)}>
            改為手動撰寫
          </button>
        </div>
      )}
      {warnings.length > 0 && (
        <ul className="reply-warnings">
          {warnings.map((w) => (
            <li key={w.message} className={w.level}>
              {w.level === 'block' ? '⛔' : '⚠'} {w.message}
            </li>
          ))}
        </ul>
      )}
      <div className="reply-actions">
        <span className="muted small">{body.length} / 2000</span>
        <span className="spacer" />
        <Button size="sm" disabled={disabled || empty || blocked} loading={sending} onClick={() => void send('waiting')} title="已回覆但還需要對方回應（例如請對方私訊訂單編號）">
          送出，等待對方回應
        </Button>
        <Button size="sm" variant="primary" disabled={disabled || empty || blocked} loading={sending} onClick={() => void send('done')}>
          送出並完成
        </Button>
      </div>
      <p className="muted small hint">「已回覆」不等於「已完成」：若還需要對方提供資料或確認，請選「等待對方回應」。</p>

      <Modal
        open={!!confirm}
        title="送出前請確認"
        size="sm"
        onClose={() => setConfirm(null)}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>返回修改</Button>
            <Button variant="primary" loading={sending} onClick={() => confirm && void send(confirm.statusAfter, true)}>
              確認無誤，送出
            </Button>
          </>
        }
      >
        <div className="stack">
          <p style={{ margin: 0 }}>系統檢查到以下內容可能需要確認：</p>
          <ul className="reply-warnings">
            {confirm?.warnings.map((w) => (
              <li key={w.message} className={w.level}>
                ⚠ {w.message}
              </li>
            ))}
          </ul>
          <p className="muted small" style={{ margin: 0 }}>
            確認送出會記錄在操作紀錄中。
          </p>
        </div>
      </Modal>
    </section>
  );
}
