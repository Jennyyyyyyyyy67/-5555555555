// 示範知識庫：AI 回覆建議只能引用這裡「已審核、啟用中、有效期限內」的內容。
// validDays：從現在起算幾天後到期（負數代表已過期）；pending 代表小編提出、等待主管審核。
import type { KnowledgeCategory } from '../../../shared/constants';
import type { UserKey } from './types';

export interface KnowledgeSeed {
  category: KnowledgeCategory;
  title: string;
  content: string;
  keywords: string[];
  validDays?: number;
  /** 幾天後才生效 */
  startsInDays?: number;
  status?: 'approved' | 'pending';
  by?: UserKey;
  inactive?: boolean;
}

export const KNOWLEDGE: Record<string, KnowledgeSeed[]> = {
  CLEAR: [
    {
      category: 'campaign',
      title: '秋季舊機換購活動',
      content: '10/1–10/31 舊機換購 RO-600，舊機折抵最高 3,000 元，再送一年份濾芯（PP、活性碳、CF-3 複合濾芯各一支）。任何品牌的舊淨水器都可以折抵，折抵金額依機齡由門市人員評估。',
      keywords: ['換購', '折抵', '舊機', '別牌', '一年份濾芯', '活動到什麼時候'],
      validDays: 19,
    },
    {
      category: 'price',
      title: 'RO-600 / RO-400 售價',
      content: 'RO-600 原價 18,800 元，RO-400 原價 14,800 元，皆含基本安裝。信用卡可分 12 期 0 利率。',
      keywords: ['RO-600', 'RO-400', '原價', '分期'],
    },
    {
      category: 'spec',
      title: 'RO-600 與 RO-400 差異',
      content: 'RO-600 每日最大出水量約 600 加侖、出水速度約每分鐘 1.5 公升，適合 3 人以上家庭；RO-400 每日約 400 加侖、每分鐘約 1 公升，適合 1～2 人小家庭。兩款濾芯通用。',
      keywords: ['差在哪', '差別', '出水速度', '一分鐘', '幾公升', '兩個人', 'RO-400'],
    },
    {
      category: 'faq',
      title: '濾芯更換週期',
      content: '一般家庭建議前置 PP 濾芯 3–6 個月、活性碳 6 個月、RO 膜 18–24 個月，實際依水質與用水量而定；水質偏硬的地區 PP 濾芯建議 3 個月更換。濾芯指示燈依使用天數提醒，用水量大時可能提早亮燈。',
      keywords: ['多久換', '更換週期', '水質偏硬', '指示燈', '變紅', 'PP 濾芯'],
    },
    {
      category: 'usage',
      title: '更換濾芯後出現碳粉',
      content: '新的活性碳濾芯第一次出水會帶有少量黑色碳粉，屬正常現象。請先放水約 3 分鐘，直到出水清澈再飲用。',
      keywords: ['碳粉', '黑黑的', '第一次出水'],
    },
    {
      category: 'installation',
      title: '濾芯卡榫旋轉方向',
      content: '濾芯卡榫為逆時針轉開、順時針鎖緊，轉之前請先關閉進水閥並按下洩壓鈕。',
      keywords: ['卡榫', '順時針', '逆時針', '轉不開'],
    },
    {
      category: 'warranty',
      title: '保固與濾芯收費',
      content: '主機保固 2 年，保固期內主機故障免費維修；濾芯為消耗品，更換需另外購買。若為濾芯本身瑕疵造成漏水，請私訊訂單編號與照片，由客服確認後處理。',
      keywords: ['保固', '收費', '要錢', '免費維修'],
    },
    {
      category: 'brand_intro',
      title: '門市資訊',
      content: '澄淨家電目前有台北大安門市（忠孝東路四段，11:00–21:00）與台中西屯門市（市政路，11:00–21:00），兩間門市都可看實機、體驗與更換 SPARK 氣泡水機鋼瓶。',
      keywords: ['門市', '台中', '實機', '鋼瓶', '哪裡換', '營業時間'],
    },
    {
      category: 'campaign',
      title: '暑假淨水器優惠（已結束）',
      content: '7/1–8/31 淨水器全系列 9 折。',
      keywords: ['優惠', '折扣', '打折'],
      validDays: -40,
    },
    {
      category: 'faq',
      title: '企業與設計師合作窗口',
      content: '企業採購（辦公室、飯店）與設計師、經銷合作，請來信 b2b@clear-home.tw 或私訊留下公司名稱與聯絡方式，由業務窗口於 2 個工作天內聯繫。',
      keywords: ['企業', '辦公室', '飯店', '設計師', '經銷', '採購方案', '企業方案'],
    },
    {
      category: 'faq',
      title: 'RO 會不會濾掉礦物質',
      content: 'RO 逆滲透會濾除大部分溶解物質，包含部分礦物質。',
      keywords: ['礦物質'],
      status: 'pending',
      by: 'amy',
    },
  ],

  DAILY: [
    {
      category: 'campaign',
      title: '耶誕禮盒早鳥優惠',
      content: '耶誕禮盒（3 款季節限定配方豆＋6 入掛耳＋手繪馬克杯）早鳥價 1,280 元（原價 1,580 元），11/30 前預購享早鳥價，12/10 起陸續出貨。',
      keywords: ['耶誕禮盒', '禮盒', '早鳥', '預購'],
      validDays: 49,
    },
    {
      category: 'price',
      title: '咖啡豆價格',
      content: '單品豆半磅 420 元起、一磅 780 元起；配方豆半磅 380 元起。每支豆子的價格請以官網商品頁為準。',
      keywords: ['半磅', '一磅', '豆子多少'],
    },
    {
      category: 'campaign',
      title: '掛耳訂閱方案',
      content: '掛耳訂閱每月 20 包，月費 690 元，首月 5 折。可隨時在會員中心暫停或取消，暫停最長 2 個月。',
      keywords: ['訂閱', '暫停', '取消', '每個月多少'],
    },
    {
      category: 'campaign',
      title: '中山店週年慶',
      content: '中山店兩週年，10/31 前到店點手沖咖啡第二杯半價（限內用與外帶皆可，限同品項）。',
      keywords: ['第二杯半價', '週年', '外帶'],
      validDays: 19,
    },
    {
      category: 'brand_intro',
      title: '門市營業時間',
      content: '中山店（南京西路）每日 08:00–20:00；信義店（松仁路）每日 09:00–21:00。',
      keywords: ['幾點開門', '營業時間', '中山店', '信義店', '幾點'],
    },
    {
      category: 'usage',
      title: '手沖研磨粗細',
      content: '手沖建議研磨粗細接近砂糖（中細研磨）；摩卡壺建議更細，接近細鹽。網購咖啡豆可在備註指定研磨用途，我們會幫你磨好。',
      keywords: ['磨豆', '粗細', '砂糖', '鹽巴', '摩卡壺', '磨好'],
    },
    {
      category: 'usage',
      title: '水溫 92 度怎麼抓',
      content: '水煮沸後靜置約 1 分鐘，水溫大約會降到 92 度左右。',
      keywords: ['92 度', '水溫', '放多久'],
    },
    {
      category: 'product_info',
      title: '楓糖拿鐵甜度',
      content: '楓糖拿鐵可調整甜度：正常、少糖、半糖。',
      keywords: ['甜度', '少糖', '楓糖'],
    },
    {
      category: 'faq',
      title: '企業訂購與合作窗口',
      content: '企業禮品、尾牙春酒、辦公室咖啡訂閱等企業訂單，以及媒體、Podcast、創作者合作邀約，請來信 hello@dailycoffee.tw，由專人報價或回覆。',
      keywords: ['企業', '尾牙', '公司', '辦公室', '合作', 'YouTuber', 'Podcast', '團購'],
    },
  ],

  MORI: [
    {
      category: 'spec',
      title: '玻璃奶瓶材質與消毒',
      content: '小森玻璃奶瓶瓶身為耐熱硼矽玻璃，奶嘴與吸管零件為食品級矽膠，不含雙酚 A（BPA-free），可煮沸、蒸氣消毒。檢驗報告可在官網商品頁查看。',
      keywords: ['塑化劑', '玻璃', '材質', '消毒', '煮沸', '蒸氣'],
    },
    {
      category: 'product_info',
      title: '背巾尺寸與適用年齡',
      content: '小森背巾為單一尺寸、肩帶可調，適用身高 150–190 公分的大人，可夫妻共用。適用寶寶體重 3.5–15 公斤，新生兒需搭配新生兒坐墊使用前背。',
      keywords: ['背巾', '尺寸', '共用', '公分', '新生兒', '幾個月'],
    },
    {
      category: 'price',
      title: '背巾售價',
      content: '小森背巾售價 3,280 元，新生兒坐墊 680 元。',
      keywords: ['背巾多少', '坐墊'],
    },
    {
      category: 'campaign',
      title: '板橋門市背巾體驗',
      content: '板橋門市（文化路）11:00–20:00 可免費試背，假日人多建議先私訊預約，由專人示範 M 字腿正確背法。',
      keywords: ['試背', '預約', '板橋', '門市', '假日'],
    },
    {
      category: 'usage',
      title: '餐具清潔方式',
      content: '吸盤碗、軟頭湯匙與學習杯為食品級鉑金矽膠，可微波、可放入洗碗機上層清洗。',
      keywords: ['洗碗機', '微波', '矽膠', '餐具'],
    },
    {
      category: 'faq',
      title: '團體與合作窗口',
      content: '月子中心、醫療院所等團體採購，以及部落客合作邀約，請私訊留下單位名稱與聯絡方式，由專人聯繫。',
      keywords: ['月子中心', '團體', '採購', '部落客', '合作'],
    },
    {
      category: 'faq',
      title: '160ml 奶瓶補貨',
      content: '160ml 玻璃奶瓶預計 10 月底補貨。',
      keywords: ['補貨', '160ml'],
      status: 'pending',
      by: 'hao',
    },
  ],
};
