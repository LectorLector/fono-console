// README.txt inside the exported filter zip: bilingual (zh-TW first, English second). Plain text, deliberately kept out of the UI
// dictionary (web/i18n/en.json) because the file carries both languages itself. Pure function; tested in tests/export.test.mjs.
const f1 = x => (Math.round(x * 10) / 10).toFixed(1);
export function readmeText(S, info) {
  const map = S.room.map, rates = info.rates, isArt = info.kind === 'art';
  const chRows = info.channels.map(c => `  ${c.key.padEnd(4)} EQ APO channel "${c.name}"  ${c.file}  scale ${f1(c.normDb)} dB (peak before ${f1(c.peakDb)} dB)  ${c.lengthSec.toFixed(2)} s${c.role === 'bass' ? '  [input: (L+R)/2]' : ''}`).join('\n');
  const lat = f1(info.latencyMs);
  const cdsFile = isArt ? `combined_art_main_FL_48000.wav` : `combined_FL_48000.wav`;
  const L = [];
  L.push('﻿Fono Console - ' + (isArt ? 'ART 低頻主動校正 / active bass control' : 'FIR 相位校正 / linear-phase FIR') + ' export');
  L.push('='.repeat(72), '', '【中文】', '');
  L.push(
    '這個壓縮檔裡有什麼',
    `  - 每個聲道的 32 位元浮點、單聲道 WAV 脈衝響應（IR），取樣率 ${rates.join(' / ')} Hz 各一份（檔名結尾是取樣率）。`,
    isArt
      ? '  - art_hp_<rate>.wav：主喇叭的線性相位高通；art_<聲道>_<rate>.wav：ART 為每顆喇叭解出的低頻濾波器（輸入是 (L+R)/2 的單聲道低頻）。'
      : '  - fir_<聲道>_<rate>.wav：只含 FIR 相位校正（線性相位全通，不改頻響）。',
    '  - combined_*：每個聲道把「增益、極性、延遲、參量等化（PEQ，biquad）、FIR' + (isArt ? '、ART' : '') + '」全部算成一條 IR，直接載入卷積器就能用，不必再另外設 PEQ。',
    '  - 「左右對稱」：前左／前右的左右頻響配對 PK 濾波器已經算進 combined 檔（接在每聲道的矯正濾波器之後）；若「左右相位配對（FIR）」開啟，還會有 sym_FL／FR_<rate>.wav（短的線性相位 FIR，前左／前右各一）並已卷進 combined 檔，其他聲道補上同樣的延遲。',
    '  - 所有 combined 檔共用同一個縮放（左右聲道的音量差保留），讓最大增益不超過 0 dBFS；下表是實際縮放值（headroom）。如果你的播放軟體已有自己的音量／前級，不需要再補償。',
    `  - 整套延遲：約 ${lat} ms（線性相位 FIR 的中心延遲；沒有 FIR 的聲道已補上同樣的延遲，聲道之間保持對齊）。`, '',
    '聲道名稱', `  FL/FR = 前左／前右；SL/SR = 後左／後右；SW1/SW2 = 重低音。EQ APO 聲道名稱依「聲道對應」：${['FL', 'FR', 'SL', 'SR', 'SW1', 'SW2'].map(k => `${k}=${map[k] || k}`).join('，')}。`, '',
    '檔案清單', chRows, '',
    '不包含：音效頁的 EQ／混響、分頻（bass management）的高低通；這些仍由 Equalizer APO 或你的播放軟體處理。', '',
    '載入方式',
    '  CamillaDSP：每個聲道一個 Conv 濾波器，取樣率要和 devices.samplerate 一致（用對應的檔案）：',
    '      filters:', `        fl: {type: Conv, parameters: {type: Wav, filename: "${cdsFile}", channel: 0}}`, '      pipeline:', '        - {type: Filter, channel: 0, names: [fl]}',
    '  Roon：設定 > DSP > 卷積（Convolution），載入 WAV 或把各取樣率的檔案打包成 .zip；立體聲每側一個檔案，多聲道請用 .cfg 並一一對應聲道。Roon 的詳細格式請以其官方說明為準；使用 combined 檔時請關掉 Roon 的其他等化。',
    '  HQPlayer：Filters > Convolution，載入對應聲道的 WAV（HQPlayer 會依輸出取樣率重新取樣；建議選與播放取樣率相同的檔案）。多聲道在 Convolution 設定裡每個聲道各指定一個檔案。',
    '  Equalizer APO：config.txt 裡 Channel: <聲道名稱> 後加一行 Convolution: <完整路徑>\\combined_FL_48000.wav（EQ APO 會依取樣率自動重新取樣；此時請不要再套同一組 PEQ）。', '',
    '備註：Fono Console 的低延遲模式會略過所有卷積；這些檔案是給想在別的卷積器（或離線）使用的人。');
  L.push('', '='.repeat(72), '', '[English]', '');
  L.push(
    'What is in this zip',
    `  - One 32-bit float, mono WAV impulse response (IR) per channel at ${rates.join(' / ')} Hz (the rate is the file name suffix).`,
    isArt
      ? '  - art_hp_<rate>.wav: the linear-phase high-pass for the main speakers. art_<channel>_<rate>.wav: the bass filter ART solved for each speaker (input = the mono bass (L+R)/2).'
      : '  - fir_<channel>_<rate>.wav: the FIR phase correction only (linear-phase all-pass, magnitude untouched).',
    '  - combined_*: per channel, gain + polarity + delay + parametric EQ (PEQ biquads) + FIR' + (isArt ? ' + ART' : '') + ' rendered into one IR. Load it in any convolver; no separate PEQ is needed.',
    '  - Stereo symmetry: the L/R magnitude-match PK filters of FL / FR are already rendered into the combined files (after each channel\'s correction filters). When the "L/R phase match (FIR)" is on there are also sym_FL / sym_FR_<rate>.wav (a short linear-phase FIR for each side), convolved into the combined files; the other channels carry the same latency as a delay.',
    '  - All combined files share one scale (the level difference between channels is kept) so the largest gain stays <= 0 dBFS. The table below lists the scale applied (headroom). If your player has its own volume / preamp you do not need to compensate.',
    `  - Overall delay: about ${lat} ms (the centre delay of the linear-phase FIR; channels without a FIR already carry the same delay, so they stay time-aligned).`, '',
    'Channel names', `  FL/FR = front left/right; SL/SR = rear left/right; SW1/SW2 = subwoofers. EQ APO channel names follow your channel map: ${['FL', 'FR', 'SL', 'SR', 'SW1', 'SW2'].map(k => `${k}=${map[k] || k}`).join(', ')}.`, '',
    'File list', chRows, '',
    'Not included: the FX page (EQ / reverb) and the bass-management high/low-pass; those stay in Equalizer APO or in your player.', '',
    'How to load',
    '  CamillaDSP: one Conv filter per channel; use the file whose rate equals devices.samplerate:',
    '      filters:', `        fl: {type: Conv, parameters: {type: Wav, filename: "${cdsFile}", channel: 0}}`, '      pipeline:', '        - {type: Filter, channel: 0, names: [fl]}',
    '  Roon: Settings > DSP > Convolution: load a WAV, or zip the per-rate files together; stereo uses one file per side, multichannel uses a .cfg that maps one file per channel. Check Roon\'s own documentation for the exact format; turn Roon\'s other EQ off when using the combined files.',
    '  HQPlayer: Filters > Convolution: load the WAV of each channel (HQPlayer resamples to the output rate; pick the file with the same rate as your playback where you can). For multichannel, assign one file per channel in the Convolution settings.',
    '  Equalizer APO: in config.txt add, after Channel: <channel name>, the line Convolution: <full path>\\combined_FL_48000.wav (EQ APO resamples to the device rate; do not apply the same PEQ again).', '',
    'Note: Fono Console\'s low-latency mode skips every convolution; these files are for using the filters in another convolver, or offline.', '');
  return L.join('\r\n');
}
