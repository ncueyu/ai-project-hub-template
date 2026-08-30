/**
 * 四川省麻將連連看 - 原生 Web Audio API 音效合成器 (Audio)
 * 零外部音效檔案相依，低延遲即時合成
 */

class SoundEffects {
  constructor() {
    this.ctx = null;
    this.muted = localStorage.getItem('mahjong_sound_muted') === 'true';
    // 五聲音階 (Pentatonic scale) 用於連擊 (Combo) 愉悅升調
    this.comboFreqs = [523.25, 587.33, 659.25, 783.99, 880.00, 1046.50, 1174.66, 1318.51];
  }

  initContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  setMuted(muted) {
    this.muted = !!muted;
    localStorage.setItem('mahjong_sound_muted', this.muted ? 'true' : 'false');
  }

  isMuted() {
    return this.muted;
  }

  /**
   * 點擊麻將牌：清脆短促敲擊聲
   */
  playClick() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, t);
    osc.frequency.exponentialRampToValueAtTime(200, t + 0.05);

    gain.gain.setValueAtTime(0.2, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(t);
    osc.stop(t + 0.05);
  }

  /**
   * 配對成功消除：清脆風鈴/鋼片琴升調音
   * @param {number} combo 連擊次數 (1, 2, 3...)
   */
  playMatch(combo = 1) {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const idx = Math.min((combo - 1) % this.comboFreqs.length, this.comboFreqs.length - 1);
    const baseFreq = this.comboFreqs[idx];

    // 主音
    const osc1 = this.ctx.createOscillator();
    const gain1 = this.ctx.createGain();
    osc1.type = 'triangle';
    osc1.frequency.setValueAtTime(baseFreq, t);

    gain1.gain.setValueAtTime(0.3, t);
    gain1.gain.exponentialRampToValueAtTime(0.001, t + 0.28);

    osc1.connect(gain1);
    gain1.connect(this.ctx.destination);
    osc1.start(t);
    osc1.stop(t + 0.28);

    // 泛音 (高八度微弱共鳴)
    const osc2 = this.ctx.createOscillator();
    const gain2 = this.ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(baseFreq * 2, t);

    gain2.gain.setValueAtTime(0.12, t);
    gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.35);

    osc2.connect(gain2);
    gain2.connect(this.ctx.destination);
    osc2.start(t);
    osc2.stop(t + 0.35);
  }

  /**
   * 配對失敗/無效操作：柔和低音提示
   */
  playMismatch() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);

    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);

    osc.connect(gain);
    gain.connect(this.ctx.destination);

    osc.start(t);
    osc.stop(t + 0.12);
  }

  /**
   * 提示音效：清脆閃爍感
   */
  playHint() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    const notes = [659.25, 880.00, 1046.50]; // E5, A5, C6
    notes.forEach((freq, i) => {
      const startTime = t + i * 0.06;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      gain.gain.setValueAtTime(0.18, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.2);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.2);
    });
  }

  /**
   * 洗牌音效：連續快速敲擊
   */
  playShuffle() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    for (let i = 0; i < 8; i++) {
      const startTime = t + i * 0.035;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400 + Math.random() * 300, startTime);

      gain.gain.setValueAtTime(0.15, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.04);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + 0.04);
    }
  }

  /**
   * 通關勝利音效：大調和弦琶音
   */
  playVictory() {
    if (this.muted) return;
    this.initContext();
    if (!this.ctx) return;

    const t = this.ctx.currentTime;
    // C大調琶音: C4, E4, G4, C5, E5, G5, C6
    const chord = [261.63, 329.63, 392.00, 523.25, 659.25, 783.99, 1046.50];
    chord.forEach((freq, i) => {
      const startTime = t + i * 0.09;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = i === chord.length - 1 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, startTime);

      const duration = i === chord.length - 1 ? 0.8 : 0.4;
      gain.gain.setValueAtTime(0.25, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(startTime);
      osc.stop(startTime + duration);
    });
  }
}

export const sound = new SoundEffects();
