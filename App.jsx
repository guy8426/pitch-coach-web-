
import React, { useEffect, useRef, useState } from "react";

// Pitch detection via autocorrelation (YIN-lite style). Good enough for vocal training.
function detectPitch(buf, sampleRate) {
  const SIZE = buf.length;
  const MAX_SAMPLES = Math.floor(SIZE / 2);
  let bestOffset = -1;
  let bestCorrelation = 0;
  let rms = 0;

  for (let i = 0; i < SIZE; i++) {
    const val = buf[i];
    rms += val * val;
  }
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return null; // too quiet

  let lastCorrelation = 1;
  for (let offset = 2; offset < MAX_SAMPLES; offset++) {
    let correlation = 0;
    for (let i = 0; i < MAX_SAMPLES; i++) {
      correlation += Math.abs(buf[i] - buf[i + offset]);
    }
    correlation = 1 - correlation / MAX_SAMPLES;
    if (correlation > 0.9 && correlation > lastCorrelation) {
      bestCorrelation = correlation;
      bestOffset = offset;
    } else if (bestCorrelation > 0.9 && correlation < lastCorrelation) {
      // peak passed
      const freq = sampleRate / bestOffset;
      return freq;
    }
    lastCorrelation = correlation;
  }
  if (bestCorrelation > 0.92 && bestOffset !== -1) {
    return sampleRate / bestOffset;
  }
  return null;
}

function freqToNote(freq) {
  if (!freq) return null;
  const A4 = 440;
  const noteNum = Math.round(12 * Math.log2(freq / A4)) + 69; // MIDI note
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const name = names[(noteNum + 3) % 12]; // align A->A, then offset to C naming
  const octave = Math.floor(noteNum / 12) - 1;
  const cents = Math.floor(1200 * Math.log2(freq / (A4 * Math.pow(2, (noteNum - 69) / 12))));
  return { noteNum, name, octave, cents };
}

function meterScore(cents, tolerance = 25) {
  if (cents == null) return 0;
  const abs = Math.abs(cents);
  if (abs <= tolerance) return 100;
  if (abs > 100) return 0;
  return Math.max(0, Math.round(100 - ((abs - tolerance) / (100 - tolerance)) * 100));
}

export default function App() {
  const [isListening, setIsListening] = useState(false);
  const [freq, setFreq] = useState(null);
  const [note, setNote] = useState(null);
  const [score, setScore] = useState(0);
  const [bpm, setBpm] = useState(100);
  const [click, setClick] = useState(false);
  const [targetNote, setTargetNote] = useState("A4");
  const [ytId, setYtId] = useState("dQw4w9WgXcQ"); // placeholder

  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const dataRef = useRef(null);
  const rafRef = useRef(null);
  const oscRef = useRef(null);
  const nextTickRef = useRef(0);

  // Metronome using WebAudio (simple tick)
  useEffect(() => {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    if (!oscRef.current) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      gain.gain.value = 0; // silent until tick
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      oscRef.current = { osc, gain };
    }
  }, [audioCtxRef.current]);

  useEffect(() => {
    let raf;
    function scheduler() {
      const ctx = audioCtxRef.current;
      if (!ctx || !oscRef.current) return;
      const now = ctx.currentTime;
      while (nextTickRef.current < now + 0.1) {
        // schedule tick
        const start = nextTickRef.current;
        const end = start + 0.03;
        oscRef.current.gain.gain.setValueAtTime(0.4, start);
        oscRef.current.gain.gain.exponentialRampToValueAtTime(0.0001, end);
        const beatMs = 60 / bpm;
        nextTickRef.current += beatMs;
        setClick((c) => !c);
      }
      raf = requestAnimationFrame(scheduler);
    }
    if (isListening) {
      nextTickRef.current = (audioCtxRef.current?.currentTime || 0) + 0.2;
      raf = requestAnimationFrame(scheduler);
    }
    return () => cancelAnimationFrame(raf);
  }, [bpm, isListening]);

  async function start() {
    if (isListening) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    analyserRef.current = analyser;
    dataRef.current = new Float32Array(analyser.fftSize);
    setIsListening(true);
    tick();
  }

  function stop() {
    setIsListening(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (audioCtxRef.current) audioCtxRef.current.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    dataRef.current = null;
  }

  function tick() {
    if (!isListening) return;
    const analyser = analyserRef.current;
    if (analyser && dataRef.current) {
      analyser.getFloatTimeDomainData(dataRef.current);
      const f = detectPitch(dataRef.current, (audioCtxRef.current?.sampleRate || 48000));
      setFreq(f);
      const n = f ? freqToNote(f) : null;
      setNote(n);
      setScore(n ? meterScore(n.cents) : 0);
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function parseYtId(url) {
    try {
      const u = new URL(url);
      if (u.hostname.includes("youtu.be")) return u.pathname.slice(1);
      if (u.searchParams.get("v")) return u.searchParams.get("v");
    } catch {}
    return url; // assume raw id
  }

  function targetToFreq(t) {
    const match = t.match(/([A-G]#?)(\\d)/i);
    if (!match) return 440;
    const names = { C:0, "C#":1, D:2, "D#":3, E:4, F:5, "F#":6, G:7, "G#":8, A:9, "A#":10, B:11 };
    const name = match[1].toUpperCase();
    const octave = parseInt(match[2], 10);
    const midi = 12 * (octave + 1) + names[name];
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function playGuideTone() {
    if (!audioCtxRef.current) return;
    const ctx = audioCtxRef.current;
    const freq = targetToFreq(targetNote);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = freq;
    g.gain.value = 0.0001;
    osc.connect(g).connect(ctx.destination);
    osc.start();
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.0);
    osc.stop(ctx.currentTime + 1.05);
  }

  const diff = note ? note.cents : null;

  return (
    <div className="min-h-screen p-6" style={{ background: '#f9fafb', color: '#111' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700 }}>Pitch & Rhythm Coach (YouTube-friendly)</h1>
          <div>
            {!isListening ? (
              <button onClick={start} style={{ padding: '8px 16px', borderRadius: 16, background: '#111', color: '#fff' }}>Start</button>
            ) : (
              <button onClick={stop} style={{ padding: '8px 16px', borderRadius: 16, background: '#e5e7eb' }}>Stop</button>
            )}
          </div>
        </header>

        <section style={{ display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr', marginTop: 16 }}>
          <div>
            <label style={{ fontSize: 12 }}>YouTube URL or ID</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                style={{ flex: 1, border: '1px solid #e5e7eb', borderRadius: 12, padding: 8 }}
                placeholder="Paste YouTube link"
                onChange={(e) => setYtId(parseYtId(e.target.value))}
              />
              <a
                style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 12 }}
                href={`https://www.youtube.com/watch?v=${ytId}`}
                target="_blank"
                rel="noreferrer"
              >Open</a>
            </div>
            <div style={{ aspectRatio: '16 / 9', width: '100%', background: '#000', borderRadius: 12, overflow: 'hidden', marginTop: 8 }}>
              <iframe
                style={{ width: '100%', height: '100%' }}
                src={`https://www.youtube.com/embed/${ytId}?enablejsapi=1`}
                title="YouTube player"
                frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                allowFullScreen
              />
            </div>
            <p style={{ fontSize: 12, color: '#6b7280' }}>
              *เล่นวิดีโอจาก YouTube แบบฝัง (ไม่ดึงเสียงมาวิเคราะห์ เพื่อให้เป็นไปตามนโยบายแพลตฟอร์ม)
            </p>
          </div>

          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12 }}>Metronome (BPM)</label>
                <input
                  type="range"
                  min={40}
                  max={200}
                  value={bpm}
                  onChange={(e) => setBpm(parseInt(e.target.value))}
                  style={{ width: '100%' }}
                />
                <div style={{ fontSize: 18, fontWeight: 600 }}>{bpm} BPM</div>
              </div>
              <div>
                <label style={{ fontSize: 12 }}>Target Note</label>
                <input
                  style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 12, padding: 8 }}
                  value={targetNote}
                  onChange={(e) => setTargetNote(e.target.value)}
                  placeholder="e.g., A4, C5"
                />
                <button onClick={playGuideTone} style={{ marginTop: 8, padding: '8px 12px', borderRadius: 12, border: '1px solid #e5e7eb' }}>Play guide tone</button>
              </div>
            </div>

            <div style={{ padding: 16, borderRadius: 16, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginTop: 12 }}>
              <div style={{ fontSize: 12, color: '#6b7280' }}>Live Pitch</div>
              <div style={{ fontSize: 32, fontWeight: 700 }}>
                {note ? `${note.name}${note.octave}` : "–"}
              </div>
              <div style={{ fontSize: 12 }}>{freq ? `${freq.toFixed(1)} Hz` : "no signal"}</div>
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: '#6b7280' }}>Cents offset</div>
                <div style={{ width: '100%', height: 16, background: '#f3f4f6', borderRadius: 12, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      background: diff !== null ? (Math.abs(diff) < 25 ? '#22c55e' : '#eab308') : '#e5e7eb',
                      width: `${Math.min(100, Math.abs(diff || 0))}%`
                    }}
                  />
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{diff !== null ? `${diff} cents` : ""}</div>
              </div>
              <div style={{ marginTop: 8, fontSize: 14 }}>Accuracy score: <span style={{ fontWeight: 600 }}>{score}</span></div>
            </div>

            <div style={{ padding: 16, borderRadius: 16, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginTop: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 12, height: 12, borderRadius: 999, background: click ? '#111' : '#d1d5db' }} />
                <span style={{ fontSize: 12 }}>Beat indicator</span>
              </div>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>ปรับ BPM ให้ตรงกับเพลง แล้วซ้อมออกเสียงตามจังหวะ</p>
            </div>
          </div>
        </section>

        <section style={{ padding: 16, borderRadius: 16, background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', marginTop: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>วิธีใช้ (MVP)</h2>
          <ol style={{ marginLeft: 16, fontSize: 14 }}>
            <li>วางลิงก์ YouTube แล้วเล่นเพลงจากฝัง (เสียงจะไม่ถูกนำมาวิเคราะห์)</li>
            <li>กด Start เพื่อเปิดไมค์และตัวตรวจจับเสียงร้องของคุณ</li>
            <li>ตั้งค่า BPM ให้ใกล้เคียงเพลง (ใช้หูหรือลองปรับ) และเลือกโน้ตเป้าหมาย</li>
            <li>ฝึกร้อง/ฮัมตาม แล้วดูค่าโน้ต, Hz, ค่าเพี้ยน (cents) และคะแนน</li>
          </ol>
          <p style={{ fontSize: 12, color: '#6b7280' }}>ต่อยอด: เพิ่มโหมดวิเคราะห์วลี, ทำคอร์สฝึกหู, อัปโหลดไฟล์เสียงที่คุณมีสิทธิ์ใช้งาน</p>
        </section>

        <footer style={{ fontSize: 12, color: '#6b7280', marginTop: 16 }}>
          © {new Date().getFullYear()} – Demo for training purpose only
        </footer>
      </div>
    </div>
  );
}
