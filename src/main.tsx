import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AudioLines, ChevronDown, CircleHelp, Headphones, Mic, MicOff, Play, RotateCcw, Settings2, Sparkles, TimerReset, Waves, Zap } from 'lucide-react';
import './styles.css';

type Rhythm = 'MINIM' | 'CROTCHET' | 'QUAVER';
type Note = { name: string; midi: number; accidental?: string; rhythm: Rhythm };

const NOTES = [
  ['C4', 60], ['D4', 62], ['E4', 64], ['F4', 65], ['G4', 67], ['A4', 69], ['B4', 71],
  ['C5', 72], ['D5', 74], ['E5', 76], ['F5', 77], ['G5', 79], ['A5', 81], ['B5', 83],
] as const;
const tempos = [80, 90, 100, 110, 120];
const rhythmUnits: Record<Rhythm, number> = { MINIM: 2, CROTCHET: 1, QUAVER: 0.5 };
const rhythmGlyph: Record<Rhythm, string> = { MINIM: '—', CROTCHET: '●', QUAVER: '◖' };

function midiToFrequency(midi: number) { return 440 * Math.pow(2, (midi - 69) / 12); }
function midiToNote(midi: number) {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  return `${names[midi % 12]}${Math.floor(midi / 12) - 1}`;
}
function centsOff(freq: number, target: number) { return 1200 * Math.log2(freq / target); }

function App() {
  const [tempo, setTempo] = useState(100);
  const [isRunning, setIsRunning] = useState(false);
  const [sequence, setSequence] = useState<Note[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [lastPlayed, setLastPlayed] = useState('—');
  const [lastResult, setLastResult] = useState<'waiting' | 'accurate' | 'missed'>('waiting');
  const [practiceCount, setPracticeCount] = useState(0);
  const [accurateCount, setAccurateCount] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [micStatus, setMicStatus] = useState('Microphone inactive');
  const [detectedNote, setDetectedNote] = useState('—');
  const [detectedCents, setDetectedCents] = useState(0);
  const [soundOn, setSoundOn] = useState(true);
  const audioRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const nextSequence = useCallback(() => {
    const shuffled = [...NOTES].sort(() => Math.random() - 0.5).slice(0, 8);
    const rhythms: Rhythm[] = ['CROTCHET', 'QUAVER', 'CROTCHET', 'MINIM', 'QUAVER', 'CROTCHET', 'MINIM', 'QUAVER'];
    setSequence(shuffled.map(([name, midi], i) => ({ name, midi, rhythm: rhythms[i] })));
    setCurrentIndex(0); setPracticeCount(0); setAccurateCount(0); setLastPlayed('—'); setLastResult('waiting');
  }, []);
  useEffect(() => { nextSequence(); }, [nextSequence]);
  const current = sequence[currentIndex];
  const score = practiceCount ? Math.round((accurateCount / practiceCount) * 100) : 0;
  const readiness = Math.min(100, Math.round(score * 0.7 + Math.min(practiceCount, 12) / 12 * 30));
  const readinessLabel = readiness >= 82 ? 'Ready to layer chords' : readiness >= 60 ? 'Build more consistency' : 'Keep training single notes';

  const playTone = useCallback((midi: number) => {
    if (!soundOn) return;
    const ctx = audioRef.current ?? new AudioContext(); audioRef.current = ctx;
    oscillatorRef.current?.stop();
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = midiToFrequency(midi); gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01); gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
    osc.connect(gain).connect(ctx.destination); osc.start(); osc.stop(ctx.currentTime + 0.72); oscillatorRef.current = osc;
  }, [soundOn]);

  const registerNote = useCallback((name: string, midi: number) => {
    if (!current || !isRunning) return;
    playTone(midi);
    const correct = midi === current.midi;
    setLastPlayed(name); setLastResult(correct ? 'accurate' : 'missed'); setPracticeCount((x) => x + 1); if (correct) setAccurateCount((x) => x + 1);
    setCurrentIndex((x) => (x + 1) % sequence.length);
  }, [current, isRunning, playTone, sequence.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const found = NOTES.find(([name]) => name.toLowerCase() === e.key.toLowerCase());
      if (found) registerNote(found[0], found[1]);
    };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [registerNote]);

  const startMic = async () => {
    if (micOn) { streamRef.current?.getTracks().forEach((t) => t.stop()); if (rafRef.current) cancelAnimationFrame(rafRef.current); setMicOn(false); setMicStatus('Microphone inactive'); setDetectedNote('—'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: false } });
      streamRef.current = stream; const ctx = audioRef.current ?? new AudioContext(); audioRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream); const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser); analyserRef.current = analyser;
      setMicOn(true); setMicStatus('Listening for acoustic pitch');
      const buffer = new Float32Array(analyser.fftSize);
      const detect = () => {
        analyser.getFloatTimeDomainData(buffer); let rms = 0; for (const v of buffer) rms += v * v; rms = Math.sqrt(rms / buffer.length);
        if (rms > 0.012) {
          let bestLag = 0; let best = 0;
          for (let lag = 24; lag < 180; lag++) { let corr = 0; for (let i = 0; i < buffer.length - lag; i += 2) corr += buffer[i] * buffer[i + lag]; if (corr > best) { best = corr; bestLag = lag; } }
          if (bestLag) { const freq = ctx.sampleRate / bestLag; const midi = Math.round(69 + 12 * Math.log2(freq / 440)); const cents = Math.max(-50, Math.min(50, Math.round(centsOff(freq, midiToFrequency(midi))))); const note = midiToNote(midi); setDetectedNote(note); setDetectedCents(cents); if (current && Math.abs(midi - current.midi) <= 0) registerNote(note, midi); }
        }
        rafRef.current = requestAnimationFrame(detect);
      }; detect();
    } catch { setMicStatus('Permission needed — allow microphone access'); }
  };

  const beatMs = 60000 / tempo;
  useEffect(() => { if (!isRunning) return; const id = window.setInterval(() => {}, beatMs); return () => clearInterval(id); }, [isRunning, beatMs]);

  const keyboard = useMemo(() => NOTES.map(([name, midi]) => ({ name, midi, black: name.includes('♯') })), []);
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Waves size={19} /></div><div><div className="brand-name">KEYSIGHT</div><div className="brand-sub">practice studio</div></div></div>
      <div className="side-label">TRAINING MODE</div>
      <button className="nav-item active"><Zap size={17} /> Sight-reading <span className="nav-dot" /></button>
      <button className="nav-item"><AudioLines size={17} /> Chord fluency <span className="soon">soon</span></button>
      <button className="nav-item"><TimerReset size={17} /> Session history</button>
      <div className="sidebar-spacer" />
      <div className="micro-card"><div className="side-label">TODAY'S TARGET</div><div className="target-row"><span>12 min</span><span>07:42</span></div><div className="target-track"><span /></div><p>One focused block beats scattered practice.</p></div>
      <button className="nav-item"><Settings2 size={17} /> Preferences</button>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">SIGHT-READING / SESSION 04</div><h1>Single notes, instantly.</h1></div><div className="top-actions"><button className="icon-btn" title="Help"><CircleHelp size={18} /></button><div className="avatar">AR</div></div></header>
      <section className="session-grid">
        <div className="practice-card">
          <div className="card-head"><div><div className="card-kicker">LIVE EXERCISE</div><h2>Find the note. Stay in time.</h2></div><div className={`status-pill ${isRunning ? 'live' : ''}`}><span />{isRunning ? 'running' : 'paused'}</div></div>
          <div className="staff-wrap"><div className="staff-meta"><span>Treble clef · C position</span><span className="measure">MEASURE {String(currentIndex + 1).padStart(2, '0')} / 08</span></div><div className="staff"><div className="clef">𝄞</div><div className="staff-lines">{[0,1,2,3,4].map((x) => <span key={x} />)}<div className="note-head" style={{ top: `${current ? 54 - (current.midi - 60) * 3.5 : 48}px` }}><i /><b /></div></div><div className="barline" /></div><div className="note-readout"><div className="note-symbol">{current ? current.name.replace(/[0-9]/, '') : '—'}</div><div><div className="note-name">{current?.name ?? '—'}</div><div className="note-rhythm">{current ? `${rhythmGlyph[current.rhythm]} ${current.rhythm}` : 'Waiting'}</div></div><div className="next-hint">NEXT <strong>{sequence[(currentIndex + 1) % Math.max(sequence.length, 1)]?.name ?? '—'}</strong></div></div></div>
          <div className="control-row"><div className="tempo-control"><span className="control-label">TEMPO</span><div className="tempo-value">{tempo}<small>BPM</small></div><div className="tempo-buttons">{tempos.map((t) => <button key={t} className={tempo === t ? 'selected' : ''} onClick={() => setTempo(t)}>{t}</button>)}</div></div><div className="transport"><button className={`primary-btn ${isRunning ? 'pause' : ''}`} onClick={() => setIsRunning((x) => !x)}><Play size={16} fill="currentColor" /> {isRunning ? 'Pause drill' : 'Start drill'}</button><button className="secondary-btn" onClick={nextSequence}><RotateCcw size={16} /> New sequence</button></div></div>
          <div className="sequence-strip"><span className="control-label">UP NEXT</span>{sequence.map((note, i) => <span key={`${note.name}-${i}`} className={`seq-note ${i === currentIndex ? 'current' : i < currentIndex ? 'done' : ''}`}>{note.name.replace(/[0-9]/, '')}<small>{rhythmGlyph[note.rhythm]}</small></span>)}</div>
        </div>
        <div className="side-stack">
          <div className="metric-card"><div className="metric-top"><span className="card-kicker">READINESS MODEL</span><span className="model-badge">R2</span></div><div className="readiness-number">{readiness}<span>/100</span></div><div className="readiness-label">{readinessLabel}</div><div className="readiness-track"><span style={{ width: `${readiness}%` }} /></div><div className="model-copy">Accuracy, tempo control, and consistency are weighted toward chord readiness.</div></div>
          <div className="metric-card mic-card"><div className="metric-top"><span className="card-kicker">AUDIO INPUT</span><span className={`input-state ${micOn ? 'on' : ''}`}><span />{micOn ? 'live' : 'offline'}</span></div><div className="pitch-display"><div className="pitch-note">{detectedNote}</div><div className="pitch-cents"><span className={detectedCents === 0 ? 'centered' : ''}>{detectedCents > 0 ? '+' : ''}{detectedCents} cents</span><div className="cents-meter"><i /><b style={{ left: `${50 + detectedCents / 2}%` }} /></div></div></div><button className={`mic-btn ${micOn ? 'active' : ''}`} onClick={startMic}>{micOn ? <MicOff size={16} /> : <Mic size={16} />} {micOn ? 'Stop listening' : 'Enable microphone'}</button><div className="mic-status">{micOn && <span className="pulse-dot" />}{micStatus}</div></div>
        </div>
      </section>
      <section className="lower-grid">
        <div className="keyboard-card"><div className="card-head compact"><div><div className="card-kicker">MIDI / ACOUSTIC MONITOR</div><h2>Play the highlighted key</h2></div><button className={`sound-toggle ${soundOn ? 'on' : ''}`} onClick={() => setSoundOn((x) => !x)}>{soundOn ? 'Sound on' : 'Sound off'}</button></div><div className="keyboard"><div className="white-keys">{keyboard.filter((k) => !k.black).map((key) => <button key={key.midi} className={current?.midi === key.midi ? 'target-key' : ''} onClick={() => registerNote(key.name, key.midi)}><span>{key.name.replace(/[0-9]/, '')}</span></button>)}</div><div className="black-keys">{keyboard.filter((k) => k.black).map((key) => <button key={key.midi} onClick={() => registerNote(key.name, key.midi)}><span>{key.name.replace(/[0-9]/, '')}</span></button>)}</div></div><div className="keyboard-foot"><span><span className="legend-dot target" /> target</span><span><span className="legend-dot pressed" /> last played: <strong className={lastResult}>{lastPlayed}</strong></span><span className="keyboard-tip">Computer keys A–K also work</span></div></div>
        <div className="stats-card"><div className="card-kicker">SESSION SIGNALS</div><div className="stat-list"><div><span>Accuracy</span><strong>{score}%</strong></div><div><span>Notes attempted</span><strong>{practiceCount || 0}</strong></div><div><span>Tempo lock</span><strong>{tempo} BPM</strong></div><div><span>Rhythms</span><strong>3 patterns</strong></div></div><div className="rhythm-legend"><span><b>—</b> minim</span><span><b>●</b> crotchet</span><span><b>◖</b> quaver</span></div></div>
      </section>
      <div className="footer-note"><Sparkles size={14} /> Play by ear, verify by sight, build toward chords. <span>Each correct note advances the phrase.</span></div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
