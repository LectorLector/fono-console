# Roadmap · 發展路線

[English](#english) | [繁體中文](#繁體中文)

<a id="english"></a>

## English

Goal: an open-source, free, install-and-go room correction and listening tool for Windows. Its room-correction core should reach roughly 80% of a commercial suite (for example Dirac Live with Active Room Treatment), and the surrounding pieces (measurement, headphones, playback) should be more complete than theirs.

### 1. Room correction compared with Dirac Live

| Capability | Dirac Live (with ART) | Fono Console today | Next |
|---|---|---|---|
| Frequency-response correction | Mixed phase, multi-point measurement | ✅ Automatic peaking filters (cut-only), 1/3/5/9/15-position averaging, limited by the Schroeder frequency; editable seat weights for ART | Weighting inside the auto-EQ fit |
| Phase / impulse-response correction | ✅ Mixed-phase FIR | ✅ Excess-phase FIR (measured or crossover model), identical latency at every sample rate; optional pre-ring limit in ART | Excess phase from multi-point averages |
| Time and level alignment | ✅ | ✅ Arrival time, polarity, level; Quad A/B modes | — |
| Target curve editing | ✅ Draggable | ✅ Drag nodes; presets flat / room curve / warm / bright; auto-EQ follows the target | Harman / B&K presets; per-band weighting of the correction range |
| Correction range setting | ✅ | ⚠️ Decided automatically | Adjustable upper and lower limits |
| Microphone calibration file | ✅ | ✅ Import UMIK-style `.txt` files (Lab) | Apply automatically by serial number |
| Multi-microphone / multi-point simultaneous capture | — | ⚠️ Relative mic pairing (Lab): two mics at one point measure the same speaker and store a difference curve | Record two microphones at once from a stereo input |
| Multi-speaker bass cooperation (Bass Control) | Paid option | ⚠️ Subwoofer layouts 2.1 / 2.2 / 4.1 / 4.2 with LR4 bass management and measured sub delay/polarity alignment (manual gain) | Automatic sub level matching; fill bass holes with the rear speakers |
| Active cancellation of modal decay (ART) | Paid option, MIMO FIR over all speakers | ✅ Experimental: 9/15-point guided measurement, any helper set (rear pair or subs), least-squares FIR with automatic regularisation, headroom protection, optional pre-ring limit, verification loop (measured vs predicted); simulated 40–63 Hz decay shortened by about 25–50% | Real-room validation data; combining Quad ambience with ART |
| Before/after report | ✅ | ✅ Frequency response, decay (EDT/T20/T30) and waterfall, ART prediction and verification, ranked room-diagnosis report (HTML export) | One-page before/after export |

**Currently about 70% (including experimental ART, target curve and decay analysis); finishing the "Next" column brings it to roughly 80–85%** (ART-level active cancellation not counted).

### 2. Measurement

- [x] Waterfall (CSD)
- [ ] Spectrogram, step response, group-delay view
- [x] RT60 / EDT / T20 / T30 (Schroeder integration, per octave band)
- [x] Room scan import, floor plan, early-reflection mirror points, room modes at the seat (Lab)
- [x] Room diagnosis: ranked plain-language findings with severity and actions, exportable HTML report
- [x] Seat heatmap: predicted 30-120 Hz unevenness on the floor plan, best area outlined, live while dragging
- [x] Subwoofer alignment: measured sub delay and polarity relative to the mains
- [x] ART verification loop: re-measure with ART on, measured vs predicted decay, honest verdict
- [x] No-signal guard: if no sound is recorded, stop and explain why
- [ ] Harmonic distortion: separate the 2nd and 3rd harmonics ahead of the impulse response using Farina's log-sweep method
- [ ] Measurement library: save, name, compare, export in a format REW can read
- [ ] One-click verification report (exportable as an image)

### 3. Microphone and headphone measurement

- [x] **Relative mic pairing** (Lab): put two microphones at the same point, measure the same speaker, derive their difference curve and compensate automatically afterwards. This only makes them agree with each other; absolute accuracy still needs a microphone with a calibration file as reference.
- [ ] **Headphone measurement**: binaural microphones at the ear canal entrance (a DIY guide will be written separately) to measure left/right response and produce a personal headphone correction that can be compared with AutoEq.
- [ ] **Virtual speakers**: record each room speaker's impulse response to both ears (BRIR) with binaural microphones, compensate the headphones' own response, and make headphones sound like your speakers in your room. The method follows [Impulcifer](https://github.com/jaakkopasanen/Impulcifer) (MIT), with convolution output for Equalizer APO.
- [ ] Illustrated guide and parts list for DIY binaural microphones and a simple dummy head

### 4. Sound processing

- [ ] Parametric EQ editor: drag bands directly on the curve (PK / LS / HS / LP / HP)
- [x] Equal-loudness compensation: bass and treble by listening level (ISO 226, Lab)
- [ ] More crossfeed: Bauer bs2b preset, Chu Moy
- [ ] Convolution IR library: small rooms, studios, concert halls
- [ ] VST plug-in management (Equalizer APO supports VST2)

### 5. Interface and usability

- [x] Four panel skins (mixing desk, walnut, aluminium deck, graphite studio), light/dark, custom accent colour
- [x] Player page: turntable (ten vinyl colours, four decks), cassette, big VU, big cover, minimal; needle / LED / nixie meters
- [x] Setup wizard, feature-module switches, tutorial site with interactive demo
- [x] Ten palettes and a custom five-colour palette, panel textures, wallpapers (built-in and uploaded), theme export/import
- [x] Edit layout: drag panels, reorderable rail, custom pages with a widget catalogue, layout export/import
- [x] Setup wizard: speaker layout (headphones / 2.0 / 4.0) and look steps; tours and tutorial site cover the new features
- [x] Subwoofer layouts 2.1 / 2.2 / 4.1 / 4.2 with LR4 bass management and sub strips on the Room page
- [ ] Low-latency mode (drop convolution, keep IIR/PEQ), WAV filter export, sample-rate hint (planned)
- [x] Bilingual tutorial site and documentation (Traditional Chinese + English)
- [ ] Needle-style spectrum analyser, mini floating window
- [ ] Tray icon, media keys, global shortcuts
- [ ] English UI (i18n) — in progress

### 6. Making it usable for the open-source community

- [x] GitHub Actions: automatic release builds and tutorial-site deployment
- [x] Unit tests: DSP (deconvolution, FIR design) and the config generator; CI runs them
- [ ] Contribution guide, issue templates, a format for sharing measurement data
- [ ] Let the AutoEq and REW communities know it exists: introduce it with real measurements on Head-Fi, ASR and AVS

*Summary:* Fono Console aims to reach roughly 80% of a commercial room-correction suite on Windows, for free. Done: auto EQ (cuts only, multi-position), excess-phase FIR, subwoofer layouts with alignment, room diagnosis and seat heatmap, ART verification, time and level alignment, target-curve editor, mic calibration files, decay plots and RT60, look system, player styles, widgets and custom pages, speaker-layout onboarding. Next: automatic sub level matching, low-latency mode and filter export. Research: ART-style active modal decay cancellation. Planned: binaural headphone measurement and virtual speakers (Impulcifer method), and UI work.

---

<a id="繁體中文"></a>

## 繁體中文

目標：在 Windows 上做出開源、免費、裝好就能用的房間校正與聆聽工具。房間校正的核心能力要做到商業方案（例如 Dirac Live 加上 Active Room Treatment）的八成左右；量測、耳機、播放這些周邊則要做得比它們更完整。

### 1. 房間校正：與 Dirac Live 的對照

| 能力 | Dirac Live（含 ART） | Fono Console 目前 | 下一步 |
|---|---|---|---|
| 頻率響應校正 | 混合相位，多點量測 | ✅ 自動峰值濾波（只削峰），1／3／5／9／15 點平均，上限依施羅德頻率；ART 可編輯座位權重 | 自動 EQ 擬合也加入權重 |
| 相位／脈衝響應校正 | ✅ 混合相位 FIR | ✅ 超額相位 FIR（量測或分頻模型），各取樣率延遲一致；ART 可選預振鈴限制 | 多點平均的超額相位 |
| 時間與音量對齊 | ✅ | ✅ 抵達時間、極性、音量；四聲道 A／B 模式 | — |
| 目標曲線編輯 | ✅ 可拖曳 | ✅ 拖曳節點，預設：平直／房間曲線／暖／亮；自動 EQ 追著目標走 | Harman／B&K 預設；修正範圍分頻段權重 |
| 修正範圍設定 | ✅ | ⚠️ 自動決定 | 上下限可調 |
| 麥克風校正檔 | ✅ | ✅ 匯入 UMIK 類 `.txt` 校正檔（實驗室） | 依序號自動套用 |
| 多麥克風／多點同時錄 | — | ⚠️ 麥克風相對配對（實驗室）：兩支麥克風同點量同一顆喇叭，存差異曲線 | 立體聲輸入同時錄兩支麥克風 |
| 低頻多音箱協同（Bass Control） | 付費選項 | ⚠️ 重低音配置 2.1／2.2／4.1／4.2，LR4 低音管理與實測的重低音延遲／極性對齊（增益手動） | 重低音音量自動比對；用後方喇叭補低頻空洞 |
| 主動抵消駐波衰減（ART） | 付費選項，所有喇叭一起做 MIMO FIR | ✅ 實驗版：9／15 點引導量測、任意協助喇叭組合（後方一對或重低音）、自動正則化的最小平方 FIR、喇叭保護、可選預振鈴限制、驗證迴圈（實測對預測）；模擬 40–63 Hz 殘響縮短約 25–50% | 真實房間驗證資料；四聲道氛圍與 ART 並用 |
| 校正前後報告 | ✅ | ✅ 頻響曲線、衰減（EDT／T20／T30）與瀑布圖、ART 預估與驗證、依嚴重程度排序的房間診斷報告（可匯出 HTML） | 前後對照一頁匯出 |

**目前估計約 70%（含 ART 實驗版、目標曲線、衰減分析）；上表「下一步」做完約 80–85%**（ART 等級的主動抵消不算在內）。

### 2. 量測

- [x] 瀑布圖（CSD）
- [ ] 頻譜圖、步階響應、群延遲檢視
- [x] RT60／EDT／T20／T30（Schroeder 積分，每個倍頻帶）
- [x] 房間掃描匯入、平面圖、早期反射鏡像點、座位的房間模態（實驗室）
- [x] 房間診斷：依嚴重程度排序的白話問題清單與建議，可匯出 HTML 報告
- [x] 座位熱圖：平面圖上預測 30–120 Hz 起伏，圈出最佳區域，拖曳時即時更新
- [x] 重低音對齊：用實測算出重低音相對主喇叭的延遲與極性
- [x] ART 驗證迴圈：開著 ART 重量、實測對預測的殘響、誠實的結論
- [x] 無訊號防呆：量不到聲音就停下並說明原因
- [ ] 諧波失真：用對數掃頻的 Farina 方法，從脈衝響應前方分離出 2、3 次諧波
- [ ] 量測紀錄庫：存檔、命名、比較、匯出 REW 可讀的格式
- [ ] 一鍵驗證報告（可匯出圖片分享）

### 3. 麥克風與耳機量測

- [x] **麥克風相對配對**（實驗室）：兩支麥克風放在同一點、量同一顆喇叭，求出它們的差異曲線，之後自動補償。這只能讓它們「彼此一致」，絕對準確度仍要靠一支有校正檔的麥克風當基準。
- [ ] **耳機量測**：在耳道口放雙耳麥克風（自製教學另外寫），量左右耳的頻響，產生個人化的耳機校正，可與 AutoEq 結果比對。
- [ ] **虛擬喇叭**：用雙耳麥克風錄下房間裡每顆喇叭到兩耳的脈衝響應（BRIR），再補償耳機自身的響應，讓耳機聽起來像你的喇叭與房間。方法參考 [Impulcifer](https://github.com/jaakkopasanen/Impulcifer)（MIT），輸出給 Equalizer APO 做卷積。
- [ ] 自製雙耳麥克風、簡易人頭的圖文教學與零件清單

### 4. 聲音處理

- [ ] 參數 EQ 編輯器：在曲線上直接拖曳頻段（PK／LS／HS／LP／HP）
- [x] 等響度補償：依聆聽音量補低音、高音（ISO 226，實驗室）
- [ ] 更多交叉饋送：Bauer bs2b 預設、Chu Moy
- [ ] 卷積 IR 庫：小房間、錄音室、音樂廳
- [ ] VST 外掛管理（Equalizer APO 支援 VST2）

### 5. 介面與使用體驗

- [x] 四種面板（混音台、胡桃木、鋁面卡座、石墨錄音室）、深淺色、自選強調色
- [x] 播放頁：唱盤（十種黑膠顏色、四種唱盤）、卡帶、大型 VU 表、大封面、極簡；指針／LED／輝光管儀表
- [x] 設定精靈、功能模組開關、教學網站與互動示範
- [x] 十種配色與自訂五色、面板材質、桌布（內建與上傳）、主題匯出入
- [x] 編輯版面：拖曳面板、可排序的導覽列、自訂分頁與小工具目錄、版面匯出入
- [x] 設定精靈：喇叭配置（耳機／2.0／4.0）與外觀步驟；功能導覽與教學網站涵蓋新功能
- [x] 重低音配置 2.1／2.2／4.1／4.2，LR4 低音管理，房間頁有重低音聲道條
- [ ] 低延遲模式（略過卷積、保留 IIR／PEQ）、WAV 濾波器匯出、取樣率提示（規劃中）
- [ ] 指針式頻譜、迷你浮動視窗
- [ ] 系統匣圖示、媒體鍵、全域快捷鍵
- [x] 教學網站與文件中英雙語
- [ ] 英文介面（i18n）：進行中

### 6. 讓開源社群用得起來

- [x] GitHub Actions：自動建置 Release、部署教學網站
- [x] 單元測試：DSP（反卷積、FIR 設計）、設定檔產生器，CI 會執行
- [ ] 貢獻指南、問題範本、量測資料分享格式
- [ ] 讓 AutoEq、REW 社群的人知道它存在：在 Head-Fi、ASR、AVS 發表介紹與實測
