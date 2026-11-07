export const END_SILENCE_MS = 2700;
export const MAX_UTTERANCE_MS = 45000;

export function shouldFinishUtterance({ now, startedAt, lastVoiceAt }) {
  return (now - lastVoiceAt >= END_SILENCE_MS && now - startedAt >= 500)
    || now - startedAt >= MAX_UTTERANCE_MS;
}

export class BargeInGate {
  constructor() { this.reset(); }
  reset() { this.baseline = 0; this.startedAt = 0; this.voiceSince = 0; this.preroll = []; }
  observe(rms, now, frame, { playing = false } = {}) {
    if (!this.startedAt) this.startedAt = now;
    this.preroll.push(frame);
    if (this.preroll.length > 18) this.preroll.shift();
    if (playing && now - this.startedAt < 450) { this.baseline = Math.max(this.baseline, rms); return false; }
    const threshold = playing ? Math.max(0.05, this.baseline * 2.6) : 0.032;
    if (rms < threshold) { this.voiceSince = 0; return false; }
    if (!this.voiceSince) this.voiceSince = now;
    return now - this.voiceSince >= (playing ? 550 : 350);
  }
}

export class SentenceSegmenter {
  buffer = '';
  push(delta) {
    this.buffer += delta;
    const ready = [];
    for (;;) {
      const boundary = this.buffer.search(/[。！？!?；;\n]/u);
      let cut = boundary >= 0 ? boundary + 1 : -1;
      if (cut < 0 && this.buffer.length >= 36) {
        const comma = Math.max(this.buffer.lastIndexOf('，'), this.buffer.lastIndexOf(','));
        if (comma >= 18) cut = comma + 1;
      }
      if (cut < 0) break;
      const part = this.buffer.slice(0, cut).trim();
      this.buffer = this.buffer.slice(cut);
      if (part) ready.push(part);
    }
    return ready;
  }
  flushPartial(minLength = 12) {
    if (this.buffer.trim().length < minLength) return [];
    const part = this.buffer.trim();
    this.buffer = '';
    return [part];
  }
  finish() { const rest = this.buffer.trim(); this.buffer = ''; return rest ? [rest] : []; }
}
