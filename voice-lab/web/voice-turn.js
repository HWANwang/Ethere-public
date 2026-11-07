export const END_SILENCE_MS = 2700;
export const MAX_UTTERANCE_MS = 45_000;

export function shouldFinishUtterance({ now, startedAt, lastVoiceAt }) {
  return (now - lastVoiceAt >= END_SILENCE_MS && now - startedAt >= 500)
    || now - startedAt >= MAX_UTTERANCE_MS;
}

// A conservative gate: output from the speaker is normally much quieter after
// browser echo cancellation. The microphone button remains the reliable fallback.
export class BargeInGate {
  constructor() { this.reset(); }
  reset() { this.baseline = 0; this.startedAt = 0; this.voiceSince = 0; this.preroll = []; }
  observe(rms, now, frame, { playing = false } = {}) {
    if (!this.startedAt) this.startedAt = now;
    this.preroll.push(frame);
    if (this.preroll.length > 18) this.preroll.shift();
    if (playing && now - this.startedAt < 450) {
      this.baseline = Math.max(this.baseline, rms);
      return false;
    }
    const threshold = playing ? Math.max(0.05, this.baseline * 2.6) : 0.032;
    if (rms < threshold) { this.voiceSince = 0; return false; }
    if (!this.voiceSince) this.voiceSince = now;
    return now - this.voiceSince >= (playing ? 550 : 350);
  }
}
