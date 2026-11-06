// Guided tours: the real Fono Console UI (with its simulated backend) runs in
// the iframe; each step moves a cursor to a control, highlights it and acts.
const $ = s => document.querySelector(s);
const frame = $('#demo'), screen = $('#screen'), cursor = $('#cursor'), ring = $('#ring');
const capStep = $('#capStep'), capText = $('#capText'), ctl = $('#tourCtl');

// ---------------------------------------------------------------- language
// zh-Hant / en. Choice: ?lang= > localStorage > navigator.language (zh* -> zh, else en).
const L = (zh, en) => ({ zh, en });
const UI = {
  zh: { title: 'Fono Console · 聲場控制台', pause: '暫停', replay: '重播', resume: '繼續', prep: '準備示範…', demo: '示範：', ended: '示範結束。這是真正的介面，你可以自己點點看。',
        live: '線上試玩 · 隨便點', play: '▶ 播放這段示範', need: '需要', time: '時間', tip: '小提醒', none: '不需要額外準備。', frameTitle: 'Fono Console 互動示範' },
  en: { title: 'Fono Console · Audio console for Windows', pause: 'Pause', replay: 'Replay', resume: 'Resume', prep: 'Preparing the demo…', demo: 'Demo: ', ended: 'Demo finished. This is the real interface, so feel free to click around.',
        live: 'Live demo · click anything', play: '▶ Play this demo', need: 'You need', time: 'Time', tip: 'Tip', none: 'Nothing extra to prepare.', frameTitle: 'Fono Console interactive demo' },
};
// English labels of app controls that steps match by text (the app shows Chinese or English; either matches).
const TEXT_EN = {"四聲道 A":"Quad A","房間矯正":"Room correction","15 點":"15","搜尋":"Search","唱盤":"Turntable","封面":"Cover","音樂廳":"Concert hall","自動防削波":"Auto anti-clipping","交叉饋送":"Crossfeed","胡桃木":"Walnut","鋁面":"Aluminium","石墨":"Graphite","混音台":"Mixing desk","紅":"Red","大理石":"Marble","卡帶":"Cassette","黑色":"Black","海軍藍":"Navy","奶油色":"Cream","皮革":"Leather","新增分頁":"Add page","迷你唱盤":"Mini turntable","時鐘":"Clock","便條":"Notes","完成":"Done","套用":"Apply","底噪":"Noise floor","模態":"modes","房間模態":"Room modes","房間診斷":"Room diagnosis","ART 低頻主動校正":"ART active bass correction","重低音收單聲道":"Subs take a mono sum","套用重低音對齊":"Apply sub alignment","自動正則化":"Automatic regularisation","限制預振鈴":"Limit pre-ringing","低頻起伏熱圖":"Bass unevenness heatmap","匯出報告":"Export report","2.2":"2.2","SW1":"SW1"};
function pickLang() {
  let q = null; try { q = new URLSearchParams(location.search).get('lang'); } catch {}
  if (q === 'en' || q === 'zh') return q;
  try { const v = localStorage.getItem('fono-guide-lang'); if (v === 'en' || v === 'zh') return v; } catch {}
  return /^zh/i.test(navigator.language || '') ? 'zh' : 'en';
}
let lang = pickLang();
const tx = o => (o && typeof o === 'object') ? o[lang] : o;
const ui = k => UI[lang][k];

// ---------------------------------------------------------------- content
const T = (sel, zh, en, o = {}) => ({ sel, say: L(zh, en), ...o });
const FLOWS = [
  { id: 'room', name: L('校正喇叭與房間', "Calibrate speakers and room"), time: L('約 15 分鐘', "about 15 minutes"),
    intro: L('量一次房間，Fono Console 會自動修掉駐波、對齊每顆喇叭的時間與音量。量測一定要用麥克風；示範裡只帶你看每個按鈕在哪。', "Measure the room once and Fono Console automatically tames standing waves and aligns every speaker's timing and level. Measuring needs a microphone; the demo only shows where each button is."),
    need: [L('一支麥克風（量測麥克風最好；接在同一張音效卡上）', "A microphone (a measurement mic is best; plug it into the same sound card)"), L('麥克風架或一疊書，放在聆聽位置、耳朵高度', "A mic stand or a stack of books, at the listening position and ear height"), L('安靜的房間：關冷氣、風扇', "A quiet room: switch off air conditioning and fans")],
    tip: L('只削峰、不補凹陷：凹陷是聲波互相抵銷，加再多能量也補不回來，只會讓擴大機削波。', "Cut peaks, never fill dips: a dip is waves cancelling each other, and adding more energy cannot fill it, it only makes the amplifier clip."),
    steps: [
      T('#rail button[data-page="settings"]', '先在「設定」打開設定精靈：它會安裝 Equalizer APO、讓你選音效卡、接管設定檔。', "First open the setup wizard in Settings: it installs Equalizer APO, lets you choose the sound card and takes over the config file.", { act: 'click' }),
      T('.setup-cta .btn.primary', '第一次開啟時精靈會自己跳出來；之後在這裡重開。', "On first launch the wizard opens by itself; afterwards reopen it here.", { act: 'click' }),
      T('.goal-grid .goal', '第一步選你想做的事，用不到的功能會先收起來。', "Step one is picking what you want to do; features you will not use are tucked away.", { wait: 3800 }),
      T('.modal-head .btn', '示範先關掉精靈。', "The demo closes the wizard for now.", { act: 'click' }),
      T('#rail button[data-page="measure"]', '到「量測」。', "Go to Measure.", { act: 'click' }),
      T('#wizBody select', '播放裝置選你的多聲道音效卡；量測麥克風選你插麥克風的那張卡。', "Pick your multichannel sound card as the playback device, and the card your microphone is plugged into as the measurement input.", {}),
      T('#wizBody .keys', '選要量的喇叭。四顆都量，才會一起算出前後的延遲。', "Choose which speakers to measure. Measure all four so front/rear delays can be worked out together."),
      T('#wizBody .knob', '掃頻音量預設 −12 dBFS；擴大機開到平常聽音樂偏大聲的位置。', "Sweep level defaults to −12 dBFS; set the amplifier to a level you would call fairly loud for music."),
      T('#wizBody .btn.primary', '按「開始一鍵校正」：每顆喇叭約 10 秒，請保持安靜。結果表會列出濾波器、駐波誤差、到達時間、建議延遲與音量，確認後按「套用」。', "Press \"Start one-click calibration\": about 10 seconds per speaker, so keep quiet. The result table lists filters, mode error, arrival time, suggested delay and level; press Apply when happy.", { wait: 5200 }),
      T('#page-measure .tab:nth-child(2)', '接著「FIR 相位」：把喇叭分頻器與低頻滾降造成的相位扭轉拉直。', "Next, \"FIR phase\": it straightens the phase twist caused by the speaker's crossover and bass roll-off.", { act: 'click' }),
      T('#firBody .knob:nth-child(3)', '分頻點照喇叭說明書填；倒相式喇叭低頻滾降多為 4 階。', "Enter the crossover frequency from the speaker manual; ported speakers usually roll off at 4th order."),
      T('#firBody .btn.primary', '按「建立並套用 FIR」，各取樣率的濾波器會一次做好。', "Press \"Build and apply FIR\": filters for every sample rate are generated at once.", { act: 'click', wait: 4200 }),
      T('#rail button[data-page="room"]', '最後在「房間」選聆聽模式。', "Finally, choose a listening mode in Room.", { act: 'click' }),
      T('.sel-label', '旋鈕轉到「四聲道 A」：後方喇叭晚一點、小一點，聲音更有空間感。', "Turn the knob to \"Quad A\": the rear speakers are a bit later and quieter, giving a more spacious sound.", { text: '四聲道 A', act: 'click' }),
      T('#rail button[data-page="play"]', '回到播放頁。', "Back to the Play page.", { act: 'click' }),
      T('.tgl', '「房間矯正」開關可以即時 A/B 比較，聽聽差在哪。', "The \"Room correction\" switch gives an instant A/B comparison so you can hear the difference.", { text: '房間矯正', act: 'click', wait: 3600 }),
    ] },
  { id: 'sub', name: L('重低音設定', "Subwoofer setup"), time: L('約 10 分鐘', "about 10 minutes"),
    intro: L('加一或兩顆重低音（2.1、2.2、4.1、4.2）：控制台用 LR4 分頻做低音管理，量測重低音後自動算出相對主喇叭的延遲與極性。音量不會自動調，要你用耳朵決定。示範用 2.2 配置與模擬臥室的量測。', "Add one or two subwoofers (2.1, 2.2, 4.1, 4.2): the console does bass management with an LR4 crossover, then measures the subs and works out their delay and polarity against the mains. The level is not set automatically; you decide it by ear. The demo uses a 2.2 layout and simulated bedroom measurements."),
    need: [L('多聲道音效卡，重低音接 LFE 輸出（第二顆預設接 C）；Windows 設成 5.1 或 7.1', "A multichannel sound card with the sub on the LFE output (the second one on C by default); Windows set to 5.1 or 7.1"), L('一支麥克風，放在聆聽位置、耳朵高度', "A microphone at the listening position, at ear height")],
    tip: L('延遲與極性是依實測算出的預測，不是保證：套用後再量一次，或看「房間診斷」裡「重低音與主喇叭銜接」那一項。分頻點預設 80 Hz，可在「房間」頁的「重低音」面板調整。', "Delay and polarity are predictions computed from your measurement, not a guarantee: measure again after applying, or check the \"Subwoofer and mains blend\" item in Room diagnosis. The crossover defaults to 80 Hz and can be changed in the Subwoofer panel on the Room page."),
    steps: [
      T('#rail button[data-page="settings"]', '先到「設定」，喇叭配置在這裡。', "First go to Settings, where the speaker layout lives.", { act: 'click' }),
      T('#layoutPanel .key', '選「2.2 加兩顆重低音」。2.1、4.1、4.2 的做法一樣；沒用到的功能會自動收起來。', "Choose \"2.2 with two subs\". 2.1, 4.1 and 4.2 work the same way, and features you do not use are tucked away.", { text: '2.2', act: 'click', wait: 3200 }),
      T('.align-grid .field', 'SW1 接音效卡的 LFE，SW2 預設接 C。接法不同就在「聲道對應」改。', "SW1 goes to the card's LFE and SW2 defaults to C. If your wiring differs, change it in Channel mapping.", { text: 'SW1', wait: 3600 }),
      T('#rail button[data-page="room"]', '到「房間」。', "Go to Room.", { act: 'click' }),
      T('.cstrip', '每顆重低音有自己的聲道條：增益、延遲、反相和校正，和其他喇叭一樣。', "Each sub has its own channel strip with gain, delay, polarity and correction, like the other speakers.", { text: 'SW1', wait: 3600 }),
      T('#subPanel .knob', '低音管理：主喇叭做 LR4 高通，重低音對左右的和做 LR4 低通。分頻點預設 80 Hz。', "Bass management: the mains get an LR4 high-pass and the subs an LR4 low-pass of the L+R sum. The crossover defaults to 80 Hz.", { wait: 3800 }),
      T('#subPanel .tgl', '2.2 才有的選項：兩顆重低音收同一個單聲道訊號；關掉則 SW1 收左、SW2 收右。', "A 2.2-only option: both subs take the same mono signal; switch it off and SW1 gets left, SW2 right.", { text: '重低音收單聲道', wait: 3800 }),
      T('#rail button[data-page="measure"]', '到「量測」，把重低音一起量。', "Go to Measure and measure the subs along with the rest.", { act: 'click' }),
      T('#wizBody .keys .key', '「要量的喇叭」現在包含 SW1、SW2。', "\"Speakers to measure\" now includes SW1 and SW2.", { text: 'SW1', wait: 3000 }),
      T('#wizDemoLoad', '示範：載入模擬臥室的量測，看結果。真實流程要接麥克風、按「開始一鍵校正」。', "Demo: load the simulated bedroom measurements to see the result. A real run needs a microphone and \"Start One-click\".", { act: 'click', wait: 6500 }),
      T('#subAlign', '「重低音對齊」：用實測的到達時間與相位，在 ±10 ms 內搜尋讓座位上加總最大的延遲與極性。', "\"Subwoofer alignment\": from the measured arrival time and phase, it searches ±10 ms for the delay and polarity that make the sum largest at the seat.", { wait: 5200 }),
      T('#subGraph', '亮線是套用對齊後的預測，灰線是延遲 0、正相。', "The bright line is the predicted result after alignment; the grey line is delay 0, normal polarity.", { wait: 4200 }),
      T('#wizBody .tgl', '「套用重低音對齊」預設開啟；增益不在裡面，仍然手動。', "\"Apply sub alignment\" is on by default; gain is not part of it and stays manual.", { text: '套用重低音對齊', wait: 3800 }),
      T('#wizBody .btn.primary.big', '按「套用」，延遲與極性寫進各聲道條。', "Press \"Apply\" and the delay and polarity are written to the channel strips.", { text: '套用', act: 'click', wait: 3000 }),
      T('#rail button[data-page="room"]', '回「房間」看結果。', "Back to Room to see the result.", { act: 'click' }),
      T('#subAlignInfo', '這裡記下上次自動對齊的結果。重低音音量請用「重低音增益」依耳朵調。', "The last auto alignment is recorded here. Set the level by ear with Sub gain.", { wait: 4200 }),
    ] },
  { id: 'art', name: L('ART 低頻主動校正', "ART active bass control"), time: L('約 25 分鐘（15 點量測）', "about 25 minutes (15-point measurement)"),
    intro: L('像 Dirac Live ART：量下各喇叭到你耳邊的低頻，解出每顆喇叭的濾波器，讓後方喇叭（或重低音）幫忙吸掉低頻駐波的殘響。套用後還有「驗證量測」，把實測和預測並排，誠實告訴你有沒有改善。示範用的是模擬臥室的量測資料。', "Like Dirac Live ART: measure the bass from each speaker to your ears and solve a filter for each, so the rear speakers (or the subwoofers) help absorb the ringing of low-frequency room modes. After applying, a verification measurement puts measured next to predicted and honestly tells you whether it helped. The demo uses simulated bedroom data."),
    need: [L('協助用的喇叭：後方一對，或重低音（2.1／2.2／4.1／4.2）', "Helper speakers: the rear pair, or subwoofers (2.1 / 2.2 / 4.1 / 4.2)"), L('一支麥克風＋捲尺（量 9 或 15 個點的位置）', "A microphone and a tape measure (to place the 9 or 15 points)"), L('量測期間室溫穩定、房間安靜、喇叭不要移動', "Stable room temperature, a quiet room and speakers that do not move during measurement"), L('擴大機要有餘裕：濾波器最多會推 +12 dB，控制台會自動降前級', "Amplifier headroom: filters can boost up to +12 dB, and the console lowers the preamp automatically")],
    tip: L('模擬數字不是保證：模擬臥室裡 40–63 Hz 的殘響約縮短 25–50%，真實房間差很多，請以「驗證量測」的結論為準。「室溫差 6 °C」那列比較接近日常；交接頻率太高（超過約 120 Hz）時室溫一變反而會變差，所以預設 120 Hz。', "Simulation numbers are not a promise: in the simulated bedroom, 40–63 Hz decay is shortened by about 25–50%, but real rooms differ a lot, so trust the verdict of the verification measurement. The \"6 °C temperature change\" row is closer to real life; with a crossover above about 120 Hz, a temperature change can make things worse, so the default is 120 Hz."),
    steps: [
      T('#rail button[data-page="settings"]', 'ART 是實驗功能，先在「功能模組」打開。', "ART is experimental; turn it on under Feature modules first.", { act: 'click' }),
      T('.feat-grid .tgl', '打開「ART 低頻主動校正」。', "Switch on \"ART active bass correction\".", { text: 'ART 低頻主動校正', act: 'click' }),
      T('#rail button[data-page="measure"]', '到「量測」。', "Go to Measure.", { act: 'click' }),
      T('#wizBody .keys .key', '一鍵校正的位置數選 15 點：精靈會顯示 3 × 5 位置圖，亮起的是下一個位置（頭的位置、前後左右 25 cm、上下 15 cm）。每點量完做品質檢查，不好可以只「重量這一點」。', "Choose 15 positions for one-click calibration: the wizard shows a 3 × 5 position map with the next position lit (head position, 25 cm front/back and left/right, 15 cm up/down). Each point gets a quality check, and a bad one can be redone alone with \"Redo this point\".", { text: '15 點', act: 'click', wait: 6200 }),
      T('#page-measure .tab', '量完所有喇叭後，到「ART 低頻」分頁。', "After measuring all the speakers, open the \"ART bass\" tab.", { text: 'ART', act: 'click' }),
      T('#artExplain summary', '先看「這是什麼？」：它做什麼、需要什麼、預期效果、限制，以及如何還原。', "Start with \"What is this?\": what it does, what you need, what to expect, the limits and how to undo it.", { act: 'click', wait: 4200 }),
      T('#artDemoLoad', '示範：載入模擬臥室（3.6 × 3.0 × 2.6 m）的 15 點量測。', "Demo: load a simulated bedroom (3.6 × 3.0 × 2.6 m) 15-point measurement.", { act: 'click', wait: 2400 }),
      T('#artBody .knob', '交接頻率以下由參與的喇叭一起處理；最大推力決定能抵消多少。', "Below the handover frequency the taking-part speakers work together; the max push sets how much can be cancelled."),
      T('#artBody .tgl', '「自動正則化」：每個頻帶用交叉驗證挑濾波器的平緩程度，不用自己猜。「保護喇叭」在單體撐不住的頻率不加大推力。', "\"Automatic regularisation\" picks how smooth the filter is per band by cross-validation, so you need not guess. \"Protect the speakers\" adds no drive where a driver cannot cope.", { text: '自動正則化', wait: 5200 }),
      T('#artBody .tgl', '「限制預振鈴」預設關閉：打開後把主波峰之前的能量壓到 −30 dB 以下。', "\"Limit pre-ringing\" is off by default: switched on, it keeps the energy before the main peak below −30 dB.", { text: '限制預振鈴', wait: 4200 }),
      T('.art-weights summary', '位置權重：預設中間重、外圍輕，可以逐點修改。', "Position weights: heavier in the centre by default, and you can edit each point.", { act: 'click', wait: 4200 }),
      T('#artBody .btn.primary', '按「計算」。', "Press \"Calculate\".", { act: 'click', wait: 2600 }),
      T('.art-table', '預估結果：每個低頻頻段的殘響時間。綠色是改善、紅色是變差；「室溫差 6 °C」那列最接近日常。這是預測，不是保證。', "Predicted result: decay time per bass band. Green is better, red is worse; the \"6 °C temperature change\" row is closest to everyday use. This is a prediction, not a promise.", { wait: 6200 }),
      T('#artDetail', '自動挑出的 λ 與推力上限，以及「需要的前級衰減」：控制台會自動降前級，確保不削波。', "The automatically chosen λ and drive limits, and the \"preamp attenuation needed\": the console lowers the preamp automatically so nothing clips.", { wait: 5600 }),
      T('#artBody .btn.primary', '按「套用 ART」：濾波器寫進 Equalizer APO，模式切到「ART 低頻」。', "Press \"Apply ART\": the filters are written to Equalizer APO and the mode switches to \"ART bass\".", { text: '套用', act: 'click', wait: 3800 }),
      T('#artVerify', '最後一步是「驗證量測」：在 ART 開啟的狀態下回到前幾個位置再量，用實測和預測比較。', "The last step is the verification measurement: with ART on, go back to the first few positions and measure again to compare measured with predicted.", { wait: 4800 }),
      T('#artVerifyBtn', '按「驗證量測」。真實流程會請你把麥克風放回第 N 點；示範沒有麥克風，結果是模擬的。', "Press \"Verification measurement\". A real run asks you to put the microphone back at point N; the demo has no microphone, so its result is simulated.", { act: 'click', wait: 7000 }),
      T('#artVerdict', '結論只有三種：有改善、沒有明顯變化、變差了，並附上改善建議。模擬結果會標「模擬」。', "The verdict is one of three: improved, no clear change or worse, with suggestions on what to try. A simulated result is tagged \"Simulated\".", { wait: 6200 }),
      T('#rail button[data-page="room"]', '在「房間」可以隨時切回其他模式比較，或在結論不好時直接關掉 ART。', "In Room you can switch back to other modes at any time to compare, or turn ART off if the verdict is poor.", { act: 'click' }),
      T('.sel-label', '目前是「ART 低頻」模式。', "The mode is now \"ART bass\".", { text: 'ART', wait: 3200 }),
    ] },
  { id: 'diagnose', name: L('房間診斷', "Room diagnosis"), time: L('約 5 分鐘', "about 5 minutes"),
    intro: L('把量測結果變成一份依嚴重程度排序的白話清單，每一項都附上具體做法，還能匯出報告。下方的熱圖預測座位附近哪裡的低頻最平均。全部是固定規則，不是模型猜的。', "Turns the measurements into a plain-language list ranked by severity, each item with a concrete action, and you can export a report. The heatmap below predicts where the bass is most even around the seat. Everything is a fixed rule, not a model's guess."),
    need: [L('做過一次「一鍵校正」會有最完整的清單（沒量測時只有依房間尺寸算出的項目）', "A One-click run gives the fullest list (without measurements you only get the items computed from the room size)"), L('房間尺寸與座位位置要輸入正確，熱圖才有意義', "Enter the room size and seat position correctly or the heatmap means little")],
    tip: L('座位移動的建議是模態模型的預測，不是量測值：搬完請再量一次。熱圖只看 30–120 Hz，不代表高頻或反射。', "Seat-move suggestions are predictions of the room-mode model, not measurements: measure again after moving. The heatmap covers only 30–120 Hz and says nothing about the treble or reflections."),
    steps: [
      T('#rail button[data-page="measure"]', '到「量測」。', "Go to Measure.", { act: 'click' }),
      T('#wizDemoLoad', '示範：先載入模擬臥室的量測，清單才有完整的項目。', "Demo: load the simulated bedroom measurements first so the list has the full set of items.", { act: 'click', wait: 5000 }),
      T('#page-measure .tab', '切到「房間診斷」分頁。', "Open the \"Room diagnosis\" tab.", { text: '房間診斷', act: 'click', wait: 3200 }),
      T('.diag-sum', '上方統計各嚴重程度的數量：嚴重、中等、輕微、正常。', "The chips on top count the items by severity: severe, moderate, minor and normal.", { wait: 3800 }),
      T('.diag-item .act', '每一項都有白話說明和「建議」：具體要做什麼，例如移動座位、加延遲、在反射點貼吸音板。', "Every item has a plain explanation and a \"Suggestion\" saying exactly what to do: move the seat, add delay, put an absorber on a reflection point.", { wait: 6200 }),
      T('#diagPanel .btn', '「匯出報告 (HTML)」存成一個獨立的網頁檔，可以分享或列印成 PDF。', "\"Export report (HTML)\" saves a self-contained web page you can share or print to PDF.", { text: '匯出報告', wait: 4200 }),
      T('#heatPanel canvas', '座位低頻熱圖：顏色越暖，30–120 Hz 的起伏越大；亮色框是最佳區域，黑點是現在的座位。', "Seat bass heatmap: the warmer the colour, the larger the 30–120 Hz unevenness; the bright outline is the best area and the black dot is your current seat.", { wait: 6200 }),
      T('.heat-read', '拖曳「耳」可以即時看到數值；拖曳喇叭會重算整張圖。', "Drag \"Ear\" to see the numbers change live; dragging a speaker recomputes the whole map.", { wait: 4800 }),
      T('#heatPanel .tgl', '不需要時可以關掉熱圖。', "Switch the heatmap off when you do not need it.", { text: '低頻起伏熱圖', wait: 3200 }),
    ] },
  { id: 'headphones', name: L('耳機調音', "Headphone tuning"), time: L('約 3 分鐘', "about 3 minutes"),
    intro: L('每支耳機一組設定，Windows 切換到哪支就自動套用。AutoEq 資料庫收錄數千款耳機的量測校正。', "One profile per headphone, applied automatically whichever one Windows switches to. The AutoEq database holds measured corrections for thousands of models."),
    need: [L('耳機（有線、藍牙、USB 耳擴都可以）', "Headphones (wired, Bluetooth or a USB amp all work)"), L('在 Equalizer APO 的 Device Selector 勾選這個輸出並重開機一次', "Tick this output in Equalizer APO's Device Selector and reboot once")],
    tip: L('藍牙耳機一開麥克風就變單聲道低音質？那是免持模式，不用耳機麥克風的話可以在這頁停用。', "Does Bluetooth drop to mono, low quality when a microphone opens? That is hands-free mode; if you do not use the headset mic, disable it on this page."),
    steps: [
      T('#rail button[data-page="hp"]', '到「耳機」。', "Go to Headphones.", { act: 'click' }),
      T('.hp-dev', '左邊是目前連接的輸出裝置；選你的耳機。', "On the left are the output devices currently connected; pick your headphones.", { text: 'Wireless', act: 'click' }),
      T('#hpEditor input[type=text]', '輸入耳機型號搜尋 AutoEq。', "Type your headphone model to search AutoEq.", { act: 'type', value: 'Wireless' }),
      T('#hpEditor .btn', '按「搜尋」。', "Press \"Search\".", { text: '搜尋', act: 'click', wait: 2200 }),
      T('.ae-hit', '點你的型號：頻響校正立刻套用，曲線會畫在下面。', "Click your model: the correction is applied immediately and its curve is drawn below.", { act: 'click', wait: 3200 }),
      T('#hpCurve', '這條就是校正曲線。低音、高音旋鈕可以再依喜好微調。', "This is the correction curve. The bass and treble knobs let you fine-tune it to taste."),
      T('.tgl', '交叉饋送：把一點對側聲道混進來，聲像從腦中移到前方，久聽不累。', "Crossfeed: mixes in a little of the opposite channel, moving the image from inside your head to the front and reducing listening fatigue.", { text: '交叉饋送', act: 'click', wait: 3400 }),
      T('#hpBT', '藍牙耳機顯示電量；已配對但沒連線的收在下方。', "Bluetooth headphones show their battery level; paired but disconnected ones are listed below."),
      T('.hp-dev', '立體聲 DAC 也能接耳機：選它，上方會有「喇叭／耳機」切換。', "A stereo DAC can drive headphones too: select it and a Speakers / Headphones switch appears on top.", { text: 'Stereo DAC', act: 'click' }),
      T('.hp-load', '插耳機聽時切到「耳機」，DAC 就改用耳機設定；換回喇叭時切回來。', "When you listen on headphones switch to \"Headphones\" and the DAC uses the headphone profile; switch back when you return to speakers.", { wait: 4200 }),
    ] },
  { id: 'library', name: L('Spotify／YouTube Music 曲庫', "Spotify / YouTube Music library"), time: L('約 5 分鐘（第一次）', "about 5 minutes (first time)"),
    intro: L('兩個服務一起搜尋，專輯與歌單排成唱片架。播放前會先暫停另一個播放器，切換來源不會兩邊一起響。', "Both services are searched together, with albums and playlists laid out on a record shelf. The other player is paused before playback, so switching source never plays both at once."),
    need: [L('Spotify：Premium 帳號＋自己的開發者 App（精靈會帶你建立，約 3 分鐘）', "Spotify: a Premium account plus your own developer app (the wizard guides you, about 3 minutes)"), L('YouTube Music：開源的桌面版，精靈會下載安裝並比對雜湊', "YouTube Music: the open-source desktop app, which the wizard downloads, installs and hash-checks")],
    tip: L('Spotify 開發模式只能讀你自己建立或協作的歌單曲目，搜尋一次最多 10 筆；這是 Spotify 2026 年的規定。', "In development mode Spotify only lets you read tracks of playlists you created or collaborate on, and a search returns at most 10 results; these are Spotify's 2026 rules."),
    steps: [
      T('#rail button[data-page="lib"]', '到「曲庫」。', "Go to Library.", { act: 'click' }),
      T('.lib-q', '輸入想聽的東西。', "Type what you want to hear.", { act: 'type', value: 'bach' }),
      T('.lib-search .btn', '搜尋。', "Search.", { act: 'click', wait: 2000 }),
      T('.sleeve-card', '點一張唱片封套。', "Click a record sleeve.", { act: 'click', wait: 2600 }),
      T('.op-tracks li', '唱片滑出、曲目展開；點任何一首從那首開始播。', "The record slides out and its tracks unfold; click any track to start playing from there.", { act: 'click', wait: 2600 }),
      T('#rail button[data-page="play"]', '回到播放頁看看。', "Back to the Play page.", { act: 'click' }),
      T('.play-layout .key', '播放頁可以換成大型 VU 表……', "The Play page can switch to a big VU meter...", { text: 'VU', act: 'click', wait: 3200 }),
      T('.play-layout .key', '……或大封面。', "...or a big cover.", { text: '封面', act: 'click', wait: 3000 }),
      T('.play-layout .key', '唱盤是預設樣式。', "The turntable is the default style.", { text: '唱盤', act: 'click' }),
    ] },
  { id: 'effects', name: L('音效與混響', "Effects and reverb"), time: L('1 分鐘', "1 minute"),
    intro: L('像 FxSound 一樣調音色，但全部寫進 Equalizer APO，不經過額外驅動，任何播放器都吃得到；開啟自動防削波就不怕破音。', "Shape the tone as FxSound does, but everything is written into Equalizer APO with no extra driver, so every player is covered. Turn on auto anti-clip and you need not fear distortion."),
    need: [],
    tip: L('旋鈕與推桿都是上下拖曳；按住 Shift 微調，雙擊歸零，滾輪也可以。', "Knobs and faders drag up and down; hold Shift for fine steps, double-click to reset, or use the scroll wheel."),
    steps: [
      T('#rail button[data-page="fx"]', '到「音效」。', "Go to Effects.", { act: 'click' }),
      T('#page-fx .presets .key', '先挑一個預設當起點。', "Pick a preset as a starting point.", { text: '音樂廳', act: 'click', wait: 2600 }),
      T('#page-fx .knob', '旋鈕：前級、低音、臨場、高音、寬度、平衡。', "Knobs: pre-amp, bass, presence, treble, width, balance."),
      T('#page-fx .fader:nth-child(3)', '十段等化器，曲線會即時畫在上方。', "A ten-band equaliser; the curve is drawn above in real time."),
      T('#revPanel .tgl', '空間混響：用卷積產生音樂廳般的殘響，可以載入自己的 IR。', "Room reverb: convolution gives concert-hall ambience, and you can load your own IR.", { act: 'click', wait: 3000 }),
      T('#page-fx .tgl', '「自動防削波」會依 EQ 提升量自動降低前級。', "\"Auto anti-clip\" lowers the pre-amp automatically according to the EQ boost.", { text: '自動防削波' }),
    ] },
  { id: 'look', name: L('外觀與配色', "Look and palette"), time: L('2 分鐘', "2 minutes"),
    intro: L('四種面板、深淺色、自選強調色；播放頁有唱盤、大型 VU 表、大封面、卡帶與極簡五種樣式，黑膠有十種顏色，卡帶可換外殼。視窗標題列也會跟著配色。', "Four panel skins, light/dark and your own accent colour. The Play page has five styles (turntable, big VU, big cover, cassette, minimal), vinyl comes in ten colours and the cassette shell can change. The window title bar follows the palette too."),
    need: [],
    tip: L('強調色可以挑預設色票，也可以用色盤選任何顏色。黑膠「依封面」會從專輯封面取色。更多配色、材質與桌布見「自訂外觀與版面」。', "Pick an accent from the swatches or any colour from the colour picker. The \"from cover\" vinyl takes its colour from the album art. More palettes, textures and wallpapers are in \"Custom look and layout\"."),
    steps: [
      T('#rail button[data-page="settings"]', '到「設定」。', "Go to Settings.", { act: 'click' }),
      T('.skin-card', '胡桃木 Hi-Fi：木紋側板、黃銅指示。', "Walnut Hi-Fi: wood side panels and brass indicators.", { text: '胡桃木', act: 'click', wait: 3000 }),
      T('.skin-card', '鋁面卡座：髮絲紋鋁板、琥珀燈。', "Aluminium deck: brushed aluminium and amber lamps.", { text: '鋁面', act: 'click', wait: 3000 }),
      T('.skin-card', '石墨錄音室：安靜、扁平。', "Graphite studio: quiet and flat.", { text: '石墨', act: 'click', wait: 3000 }),
      T('.accent-dot:nth-child(5)', '換一個強調色。', "Change the accent colour.", { act: 'click', wait: 2600 }),
      T('#themeSwitch', '日夜切換。', "Day/night switch.", { act: 'click', wait: 3000 }),
      T('#themeSwitch', '再切回來。', "Switch back.", { act: 'click' }),
      T('.skin-card', '回到預設的混音台。', "Back to the default mixing desk.", { text: '混音台', act: 'click' }),
      T('.vc-sw', '唱盤的黑膠有十種顏色：先選紅色。', "The turntable's vinyl comes in ten colours: start with red.", { text: '紅', act: 'click' }),
      T('.vc-sw', '大理石紋也有。', "Marble effects are available too.", { text: '大理石', act: 'click' }),
      T('#rail button[data-page="play"]', '回到播放頁看唱片。', "Back to the Play page to see the record.", { act: 'click' }),
      T('.play-layout .key', '播放頁樣式選「卡帶」：卡帶機的捲軸會跟著播放轉動。', "Choose \"Cassette\" as the player style: the deck's reels turn as the music plays.", { text: '卡帶', act: 'click', wait: 3600 }),
      T('#rail button[data-page="settings"]', '再回設定。', "Back to Settings.", { act: 'click' }),
      T('.field .keys .key', '卡帶外殼可以選透明、黑色、白色，或依封面取色。', "Cassette shells can be clear, black, white, or take their colour from the cover.", { text: '黑色', act: 'click' }),
      T('#rail button[data-page="play"]', '看看黑色外殼的卡帶。', "Look at the cassette with the black shell.", { act: 'click', wait: 2800 }),
      T('.play-layout .key', '最後換回唱盤。', "Finally, switch back to the turntable.", { text: '唱盤', act: 'click' }),
    ] },
  { id: 'custom', name: L('自訂外觀與版面', "Custom look and layout"), time: L('約 3 分鐘', "about 3 minutes"),
    intro: L('配色、面板材質、桌布都能自己搭；「編輯版面」可以拖曳面板、重排導覽列，還能新增自己的分頁，放進喜歡的小工具。', "Mix your own palette, panel texture and wallpaper; \"Edit layout\" lets you drag panels, reorder the rail and add custom pages filled with the widgets you like."),
    need: [],
    tip: L('版面與主題都能匯出成檔案分享：主題在「設定 → 外觀」，版面在「設定 → 版面與小工具」。「還原導覽列」「還原預設版面」隨時可以回到出廠狀態。', "Layouts and themes can be exported to files to share: themes under Settings → Appearance, layouts under Settings → Layout & widgets. \"Reset rail\" and \"Reset default layout\" always bring back the factory state."),
    steps: [
      T('#rail button[data-page="settings"]', '到「設定」，往下就是外觀。', "Go to Settings; Appearance is further down.", { act: 'click' }),
      T('.pal-grid .skin-card', '配色：十種預設加一組自訂（可自己選五個顏色）。先選海軍藍。', "Palettes: ten presets plus one custom set (pick five colours yourself). Start with navy.", { text: '海軍藍', act: 'click', wait: 3000 }),
      T('.pal-grid .skin-card', '換成奶油色收音機。', "Now the cream radio.", { text: '奶油色', act: 'click', wait: 2600 }),
      T('.tex-card', '材質：面板、側欄與頂欄的表面紋理，有木紋、皮革、毛氈、碳纖維等。', "Textures: surface grain for panels, side rail and top bar, such as wood, leather, felt and carbon fibre.", { text: '皮革', act: 'click', wait: 3000 }),
      T('.wall-th:nth-child(3) .wall-pick', '桌布：內建的像素與版畫風景，也可以上傳自己的圖。', "Wallpapers: built-in pixel-art and woodblock landscapes, or upload your own picture.", { act: 'click', wait: 3200 }),
      T('.look-sliders input', '壓暗、模糊與面板透明度可以調，讓桌布不搶畫面。', "Dim, blur and panel transparency are adjustable so the wallpaper never competes with the controls.", {}),
      T('#editBtn', '按右上角「編輯版面」。', "Press \"Edit layout\" at the top right.", { act: 'click' }),
      T('#rail .rl-foot .btn', '編輯版面時，導覽列下方出現「新增分頁」。按一下就多一個自訂分頁。', "While editing, \"Add page\" appears under the rail. One press adds a custom page.", { text: '新增分頁', act: 'click', wait: 2400 }),
      T('.dg-empty .btn.primary', '空白分頁：按「新增小工具」。', "Empty page: press \"Add widget\".", { act: 'click' }),
      T('.dw-modal .cat-card', '目錄分成播放、時間、工具、便條。先放一個迷你唱盤。', "The catalogue is split into Playback, Time, Tools and Notes. Start with a mini turntable.", { text: '迷你唱盤', act: 'click', wait: 2000 }),
      T('.dl-dock .dk-add', '再加一個。', "Add another.", { act: 'click' }),
      T('.dw-modal .cat-card', '時鐘。', "A clock.", { text: '時鐘', act: 'click', wait: 2000 }),
      T('.dl-dock .dk-add', '再加一個。', "One more.", { act: 'click' }),
      T('.dw-modal .cat-card', '便條：寫點備忘，自動儲存。', "Notes: jot down reminders; they save automatically.", { text: '便條', act: 'click', wait: 2000 }),
      T('.page.custom.on .dw .dw-grip', '拖曳標題列移動小工具，右下角拖曳可以縮放。', "Drag the title bar to move a widget; drag the bottom-right corner to resize.", { wait: 3200 }),
      T('.dl-dock .btn.primary', '完成編輯。', "Finish editing.", { text: '完成', act: 'click', wait: 2400 }),
      T('#rail button[data-page="settings"]', '回到設定。', "Back to Settings.", { act: 'click' }),
      T('#layoutPanel .key', '沒有後方喇叭？「喇叭配置」改成 2.0 或只有耳機，用不到的頁面與按鍵會自動收起來。', "No rear speakers? Change \"Speaker layout\" to 2.0 or headphones only, and pages and keys you do not use are tucked away automatically.", { text: '2.0', act: 'click', wait: 3600 }),
      T('#layoutPanel .key', '改回 4.0。', "Switch back to 4.0.", { text: '4.0', act: 'click' }),
    ] },
  { id: 'advanced', name: L('進階量測工具', "Advanced measurement tools"), time: L('視需要', "as needed"),
    intro: L('REW 連動、麥克風底噪、房間模態計算預設是收起來的，在「功能模組」打開。', "The REW link, mic noise floor and room-mode calculator are hidden by default; turn them on under Feature modules."),
    need: [L('REW 5.20.14 以上（選用，免費但不可轉發，請從官方網站下載）', "REW 5.20.14 or later (optional; free but not redistributable, download it from the official site)")],
    tip: L('在 REW 的 Preferences → API 勾 Start server，Fono Console 就能讀取量測並把 REW 算好的濾波器指派到任一聲道。', "In REW tick Preferences → API → Start server, and Fono Console can read measurements and assign REW-computed filters to any channel."),
    steps: [
      T('#rail button[data-page="settings"]', '到「設定」。', "Go to Settings.", { act: 'click' }),
      T('.feat-grid .tgl', '打開 REW 連動。', "Turn on the REW link.", { text: 'REW', act: 'click' }),
      T('.feat-grid .tgl', '打開麥克風底噪。', "Turn on the mic noise floor.", { text: '底噪', act: 'click' }),
      T('.feat-grid .tgl', '打開房間模態計算。', "Turn on the room-mode calculator.", { text: '模態', act: 'click' }),
      T('#rail button[data-page="measure"]', '「量測」多出三個分頁。', "Measure now has three more tabs.", { act: 'click' }),
      T('#page-measure .tab', '房間模態：輸入房間長寬高，算出會轟的頻率。', "Room modes: enter the room's length, width and height to find the frequencies that will boom.", { text: '房間模態', act: 'click', wait: 3600 }),
    ] },
];

// ---------------------------------------------------------------- tour engine
const R = { flow: null, i: -1, playing: false, timer: 0, token: 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const doc = () => frame.contentDocument;
function fit() { const s = screen.clientWidth / 1280; frame.style.transform = `scale(${s})`; return s; }
addEventListener('resize', fit); fit();

function find(step) {
  const d = doc(); if (!d) return null;
  let list = [...d.querySelectorAll(step.sel)].filter(e => e.getClientRects().length);
  if (step.text) { const a = step.text.toLowerCase(), b = (TEXT_EN[step.text] || '').toLowerCase();
    list = list.filter(e => { const t = e.textContent.toLowerCase(); return t.includes(a) || (b && t.includes(b)); }); }
  return list[0] || null;
}
function place(el) {
  const s = fit(), r = el.getBoundingClientRect(), pad = 5;
  Object.assign(ring.style, { left: (r.left * s - pad) + 'px', top: (r.top * s - pad) + 'px', width: (r.width * s + pad * 2) + 'px', height: (r.height * s + pad * 2) + 'px' });
  ring.classList.add('on');
  Object.assign(cursor.style, { left: ((r.left + r.width * 0.55) * s) + 'px', top: ((r.top + r.height * 0.6) * s) + 'px' });
  cursor.classList.add('on');
}
async function reset() {
  try { frame.contentWindow.sessionStorage.removeItem('fono-demo-state'); } catch {}
  await new Promise(res => { frame.addEventListener('load', res, { once: true }); frame.contentWindow.location.reload(); });
  await sleep(1300);
}
async function runStep(i, token) {
  const f = R.flow, st = f.steps[i];
  R.i = i;
  document.querySelectorAll('#guide ol.steps > li').forEach((li, k) => li.classList.toggle('cur', k === i));
  capStep.textContent = `${tx(f.name)} · ${i + 1}/${f.steps.length}`;
  capText.textContent = tx(st.say);
  let el = null;
  for (let k = 0; k < 20 && !(el = find(st)); k++) await sleep(150);
  if (token !== R.token) return;
  if (!el) { (window.__guideMiss = window.__guideMiss || []).push(`${f.id}#${i + 1} ${st.sel}${st.text ? ' [' + st.text + ']' : ''}`); ring.classList.remove('on'); return; }
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  await sleep(250);
  place(el);
  await sleep(850);
  if (token !== R.token) return;
  if (st.act === 'click') {
    cursor.classList.add('press'); await sleep(140); cursor.classList.remove('press');
    el.click();
  } else if (st.act === 'type') {
    el.focus(); el.value = '';
    for (const ch of st.value) { el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(90); }
  }
}
async function play(from = 0) {
  const token = ++R.token;
  R.playing = true; $('#tPlay').textContent = ui('pause');
  for (let i = from; i < R.flow.steps.length; i++) {
    await runStep(i, token);
    if (token !== R.token) return;
    const st = R.flow.steps[i];
    await sleep(st.wait || Math.max(2400, tx(st.say).length * (lang === 'zh' ? 85 : 55)));
    if (token !== R.token || !R.playing) return;
  }
  R.playing = false; $('#tPlay').textContent = ui('replay');
}
async function startFlow(id, at = 0) {
  R.flow = FLOWS.find(f => f.id === id) || FLOWS[0];
  ctl.hidden = false;
  $('#deviceTitle').textContent = ui('demo') + tx(R.flow.name);
  const token = ++R.token;
  capStep.textContent = tx(R.flow.name); capText.textContent = ui('prep');
  ring.classList.remove('on');
  await reset();
  if (token !== R.token) return;
  // replay earlier steps silently so a step in the middle starts from the right screen
  for (let i = 0; i < at; i++) { const st = R.flow.steps[i], el = find(st); if (el && st.act === 'click') { el.click(); await sleep(350); } if (el && st.act === 'type') { el.value = st.value; el.dispatchEvent(new Event('input', { bubbles: true })); } }
  play(at);
}
function stop() { R.token++; R.playing = false; ring.classList.remove('on'); cursor.classList.remove('on'); ctl.hidden = true;
  capStep.textContent = ''; capText.textContent = ui('ended'); $('#deviceTitle').textContent = ui('live');
  document.querySelectorAll('#guide ol.steps > li').forEach(li => li.classList.remove('cur')); }
$('#tPrev').onclick = () => { if (R.flow) startFlow(R.flow.id, Math.max(0, R.i - 1)); };
$('#tNext').onclick = () => { if (R.flow && R.i < R.flow.steps.length - 1) { R.playing = false; R.token++; const t = R.token; runStep(R.i + 1, t); $('#tPlay').textContent = ui('resume'); } };
$('#tPlay').onclick = () => { if (!R.flow) return; if (R.playing) { R.playing = false; R.token++; $('#tPlay').textContent = ui('resume'); } else if (R.i >= R.flow.steps.length - 1) startFlow(R.flow.id); else play(R.i + 1); };
$('#tStop').onclick = stop;

// ---------------------------------------------------------------- guide section
let guideId = null;
function renderGuide(id) {
  const f = FLOWS.find(x => x.id === id) || FLOWS[0];
  document.querySelectorAll('#goalTabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.id === f.id)));
  const g = $('#guide');
  guideId = f.id;
  g.innerHTML = `<div><h3>${tx(f.name)}</h3><p class="intro">${tx(f.intro)}</p>
    <p><button class="btn primary small" type="button" id="playFlow">${ui('play')}</button></p>
    <ol class="steps">${f.steps.map(s => `<li>${tx(s.say)}</li>`).join('')}</ol></div>
    <aside><h4>${ui('need')}</h4>${f.need.length ? `<ul>${f.need.map(n => `<li>${tx(n)}</li>`).join('')}</ul>` : `<p>${ui('none')}</p>`}
    <h4>${ui('time')}</h4><p>${tx(f.time)}</p><h4>${ui('tip')}</h4><p>${tx(f.tip)}</p></aside>`;
  $('#playFlow').onclick = () => { document.getElementById('device').scrollIntoView({ behavior: 'smooth', block: 'center' }); startFlow(f.id); };
  g.querySelectorAll('ol.steps > li').forEach((li, k) => li.onclick = () => { document.getElementById('device').scrollIntoView({ behavior: 'smooth', block: 'center' }); startFlow(f.id, k); });
}
const tabs = $('#goalTabs');
const tabBtns = [];
FLOWS.forEach(f => { const b = document.createElement('button'); b.type = 'button'; b.role = 'tab'; b.dataset.id = f.id; b.textContent = tx(f.name); b.onclick = () => { history.replaceState(null, '', '#' + f.id); renderGuide(f.id); }; tabs.append(b); tabBtns.push([f, b]); });
document.querySelectorAll('[data-tour]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); renderGuide(a.dataset.tour); document.getElementById('device').scrollIntoView({ behavior: 'smooth', block: 'center' }); startFlow(a.dataset.tour); }));
const hashFlow = FLOWS.find(f => '#' + f.id === location.hash);
renderGuide(hashFlow ? hashFlow.id : 'room');
if (hashFlow) frame.addEventListener('load', () => { document.getElementById('guides').scrollIntoView(); startFlow(hashFlow.id); }, { once: true });

// ---------------------------------------------------------------- light / dark
const modeBtn = $('#modeBtn');
const sysDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
function setMode(m) {
  document.documentElement.dataset.mode = m;
  try { localStorage.setItem('fono-guide-mode', m); } catch {}
  try { const st = JSON.parse(frame.contentWindow.sessionStorage.getItem('fono-demo-state') || 'null'); frame.contentDocument.documentElement.dataset.theme = m; if (st) { st.theme = m; } } catch {}
}
let saved = null; try { saved = localStorage.getItem('fono-guide-mode'); } catch {}
document.documentElement.dataset.mode = saved || (sysDark() ? 'dark' : 'light');
modeBtn.onclick = () => setMode(document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark');
frame.addEventListener('load', () => { try { frame.contentDocument.documentElement.dataset.theme = document.documentElement.dataset.mode; } catch {} });

// ---------------------------------------------------------------- language switch
const demoSrc = () => 'app/?demo&lang=' + lang;
function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.title = ui('title');
  document.querySelectorAll('[data-en]').forEach(el => {
    if (el.dataset.zh === undefined) el.dataset.zh = el.innerHTML;
    el.innerHTML = lang === 'en' ? el.dataset.en : el.dataset.zh;
  });
  for (const [attr, set] of [['data-en-aria-label', 'aria-label'], ['data-en-title', 'title'], ['data-en-content', 'content']]) {
    document.querySelectorAll('[' + attr + ']').forEach(el => {
      const k = 'zhAttr' + set.replace('-', '');
      if (el.dataset[k] === undefined) el.dataset[k] = el.getAttribute(set) || '';
      el.setAttribute(set, lang === 'en' ? el.getAttribute(attr) : el.dataset[k]);
    });
  }
  document.querySelectorAll('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
  tabBtns.forEach(([f, b]) => { b.textContent = tx(f.name); });
  renderGuide(guideId || 'room');
  $('#tPlay').textContent = ui('pause');
}
function setLang(l) {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem('fono-guide-lang', l); } catch {}
  try { const u = new URL(location.href); if (u.searchParams.has('lang')) { u.searchParams.set('lang', l); history.replaceState(null, '', u); } } catch {}
  stop(); R.flow = null; R.i = -1;
  applyLang();
document.documentElement.classList.remove('pre');
  frame.title = ui('frameTitle');
  frame.src = demoSrc();   // the app reads ?lang= (its S.ui.lang)
}
document.querySelectorAll('.lang button').forEach(b => b.onclick = () => setLang(b.dataset.lang));
// the HTML ships Chinese; point the demo at the chosen language before it finishes loading
if (frame.getAttribute('src') !== demoSrc()) frame.src = demoSrc();
applyLang();
document.documentElement.classList.remove('pre');
