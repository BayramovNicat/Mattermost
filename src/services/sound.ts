let audioCtx: AudioContext | null = null;
let audioUnlocked = false;
let messageWavUrl: string | null = null;
let mentionWavUrl: string | null = null;

const getAudioContext = (): AudioContext | null => {
  if (typeof window === 'undefined') return null;
  const AudioContextClass =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!audioCtx) {
    audioCtx = new AudioContextClass();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
};

const createChimeWavUrl = (notes: Array<{ freq: number; start: number; duration: number; gain: number }>): string => {
  const sampleRate = 22050;
  const totalDuration = Math.max(...notes.map((n) => n.start + n.duration));
  const numSamples = Math.ceil(sampleRate * totalDuration);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, numSamples * 2, true);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = 0;
    for (const note of notes) {
      if (t >= note.start && t <= note.start + note.duration) {
        const localT = t - note.start;
        const env = note.gain * Math.exp((-6 * localT) / note.duration);
        sample += Math.sin(2 * Math.PI * note.freq * localT) * env;
      }
    }
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + i * 2, clamped * 0x7fff, true);
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
};

const playWavFallback = (isMention: boolean) => {
  if (typeof Audio === 'undefined') return;
  try {
    const url = isMention
      ? (mentionWavUrl ??= createChimeWavUrl([
          { freq: 523.25, start: 0, duration: 0.07, gain: 0.12 },
          { freq: 659.25, start: 0.05, duration: 0.07, gain: 0.14 },
          { freq: 783.99, start: 0.1, duration: 0.28, gain: 0.16 },
        ]))
      : (messageWavUrl ??= createChimeWavUrl([
          { freq: 587.33, start: 0, duration: 0.08, gain: 0.12 },
          { freq: 880.0, start: 0.06, duration: 0.22, gain: 0.14 },
        ]));
    const audio = new Audio(url);
    audio.play().catch(() => {});
  } catch {}
};

if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    const ctx = getAudioContext();
    if (!ctx) return;

    if (!audioUnlocked && ctx.state === 'running') {
      try {
        const silentBuffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = silentBuffer;
        source.connect(ctx.destination);
        source.start(0);
        audioUnlocked = true;
      } catch {}
    }

    if (ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          audioUnlocked = true;
        })
        .catch(() => {});
    }
  };

  window.addEventListener('click', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioCtx?.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
  });
}

export const playTone = (freq: number, startTime: number, duration: number, gainValue = 0.15) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, startTime);

  gain.gain.setValueAtTime(gainValue, startTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
};

const playWithResumeOrFallback = (isMention: boolean, playWebAudio: (ctx: AudioContext) => void) => {
  const ctx = getAudioContext();
  if (!ctx) {
    playWavFallback(isMention);
    return;
  }

  if (ctx.state === 'running') {
    playWebAudio(ctx);
    return;
  }

  let settled = false;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      playWavFallback(isMention);
    }
  }, 150);

  ctx
    .resume()
    .then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ctx.state === 'running') {
        playWebAudio(ctx);
      } else {
        playWavFallback(isMention);
      }
    })
    .catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      playWavFallback(isMention);
    });
};

export const playMessageChime = () => {
  playWithResumeOrFallback(false, (ctx) => {
    const now = ctx.currentTime;
    playTone(587.33, now, 0.08, 0.12);
    playTone(880.0, now + 0.06, 0.22, 0.14);
  });
};

export const playMentionChime = () => {
  playWithResumeOrFallback(true, (ctx) => {
    const now = ctx.currentTime;
    playTone(523.25, now, 0.07, 0.12);
    playTone(659.25, now + 0.05, 0.07, 0.14);
    playTone(783.99, now + 0.1, 0.28, 0.16);
  });
};
