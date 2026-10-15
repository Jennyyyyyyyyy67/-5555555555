// 清除某個品牌的示範資料（保留已連結的真實帳號）：把示範品牌改成自己的品牌時使用。
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { api, errorMessage } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { Button, Card, Checkbox, ConfirmDialog, Select } from '../../components/ui';

export function ClearBrandDemo({ onDone }: { onDone: () => void }) {
  const { brands } = useAuth();
  const toast = useToast();
  const [brandId, setBrandId] = useState(brands[0]?.id ?? 0);
  const [removeKnowledge, setRemoveKnowledge] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const brand = brands.find((b) => b.id === brandId);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ accounts: number; posts: number; comments: number; knowledge: number }>('/mock/clear-brand', { brandId, confirm: true, removeKnowledge });
      toast.success(`已清除 ${r.accounts} 個示範帳號、${r.posts} 篇貼文、${r.comments} 則留言${removeKnowledge ? `、${r.knowledge} 則知識` : ''}`);
      setOpen(false);
      onDone();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="清除品牌的示範資料">
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>
          把示範品牌改成自己的品牌時使用：刪除這個品牌底下的<strong>示範社群帳號</strong>與它們的貼文、留言。<strong>已連結的真實帳號（例如 Instagram）與留言會保留</strong>，操作紀錄也會保留。
        </p>
        <div className="row-wrap">
          <Select value={brandId} onChange={(e) => setBrandId(Number(e.target.value))} aria-label="品牌" style={{ width: 'auto' }}>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
          <Checkbox label="同時清除這個品牌的知識庫與處理指引" checked={removeKnowledge} onChange={setRemoveKnowledge} />
          <Button variant="danger" onClick={() => setOpen(true)} disabled={!brandId}>
            清除示範資料
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={open}
        danger
        title={`清除「${brand?.name ?? ''}」的示範資料？`}
        message={`會刪除示範社群帳號與它們的貼文、留言${removeKnowledge ? '，以及這個品牌的知識庫' : ''}，無法復原。已連結的真實帳號不受影響。`}
        confirmText="確認清除"
        busy={busy}
        onCancel={() => setOpen(false)}
        onConfirm={() => void run()}
      />
    </Card>
  );
}
