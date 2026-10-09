// 模擬 AI：以關鍵字規則判斷留言，結果可預期，方便驗證安全原則。
import type { AIProvider, Analysis, AnalyzeInput, GenerateInput } from './types';
import type { Priority, RiskFlag, RiskLevel, Sentiment } from '../../shared/constants';

interface Signal {
  key: string;
  words: RegExp;
  tag: string;
}

// 依「越需要人處理越優先」排序：前面的類型會成為主要分類
const SIGNALS: Signal[] = [
  { key: 'spam', words: /加\s*line|加賴|賺錢|日賺|兼職|投資|免費領|點我|https?:\/\/(?!www\.(facebook|instagram|youtube)\.com)|私訊領/i, tag: '垃圾訊息' },
  { key: 'malicious', words: /垃圾公司|爛公司|去死|白癡|白痴|智障|騙子公司|詐騙集團|黑心/, tag: '惡意' },
  { key: 'complaint', words: /漏水|壞掉|壞了|故障|爛|失望|生氣|客訴|投訴|退款|退費|退貨|賠償|補償|不負責|態度很差|等很久|沒人回|品質.*(差|怎樣)|有問題/, tag: '客訴' },
  { key: 'after_sales', words: /保固|維修|送修|換貨|瑕疵|零件|更換濾芯|濾芯.*(換|買)/, tag: '售後' },
  { key: 'bulk_purchase', words: /大量|團購|企業採購|公司.*(訂|採購)|尾牙|批發|\d{2,}\s*(份|組|台|箱)/, tag: '大量採購' },
  { key: 'business_coop', words: /合作|業配|邀約|聯名|贊助|podcast|youtuber|部落客|媒體/i, tag: '商業合作' },
  { key: 'price_inquiry', words: /多少錢|價格|價錢|售價|怎麼賣|一組多少|優惠|折扣|特價|\$\$/, tag: '詢價' },
  { key: 'purchase_inquiry', words: /哪裡買|哪裡可以買|門市|庫存|有貨|運費|寄送|到貨|出貨|下單|網購/, tag: '購買詢問' },
  { key: 'usage', words: /怎麼用|如何使用|怎麼(裝|安裝|清洗|保養)|教學|使用方式|步驟/, tag: '使用方式' },
  { key: 'product_inquiry', words: /規格|尺寸|顏色|差別|差異|適合|可以.*嗎|有沒有|材質|功能/, tag: '產品詢問' },
  { key: 'praise', words: /好喝|好用|好吃|好可愛|好美|超美|很美|漂亮|好看|有質感|有面子|讚|推推|推薦|大推|愛用|愛了|喜歡|太棒|超棒|很棒|好棒|感謝|謝謝|回購|必買|必收|好好|美味|貼心|用心|專業|滿意|開心|❤|♥|😍|🥰|👍|🎉/, tag: '稱讚' },
];

const SENSITIVE = /塑化劑|致癌|過敏|中毒|受傷|燙傷|誤吞|醫生|醫院|安全嗎|有毒|發炎|髖關節|窒息/;
const REFUND = /退款|退費|退錢|退貨/;
const COMPENSATION = /賠償|補償|賠我/;
const PROMISE = /保證|一定會|什麼時候(會)?(到|好|修好)|可以.*(免費|送我)|承諾/;
const LEGAL = /消保官|消基會|告你|提告|律師|檢舉/;
const NEGATIVE = /爛|差|失望|生氣|不爽|難喝|難用|後悔|垃圾|噁心|很糟|太扯|漏水|壞|破了|破掉|退款|退貨|退費|賠償|補償|不負責|等很久/;
const EMOJI_ONLY = /^[\s\p{Extended_Pictographic}\p{Emoji_Modifier}‍️]+$/u;
const TAG_FRIEND = /^(@\S+\s*)+$/;

export const mockProvider: AIProvider = {
  name: 'mock',

  async analyze(input: AnalyzeInput): Promise<Analysis> {
    const text = input.body.trim();
    const reasons: string[] = [];

    // 純表情、只標記朋友 → 無需回覆
    if (text === '' || EMOJI_ONLY.test(text) || TAG_FRIEND.test(text)) {
      return {
        categoryKey: 'no_reply',
        tags: ['無需回覆'],
        riskFlags: [],
        riskLevel: 'none',
        sentiment: /👍|❤|♥|😍|🥰|🎉/.test(text) ? 'positive' : 'neutral',
        priority: 'low',
        confidence: 0.95,
        isAmbiguous: false,
        isMultiIssue: false,
        reasons: ['只有表情符號或標記朋友，沒有需要回答的內容'],
      };
    }

    const matched = SIGNALS.filter((s) => s.words.test(text));
    const riskFlags = new Set<RiskFlag>();
    if (SENSITIVE.test(text)) riskFlags.add('sensitive').add('safety');
    if (REFUND.test(text)) riskFlags.add('refund');
    if (COMPENSATION.test(text)) riskFlags.add('compensation');
    if (PROMISE.test(text)) riskFlags.add('unverifiable_promise');
    if (LEGAL.test(text)) riskFlags.add('legal');
    if (matched.some((m) => m.key === 'complaint')) riskFlags.add('complaint');
    if (matched.some((m) => m.key === 'spam')) riskFlags.add('spam');
    if (matched.some((m) => m.key === 'malicious')) riskFlags.add('malicious');
    // Google 低星評論視為公開爭議
    if (input.rating !== null && input.rating <= 2) {
      riskFlags.add('public_dispute');
      reasons.push(`Google 評論 ${input.rating} 星`);
    }

    // 稱讚與負面字眼同時出現（例如「好喝但很失望」）不算稱讚
    const negative = NEGATIVE.test(text) || (input.rating !== null && input.rating <= 2);
    const nonPraise = matched.filter((m) => m.key !== 'praise');
    let primary = matched[0]?.key ?? 'other';
    if (primary === 'praise' && negative) primary = 'negative_review';
    if (input.rating !== null && input.rating <= 2 && !['spam', 'malicious', 'complaint'].includes(primary)) primary = 'negative_review';
    if (input.rating !== null && input.rating >= 4 && matched.length === 0) primary = 'praise';

    const sentiment: Sentiment = negative ? 'negative' : matched.some((m) => m.key === 'praise') || (input.rating ?? 0) >= 4 ? 'positive' : 'neutral';
    const isMultiIssue = nonPraise.length >= 2;
    const hasQuestion = /[?？]|嗎|呢|請問/.test(text);
    const isAmbiguous = matched.length === 0 && (hasQuestion || text.length > 40);

    let confidence: number;
    if (matched.length === 0) confidence = text.length <= 12 ? 0.55 : 0.4;
    else if (isMultiIssue) confidence = 0.6;
    else if (matched.length === 2 && primary !== 'praise') confidence = 0.75;
    else confidence = text.length <= 60 ? 0.92 : 0.82;
    if (primary === 'praise' && hasQuestion) confidence = Math.min(confidence, 0.7);

    if (matched.length) reasons.push(`關鍵字判斷：${matched.map((m) => m.tag).join('、')}`);
    else reasons.push('沒有明確的關鍵字');
    if (isMultiIssue) reasons.push('同時包含多種問題');
    if (isAmbiguous) reasons.push('問題內容不明確');

    const riskLevel: RiskLevel = riskFlags.has('safety') || riskFlags.has('legal') || riskFlags.has('compensation')
      ? 'high'
      : riskFlags.has('complaint') || riskFlags.has('refund') || riskFlags.has('public_dispute') || riskFlags.has('unverifiable_promise') || riskFlags.has('sensitive')
        ? 'medium'
        : riskFlags.size > 0
          ? 'low'
          : 'none';

    const priority: Priority =
      riskLevel === 'high' || primary === 'complaint' || primary === 'bulk_purchase'
        ? 'high'
        : riskLevel === 'medium' || ['price_inquiry', 'purchase_inquiry', 'product_inquiry', 'after_sales', 'business_coop', 'negative_review'].includes(primary)
          ? 'medium'
          : 'low';

    const tags = [...new Set(matched.map((m) => m.tag))];
    if (negative) tags.push('負面情緒');
    if (priority === 'high') tags.push('高優先處理');

    return {
      categoryKey: primary,
      tags,
      riskFlags: [...riskFlags],
      riskLevel,
      sentiment,
      priority,
      confidence: Math.round(confidence * 100) / 100,
      isAmbiguous,
      isMultiIssue,
      reasons,
    };
  },

  async generateSimpleReply(input: GenerateInput): Promise<string> {
    const { style, categoryKey, seed } = input;
    const you = style.addressing || '您';
    const emoji = style.emojiUsage === 'frequent' ? ['☕', '🙌', '😊', '✨'] : style.emojiUsage === 'light' ? ['😊', '', '🌱', ''] : ['', '', '', ''];
    const pick = <T,>(list: T[]) => list[Math.floor(Math.abs(seed)) % list.length];
    const em = pick(emoji);
    // 第一句結尾：有表情就「！☕ 」，沒有就「！」
    const end = em ? `！${em} ` : '！';

    const praise = [
      `謝謝${you}的肯定${end}${input.brandName}會繼續努力，期待再為${you}服務。`,
      `看到${you}的留言好開心${end}謝謝${you}的支持，我們會繼續加油。`,
      `感謝${you}的分享與喜愛${end}有任何需要都歡迎隨時找我們。`,
      `謝謝${you}這麼喜歡${end}${you}的鼓勵是我們最大的動力。`,
    ];
    const general = [
      `謝謝${you}的留言${end}有任何問題都歡迎隨時告訴我們。`,
      `感謝${you}的互動${end}${input.brandName}一直都在，歡迎常來聊聊。`,
      `謝謝${you}的支持${end}祝${you}有美好的一天。`,
      `收到${you}的留言了${end}謝謝${you}關注${input.brandName}。`,
    ];
    let text = pick(categoryKey === 'praise' ? praise : general);
    // 簡短風格：只保留第一句
    if (style.replyLength === 'short') {
      // 簡短風格：第一句 + 品牌常用語（只用不涉及處理流程的寒暄句）
      const phrases = style.commonPhrases.filter((p) => !/私訊|問|處理|聯繫|說明書/.test(p) && !/^(謝謝|感謝)/.test(p));
      text = text.split(/(?<=！)/)[0] + em + (phrases.length ? ` ${pick(phrases)}` : '');
    }
    if (style.signature) text += `\n— ${style.signature}`;
    // 不使用品牌禁用詞
    for (const w of style.bannedWords) if (w && text.includes(w)) text = text.replaceAll(w, '');
    return text.replace(/\s+\n/g, '\n').trim();
  },
};
