# Roadmap · 發展路線

目標：在 Windows 上做出開源、免費、裝好就能用的房間校正與聆聽工具。房間校正的核心能力要做到商業方案（例如 Dirac Live 加上 Active Room Treatment）的八成左右；量測、耳機、播放這些周邊則要做得比它們更完整。

## 1. 房間校正：與 Dirac Live 的對照

| 能力 | Dirac Live（含 ART） | Fono Console 目前 | 下一步 |
|---|---|---|---|
| 頻率響應校正 | 混合相位，多點量測 | ✅ 自動峰值濾波（只削峰），1／3／5 點平均，上限依施羅德頻率 | 9 點量測與座位權重 |
| 相位／脈衝響應校正 | ✅ 混合相位 FIR | ✅ 超額相位 FIR（量測或分頻模型），各取樣率延遲一致 | 多點平均的超額相位；預振鈴控制 |
| 時間與音量對齊 | ✅ | ✅ 抵達時間、極性、音量；四聲道 A／B 模式 | — |
| 目標曲線編輯 | ✅ 可拖曳 | ✅ 拖曳節點，預設：平直／房間曲線／暖／亮；自動 EQ 追著目標走 | Harman／B&K 預設；修正範圍分頻段權重 |
| 修正範圍設定 | ✅ | ⚠️ 自動決定 | 上下限可調 |
| 麥克風校正檔 | ✅ | ✅ 匯入 UMIK 類 `.txt` 校正檔（實驗室） | 依序號自動套用 |
| 多麥克風／多點同時錄 | — | ⚠️ 麥克風相對配對（實驗室）：兩支麥克風同點量同一顆喇叭，存差異曲線 | 立體聲輸入同時錄兩支麥克風 |
| 低頻多音箱協同（Bass Control） | 付費選項 | ❌ | 用後方喇叭補低頻空洞：計算各聲道的延遲與相位，讓低頻在座位上疊加 |
| 主動抵消駐波衰減（ART） | 付費選項，所有喇叭一起做 MIMO FIR | ✅ 實驗版：15 點量測、四喇叭最小平方 FIR、留一驗證＋室溫漂移預估；模擬 40–63 Hz 殘響縮短約 25–45% | 真實房間驗證；四聲道氛圍與 ART 並用 |
| 校正前後報告 | ✅ | ⚠️ 頻響曲線、衰減（EDT／T20／T30）與瀑布圖、ART 預估報告 | 前後對照一頁匯出 |

**目前估計約 70%（含 ART 實驗版、目標曲線、衰減分析）；上表「下一步」做完約 80–85%**（ART 等級的主動抵消不算在內）。

## 2. 量測

- [x] 瀑布圖（CSD）
- [ ] 頻譜圖、步階響應、群延遲檢視
- [x] RT60／EDT／T20／T30（Schroeder 積分，每個倍頻帶）
- [x] 房間掃描匯入、平面圖、早期反射鏡像點、座位的房間模態（實驗室）
- [x] 無訊號防呆：量不到聲音就停下並說明原因
- [ ] 諧波失真：用對數掃頻的 Farina 方法，從脈衝響應前方分離出 2、3 次諧波
- [ ] 量測紀錄庫：存檔、命名、比較、匯出 REW 可讀的格式
- [ ] 一鍵驗證報告（可匯出圖片分享）

## 3. 麥克風與耳機量測

- [x] **麥克風相對配對**（實驗室）：兩支麥克風放在同一點、量同一顆喇叭，求出它們的差異曲線，之後自動補償。這只能讓它們「彼此一致」，絕對準確度仍要靠一支有校正檔的麥克風當基準。
- [ ] **耳機量測**：在耳道口放雙耳麥克風（自製教學另外寫），量左右耳的頻響，產生個人化的耳機校正，可與 AutoEq 結果比對。
- [ ] **虛擬喇叭**：用雙耳麥克風錄下房間裡每顆喇叭到兩耳的脈衝響應（BRIR），再補償耳機自身的響應，讓耳機聽起來像你的喇叭與房間。方法參考 [Impulcifer](https://github.com/jaakkopasanen/Impulcifer)（MIT），輸出給 Equalizer APO 做卷積。
- [ ] 自製雙耳麥克風、簡易人頭的圖文教學與零件清單

## 4. 聲音處理

- [ ] 參數 EQ 編輯器：在曲線上直接拖曳頻段（PK／LS／HS／LP／HP）
- [x] 等響度補償：依聆聽音量補低音、高音（ISO 226，實驗室）
- [ ] 更多交叉饋送：Bauer bs2b 預設、Chu Moy
- [ ] 卷積 IR 庫：小房間、錄音室、音樂廳
- [ ] VST 外掛管理（Equalizer APO 支援 VST2）

## 5. 介面與使用體驗

- [x] 四種面板（混音台、胡桃木、鋁面卡座、石墨錄音室）、深淺色、自選強調色
- [x] 播放頁：唱盤（十種黑膠顏色、四種唱盤）、卡帶、大型 VU 表、大封面、極簡；指針／LED／輝光管儀表
- [x] 設定精靈、功能模組開關、教學網站與互動示範
- [x] 十種配色與自訂五色、面板材質、桌布（內建與上傳）、主題匯出入
- [x] 編輯版面：拖曳面板、可排序的導覽列、自訂分頁與小工具目錄、版面匯出入
- [x] 設定精靈：喇叭配置（耳機／2.0／4.0）與外觀步驟；功能導覽與教學網站涵蓋新功能
- [ ] 指針式頻譜、迷你浮動視窗
- [ ] 系統匣圖示、媒體鍵、全域快捷鍵
- [ ] 英文介面（i18n）

## 6. 讓開源社群用得起來

- [x] GitHub Actions：自動建置 Release、部署教學網站
- [ ] 單元測試：DSP（反卷積、FIR 設計）、設定檔產生器
- [ ] 貢獻指南、問題範本、量測資料分享格式
- [ ] 讓 AutoEq、REW 社群的人知道它存在：在 Head-Fi、ASR、AVS 發表介紹與實測

---

*English summary:* Fono Console aims to reach roughly 80% of a commercial room-correction suite on Windows, for free. Done: auto EQ (cuts only, multi-position), excess-phase FIR, time and level alignment. Also done: target-curve editor, mic calibration files, decay plots and RT60, look system, player styles, widgets and custom pages, speaker-layout onboarding. Next: 9-position weighting, rear-speaker bass assistance. Research: ART-style active modal decay cancellation. Planned: binaural headphone measurement and virtual speakers (Impulcifer method), and UI work.
