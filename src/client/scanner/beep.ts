const MUTE_KEY = 'gatepass.scannerMuted';

let context: AudioContext | null = null;

export function loadMuted(): boolean {
  return localStorage.getItem(MUTE_KEY) === '1';
}

export function saveMuted(muted: boolean): void {
  if (muted) localStorage.setItem(MUTE_KEY, '1');
  else localStorage.removeItem(MUTE_KEY);
}

/**
 * Browsers only start audio from a user gesture, and camera detections are not
 * gestures, so call this from pointer and key handlers before the first beep.
 */
export function unlockAudio(): void {
  if (typeof AudioContext === 'undefined') return;
  context ??= new AudioContext();
  if (context.state === 'suspended') void context.resume();
}

/** One short high tone for admitted; two low tones for anything else. */
export function beep(kind: 'ok' | 'fail'): void {
  if (!context || context.state !== 'running') return;
  const tones = kind === 'ok' ? [{ frequency: 1320, at: 0 }] : [{ frequency: 220, at: 0 }, { frequency: 220, at: 0.2 }];
  const start = context.currentTime;
  for (const tone of tones) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const at = start + tone.at;
    oscillator.type = kind === 'ok' ? 'sine' : 'square';
    oscillator.frequency.value = tone.frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.14);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.16);
  }
}
