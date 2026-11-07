/** Collect partial model text into speakable phrases without changing the displayed text. */
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

  finish() {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }
}
