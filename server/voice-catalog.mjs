export const VOICE_OPTIONS = Object.freeze([
  { id: '3581b26bce1840f4a70dd0269946120c', label: '默认音色' },
  { id: '341cfd4c96c04c14a93cfef439e02714', label: '青年' },
  { id: '1bba004267fc49dd9c1192ba36195cd8', label: '少年' },
  { id: '74b14e03c1a64fbdb50a2377afd79042', label: '自然' },
]);

export const DEFAULT_VOICE_ID = VOICE_OPTIONS[0].id;

export function normalizeVoiceId(value) {
  return VOICE_OPTIONS.some((voice) => voice.id === value) ? value : DEFAULT_VOICE_ID;
}
