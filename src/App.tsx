/**
 * PUENTE — real-time speech interpreter, v0.2 — phase 2: multilingual
 * ------------------------------------------------------------------
 * Pipeline:  mic → Web Speech API (streaming STT, per-language)
 *                → Claude Sonnet (language detection + ASR-error
 *                  reconstruction + translation, strict JSON contract)
 *                → speechSynthesis (TTS in the target language)
 *
 * Auto-detect design (Web Speech API cannot language-ID raw audio):
 *   1. Expectation flip — after each translated turn the recognizer
 *      switches to the language it just spoke, anticipating the reply.
 *   2. Claude safety net — every transcript is re-classified at the
 *      text level; if the speaker used the "wrong" language, Claude
 *      reconstructs the mangled transcript and translates in the
 *      correct direction ("auto-detected" chip appears).
 *   Tap a language card at any time to force the next expectation.
 *
 * Feedback-loop prevention: recognition pauses while TTS is playing,
 * then resumes in the (flipped) expected language.
 *
 * Phase 2 (this version): 20-language registry, RTL-safe rendering
 * (dir="auto" + lang attributes), device TTS-voice detection with a
 * text-only fallback when no matching voice exists, and per-language
 * verified/candidate tracking ("unverified pair" tag in the header).
 * Verification protocol: the pipeline is pair-generic, so one live
 * spot check per candidate against English covers it — then flip that
 * language's `verified` flag to true below.
 * ------------------------------------------------------------------
 */

import React, { useState, useRef, useEffect } from "react";
import {
  Mic, Volume2, VolumeX, ArrowLeftRight, Loader2,
  Trash2, Send, AlertTriangle, Repeat
} from "lucide-react";

// ── Language registry ──────────────────────────────────────────────
// Verified pair (phase 1): English ⇄ Español, pinned first.
// Phase 2 candidates follow alphabetically. To verify one: run a live
// round trip against English, then set verified: true. Locale defaults
// (es-MX, pt-BR, zh-CN, ar-SA…) are one-line swaps if you need variants.
const LANGUAGES = [
  { code: "en", name: "English",          flag: "🇺🇸", rec: "en-US", tts: "en-US", verified: true },
  { code: "es", name: "Español",          flag: "🇲🇽", rec: "es-MX", tts: "es-MX", verified: true },
  { code: "ar", name: "العربية",           flag: "🇸🇦", rec: "ar-SA", tts: "ar-SA", verified: false },
  { code: "zh", name: "中文",              flag: "🇨🇳", rec: "zh-CN", tts: "zh-CN", verified: false },
  { code: "nl", name: "Nederlands",       flag: "🇳🇱", rec: "nl-NL", tts: "nl-NL", verified: false },
  { code: "fr", name: "Français",         flag: "🇫🇷", rec: "fr-FR", tts: "fr-FR", verified: false },
  { code: "de", name: "Deutsch",          flag: "🇩🇪", rec: "de-DE", tts: "de-DE", verified: false },
  { code: "el", name: "Ελληνικά",         flag: "🇬🇷", rec: "el-GR", tts: "el-GR", verified: false },
  { code: "hi", name: "हिन्दी",             flag: "🇮🇳", rec: "hi-IN", tts: "hi-IN", verified: false },
  { code: "id", name: "Bahasa Indonesia", flag: "🇮🇩", rec: "id-ID", tts: "id-ID", verified: false },
  { code: "it", name: "Italiano",         flag: "🇮🇹", rec: "it-IT", tts: "it-IT", verified: false },
  { code: "ja", name: "日本語",            flag: "🇯🇵", rec: "ja-JP", tts: "ja-JP", verified: false },
  { code: "ko", name: "한국어",            flag: "🇰🇷", rec: "ko-KR", tts: "ko-KR", verified: false },
  { code: "pl", name: "Polski",           flag: "🇵🇱", rec: "pl-PL", tts: "pl-PL", verified: false },
  { code: "pt", name: "Português",        flag: "🇧🇷", rec: "pt-BR", tts: "pt-BR", verified: false },
  { code: "ru", name: "Русский",          flag: "🇷🇺", rec: "ru-RU", tts: "ru-RU", verified: false },
  { code: "th", name: "ไทย",              flag: "🇹🇭", rec: "th-TH", tts: "th-TH", verified: false },
  { code: "tr", name: "Türkçe",           flag: "🇹🇷", rec: "tr-TR", tts: "tr-TR", verified: false },
  { code: "uk", name: "Українська",       flag: "🇺🇦", rec: "uk-UA", tts: "uk-UA", verified: false },
  { code: "vi", name: "Tiếng Việt",       flag: "🇻🇳", rec: "vi-VN", tts: "vi-VN", verified: false },
];
const byCode = (c) => LANGUAGES.find((l) => l.code === c) || LANGUAGES[0];

// Side accents encode direction: side 0 = signal (cool), side 1 = sol (warm)
const ACCENTS = ["#5BC8F5", "#F5B04C"];

// ── Translation engine (Claude via artifact bridge) ────────────────
async function requestTranslation(text, aCode, bCode, expectedCode, source) {
  const A = byCode(aCode), B = byCode(bCode), E = byCode(expectedCode);
  const originNote =
    source === "voice"
      ? `The transcript came from a speech recognizer configured for ${E.name}. If the speaker actually spoke the other language, words may be phonetically mangled — reconstruct the intended sen[...]`
      : `The text was typed directly by the user.`;

  const prompt = `You are the translation engine inside a live two-way voice interpreter.

Active language pair: ${A.name} (code "${aCode}") and ${B.name} (code "${bCode}").
${originNote}

Input: """${text}"""

Do this:
1. Decide which of the two languages the input is in. "detected" must be exactly "${aCode}" or "${bCode}".
2. Produce "cleaned": the corrected input in the detected language — fix recognition errors, restore punctuation and accents, keep the speaker's meaning and register.
3. Produce "translation": a natural, conversational rendering of "cleaned" into the other language of the pair. Match tone (casual stays casual, formal stays formal). Translate meaning, not word-b[...]

Respond with ONLY minified JSON, no markdown fences, no commentary:
{"detected":"...","cleaned":"...","translation":"..."}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { 
      "Content-Type": "application/json",
      "x-api-key": "YOUR_ACTUAL_ANTHROPIC_API_KEY", // <-- Paste your real key here
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true" 
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("API error " + res.status);
  const data = await res.json();
  const out = (data.content || [])
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("");
  const s = out.indexOf("{");
  const e = out.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("Unparseable engine response");
  return JSON.parse(out.slice(s, e + 1));
}

// ── Styles ─────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700&family=IBM+Plex+Mono:wght@400;500&display=swap');

:root{
  --ink:#0B1220; --panel:#121B2C; --panel2:#182339; --line:#25334F;
  --text:#E9EEF8; --muted:#8D99B5; --signal:#5BC8F5; --sol:#F5B04C; --err:#F08A8A;
  --body:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --display:'Bricolage Grotesque',var(--body);
  --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
.root{
  min-height:100dvh;color:var(--text);font-family:var(--body);
  background:
    radial-gradient(1100px 480px at -10% -12%, rgba(91,200,245,.08), transparent 60%),
    radial-gradient(1100px 480px at 110% -12%, rgba(245,176,76,.08), transparent 60%),
    var(--ink);
}
.app{max-width:680px;margin:0 auto;height:100dvh;display:flex;flex-direction:column;padding:0 16px}

header{display:flex;align-items:baseline;justify-content:space-between;padding:18px 2px 12px}
.wordmark{font-family:var(--display);font-weight:700;font-size:22px;letter-spacing:.3px;display:flex;align-items:center;gap:9px}
.mark{display:inline-flex;gap:4px}
.mark i{width:8px;height:8px;border-radius:50%;display:inline-block}
.meta{font-family:var(--mono);font-size:11px;color:var(--muted)}

.pair-row{display:flex;align-items:stretch;gap:10px}
.lang-card{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:12px 10px 9px;display:flex;flex-direction:column;align-items:center;gap:7px;
  cursor:pointer;transition:border-color .15s, box-shadow .15s}
.lang-card.active{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset}
.lang-flag{font-size:22px;line-height:1}
.lang-card select{background:var(--panel2);color:var(--text);border:1px solid var(--line);
  border-radius:8px;padding:5px 10px;font-family:var(--display);font-weight:500;font-size:14px;
  text-align:center;cursor:pointer;max-width:100%}
.lang-state{font-family:var(--mono);font-size:10px;letter-spacing:.4px;color:var(--accent);min-height:13px;text-transform:uppercase}
.swap{align-self:center;width:36px;height:36px;border-radius:50%;flex:none;border:1px solid var(--line);
  background:var(--panel);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer}
.swap:hover{color:var(--text);border-color:var(--muted)}

.banner{margin-top:10px;background:var(--panel);border:1px solid var(--line);border-left:3px solid var(--sol);
  border-radius:10px;padding:9px 12px;font-size:13px;color:var(--muted);display:flex;gap:9px;align-items:flex-start}
.banner svg{flex:none;margin-top:1px;color:var(--sol)}

.feed-head{display:flex;justify-content:space-between;align-items:center;margin-top:12px;padding:0 2px}
.feed-head span{font-family:var(--mono);font-size:11px;color:var(--muted);letter-spacing:.5px}
.icon-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px;border-radius:6px;display:inline-flex}
.icon-btn:hover{color:var(--text);background:var(--panel2)}

.feed{flex:1;overflow-y:auto;padding:6px 2px 10px;scrollbar-width:thin}
.empty{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;padding:0 24px}
.empty h2{font-family:var(--display);font-weight:500;font-size:21px}
.empty p{color:var(--muted);font-size:13.5px;max-width:40ch;line-height:1.5}
.empty .es{font-family:var(--mono);font-size:11px;color:var(--muted);opacity:.75}

.bubble{max-width:86%;background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:10px 13px 11px;margin:9px 0}
.bubble.side-a{border-left:3px solid var(--accent);border-top-left-radius:5px}
.bubble.side-b{margin-left:auto;border-right:3px solid var(--accent);border-top-right-radius:5px}
.bubble-meta{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.bubble-meta .dir{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.chip{font-family:var(--mono);font-size:9.5px;border:1px solid var(--accent);color:var(--accent);
  border-radius:999px;padding:1px 7px;letter-spacing:.3px}
.bubble-meta .icon-btn{margin-left:auto;padding:2px}
.bubble-src{font-size:13px;color:var(--muted);line-height:1.45}
.bubble-dst{font-size:15.5px;font-weight:500;line-height:1.45;margin-top:5px}
.working{display:flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:6px}
.err-row{display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--err);margin-top:6px}
.retry{background:none;border:1px solid var(--err);color:var(--err);border-radius:999px;
  padding:2px 11px;font-family:var(--mono);font-size:11px;cursor:pointer}
.retry:hover{background:var(--panel2)}

.dock{border-top:1px solid var(--line);padding:12px 0 14px;display:flex;flex-direction:column;align-items:center;gap:10px}
.status{font-family:var(--mono);font-size:12px;min-height:18px;color:var(--muted);text-align:center;
  max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}
.status .live{color:var(--text);font-style:italic}

.mic{position:relative;width:84px;height:84px;border-radius:50%;border:none;cursor:pointer;flex:none;
  background:conic-gradient(from 210deg,var(--signal),var(--sol),var(--signal));padding:3px}
.mic-inner{width:100%;height:100%;border-radius:50%;background:var(--panel);
  display:flex;align-items:center;justify-content:center;color:var(--text);transition:background .2s}
.mic.listening .mic-inner{background:var(--panel2)}
.mic:disabled{opacity:.4;cursor:not-allowed}
.pulse{position:absolute;inset:-5px;border-radius:50%;border:2px solid var(--signal);opacity:0;pointer-events:none}
.pulse.p2{border-color:var(--sol)}
.mic.listening .pulse.p1{animation:pulse 1.9s ease-out infinite}
.mic.listening .pulse.p2{animation:pulse 1.9s ease-out .95s infinite}
@keyframes pulse{0%{transform:scale(.92);opacity:.75}100%{transform:scale(1.38);opacity:0}}
.spin{animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.toggles{display:flex;gap:8px}
.toggle{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:999px;
  background:transparent;color:var(--muted);font-family:var(--mono);font-size:11px;
  padding:6px 13px;cursor:pointer;transition:all .15s}
.toggle.on{color:var(--text);background:var(--panel);border-color:var(--muted)}

.typedrow{display:flex;gap:8px;width:100%;max-width:520px}
.typedrow input{flex:1;background:var(--panel);border:1px solid var(--line);border-radius:10px;
  color:var(--text);padding:9px 13px;font-size:14px;font-family:var(--body)}
.typedrow input::placeholder{color:var(--muted)}
.typedrow input:focus{outline:none;border-color:var(--muted)}
.send{width:40px;height:40px;flex:none;border-radius:10px;border:1px solid var(--line);
  background:var(--panel);color:var(--muted);display:flex;align-items:center;justify-content:center;cursor:pointer}
.send:hover{color:var(--text);border-color:var(--muted)}

.pipeline{font-family:var(--mono);font-size:10px;color:var(--muted);opacity:.65;text-align:center}

button:focus-visible,select:focus-visible,[role=button]:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
@media (prefers-reduced-motion: reduce){
  .mic.listening .pulse{animation:none}
  .spin{animation:none}
}
@media (max-width:420px){
  .bubble{max-width:94%}
  .lang-flag{font-size:19px}
}
`;

// ── App ────────────────────────────────────────────────────────────
export default function PuenteTranslator() {
  const [pair, setPair] = useState(["en", "es"]);
  const [expected, setExpected] = useState("en");
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [speakCode, setSpeakCode] = useState(null);
  const [interim, setInterim] = useState("");
  const [entries, setEntries] = useState([]);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [autoFlip, setAutoFlip] = useState(true);
  const [typed, setTyped] = useState("");
  const [micError, setMicError] = useState("");
  const [voices, setVoices] = useState([]);
  const [supported, setSupported] = useState(true);

  const recRef = useRef(null);
  const recLangRef = useRef(null);
  const listeningRef = useRef(false);
  const speakingRef = useRef(false);
  const expectedRef = useRef("en");
  const pairRef = useRef(["en", "es"]);
  const autoSpeakRef = useRef(true);
  const autoFlipRef = useRef(true);
  const entriesRef = useRef([]);
  const voicesRef = useRef([]);
  const restartRef = useRef(null);
  const idRef = useRef(0);
  const startEntryRef = useRef(() => {});
  const feedRef = useRef(null);

  useEffect(() => { entriesRef.current = entries; }, [entries]);

  // Recognition — one instance, lang set before each start.
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (e) => {
      let live = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const t = r[0].transcript.trim();
          if (t) startEntryRef.current(t, "voice");
        } else {
          live += r[0].transcript;
        }
      }
      setInterim(live);
    };
    rec.onend = () => {
      setInterim("");
      if (listeningRef.current && !speakingRef.current) {
        clearTimeout(restartRef.current);
        restartRef.current = setTimeout(safeStart, 200);
      }
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        listeningRef.current = false;
        setListening(false);
        setMicError("Microphone is blocked in this environment. The text box below runs the exact same detect-and-translate pipeline.");
      } else if (e.error === "audio-capture") {
        listeningRef.current = false;
        setListening(false);
        setMicError("No microphone found. Plug one in, or use the text box below.");
      }
      // 'no-speech' / 'aborted' / 'network' fall through to onend, which restarts.
    };
    recRef.current = rec;
    return () => {
      listeningRef.current = false;
      clearTimeout(restartRef.current);
      try { rec.stop(); } catch {}
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // TTS voices load asynchronously.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const load = () => {
      const v = window.speechSynthesis.getVoices();
      voicesRef.current = v;
      setVoices(v);
    };
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener("voiceschanged", load);
  }, []);

  // Autoscroll the feed.
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, interim]);

  // ── Recognition control ──────────────────────────────────────────
  const safeStart = () => {
    const rec = recRef.current;
    if (!rec || !listeningRef.current || speakingRef.current) return;
    const tag = byCode(expectedRef.current).rec;
    rec.lang = tag;
    recLangRef.current = tag;
    try { rec.start(); } catch {}
  };

  // Restart recognition only if the expected language actually changed.
  const resyncRec = () => {
    if (!listeningRef.current || speakingRef.current) return;
    if (recLangRef.current === byCode(expectedRef.current).rec) return;
    try { recRef.current && recRef.current.stop(); } catch {}
  };

  const toggleListening = () => {
    if (!supported) return;
    if (listeningRef.current) {
      listeningRef.current = false;
      setListening(false);
      clearTimeout(restartRef.current);
      try { recRef.current && recRef.current.stop(); } catch {}
      setInterim("");
    } else {
      setMicError("");
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
      speakingRef.current = false;
      setSpeaking(false);
      listeningRef.current = true;
      setListening(true);
      safeStart();
    }
  };

  const forceExpect = (code) => {
    expectedRef.current = code;
    setExpected(code);
    resyncRec();
  };

  const changeLang = (idx, code) => {
    const next = [...pairRef.current];
    if (next[1 - idx] === code) next[1 - idx] = next[idx]; // picking the other side's language swaps them
    next[idx] = code;
    pairRef.current = next;
    setPair(next);
    if (!next.includes(expectedRef.current)) {
      expectedRef.current = next[idx];
      setExpected(next[idx]);
    }
    resyncRec();
  };

  const swapPair = () => {
    const next = [pairRef.current[1], pairRef.current[0]];
    pairRef.current = next;
    setPair(next);
  };

  // ── TTS ──────────────────────────────────────────────────────────
  const speak = (text, L) => {
    if (!text || !("speechSynthesis" in window)) { resyncRec(); return; }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = L.tts;
      const vs = voicesRef.current || [];
      const match =
        vs.find((v) => v.lang && v.lang.replace("_", "-").toLowerCase() === L.tts.toLowerCase()) ||
        vs.find((v) => v.lang && v.lang.toLowerCase().startsWith(L.code)) ||
        null;
      if (vs.length > 0 && !match) {
        // No voice for this language on this device: readable text beats
        // mispronouncing it through the default voice.
        resyncRec();
        return;
      }
      u.voice = match;
      u.rate = 1;
      u.pitch = 1;
      // Pause the mic so the app doesn't translate its own voice.
      speakingRef.current = true;
      setSpeaking(true);
      setSpeakCode(L.code);
      clearTimeout(restartRef.current);
      try { recRef.current && recRef.current.stop(); } catch {}
      const finish = () => {
        if (window.speechSynthesis.speaking || window.speechSynthesis.pending) return;
        speakingRef.current = false;
        setSpeaking(false);
        setSpeakCode(null);
        if (listeningRef.current) {
          clearTimeout(restartRef.current);
          restartRef.current = setTimeout(safeStart, 300);
        }
      };
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    } catch {
      speakingRef.current = false;
      setSpeaking(false);
      setSpeakCode(null);
      resyncRec();
    }
  };

  // ── Utterance lifecycle ──────────────────────────────────────────
  const runTranslation = async (en) => {
    const [a, b] = en.pairAt;
    try {
      const out = await requestTranslation(en.raw, a, b, en.expectedAt, en.source);
      const detected = out.detected === a || out.detected === b ? out.detected : en.expectedAt;
      const target = detected === a ? b : a;
      const side = detected === a ? 0 : 1;
      const corrected = en.source === "voice" && detected !== en.expectedAt;
      const translation = (out.translation || "").trim();
      setEntries((prev) =>
        prev.map((x) =>
          x.id === en.id
            ? { ...x, status: "done", srcCode: detected, dstCode: target, side, cleaned: out.cleaned || en.raw, translation, corrected }
            : x
        )
      );
      // Expectation for the next turn: flip to the language we just spoke
      // (conversation mode), or stay on the detected speaker (dictation mode).
      const next = autoFlipRef.current ? target : detected;
      if (next !== expectedRef.current) {
        expectedRef.current = next;
        setExpected(next);
      }
      if (autoSpeakRef.current && translation) {
        speak(translation, byCode(target)); // resumes mic in the new language when done
      } else {
        resyncRec();
      }
    } catch {
      setEntries((prev) => prev.map((x) => (x.id === en.id ? { ...x, status: "error" } : x)));
    }
  };

  const startEntry = (raw, source) => {
    const text = (raw || "").trim();
    if (!text) return;
    const id = ++idRef.current;
    const pairAt = [...pairRef.current];
    const expectedAt = expectedRef.current;
    const en = {
      id, raw: text, source, pairAt, expectedAt,
      side: Math.max(0, pairAt.indexOf(expectedAt)),
      srcCode: expectedAt,
      dstCode: pairAt[0] === expectedAt ? pairAt[1] : pairAt[0],
      status: "working",
    };
    setEntries((prev) => [...prev, en]);
    runTranslation(en);
  };
  useEffect(() => { startEntryRef.current = startEntry; });

  const retryEntry = (id) => {
    const en = entriesRef.current.find((x) => x.id === id);
    if (!en) return;
    setEntries((prev) => prev.map((x) => (x.id === id ? { ...x, status: "working" } : x)));
    runTranslation(en);
  };

  const sendTyped = () => {
    const t = typed.trim();
    if (!t) return;
    setTyped("");
    startEntry(t, "typed");
  };

  const clearAll = () => {
    try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch {}
    setEntries([]);
  };

  // ── Render ───────────────────────────────────────────────────────
  const expL = byCode(expected);
  const expSide = Math.max(0, pair.indexOf(expected));
  const missingTts =
    voices.length === 0
      ? []
      : pair.filter((c) => !voices.some((v) => v.lang && v.lang.toLowerCase().startsWith(c)));

  const statusLine = () => {
    if (speaking && speakCode) return <>Speaking — {byCode(speakCode).name}</>;
    if (listening && interim) return <span className="live" dir="auto">{interim}</span>;
    if (listening) return <>Listening — {expL.name} <span style={{ opacity: 0.55 }}>· tap a card to switch</span></>;
    if (!supported) return <>Voice needs Chrome, Edge or Safari — text box still works</>;
    return <>Tap to interpret</>;
  };

  return (
    <div className="root">
      <style>{CSS}</style>
      <div className="app">
        <header>
          <div className="wordmark">
            <span className="mark">
              <i style={{ background: ACCENTS[0] }} />
              <i style={{ background: ACCENTS[1] }} />
            </span>
            Puente
          </div>
          <div className="meta">
            live interpreter · v0.2 · {pair[0]} ⇄ {pair[1]}
            {!(byCode(pair[0]).verified && byCode(pair[1]).verified) && " · unverified pair"}
          </div>
        </header>

        <div className="pair-row">
          {[0, 1].map((i) => {
            const code = pair[i];
            const L = byCode(code);
            const active = expected === code;
            const card = (
              <div
                key={"card" + i}
                className={"lang-card" + (active ? " active" : "")}
                style={{ "--accent": ACCENTS[i] }}
                role="button"
                tabIndex={0}
                onClick={() => forceExpect(code)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); forceExpect(code); }
                }}
                title={"Set the mic to expect " + L.name + " next"}
              >
                <div className="lang-flag">{L.flag}</div>
                <select
                  value={code}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => changeLang(i, e.target.value)}
                  aria-label={"Language for side " + (i + 1)}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.name}</option>
                  ))}
                </select>
                <div className="lang-state">
                  {active ? (listening ? "listening" : "speaks next") : "\u00A0"}
                </div>
              </div>
            );
            return i === 0
              ? [card, (
                  <button key="swap" className="swap" onClick={swapPair} title="Swap sides" aria-label="Swap sides">
                    <ArrowLeftRight size={15} />
                  </button>
                )]
              : card;
          })}
        </div>

        {micError && (
          <div className="banner">
            <AlertTriangle size={15} />
            <span>{micError}</span>
          </div>
        )}

        {missingTts.length > 0 && (
          <div className="banner">
            <VolumeX size={15} />
            <span>
              No {missingTts.map((c) => byCode(c).name).join(" / ")} voice on this
              device — those translations appear as text only (listening in them
              still works).
            </span>
          </div>
        )}

        <div className="feed-head">
          <span>conversation</span>
          {entries.length > 0 && (
            <button className="icon-btn" onClick={clearAll} title="Clear conversation" aria-label="Clear conversation">
              <Trash2 size={14} />
            </button>
          )}
        </div>

        <div className="feed" ref={feedRef}>
          {entries.length === 0 ? (
            <div className="empty">
              <h2>Say something.</h2>
              <p>Tap the mic and speak either language — the other one comes back out loud. It listens for {expL.name} first and auto-corrects if it hears the other.</p>
              <span className="es">· di algo — el puente traduce ·</span>
            </div>
          ) : (
            entries.map((en) => {
              const srcL = byCode(en.srcCode);
              const dstL = byCode(en.dstCode);
              const side = en.side === 1 ? 1 : 0;
              return (
                <div
                  key={en.id}
                  className={"bubble " + (side === 0 ? "side-a" : "side-b")}
                  style={{ "--accent": ACCENTS[side] }}
                >
                  <div className="bubble-meta">
                    <span className="dir">{srcL.flag} {srcL.name} → {dstL.flag} {dstL.name}</span>
                    {en.corrected && <span className="chip">auto-detected</span>}
                    {en.status === "done" && en.translation && (
                      <button
                        className="icon-btn"
                        onClick={() => speak(en.translation, dstL)}
                        title="Play translation"
                        aria-label="Play translation"
                      >
                        <Volume2 size={14} />
                      </button>
                    )}
                  </div>

                  {en.status === "working" && (
                    <>
                      <div className="bubble-src" dir="auto">{en.raw}</div>
                      <div className="working"><Loader2 className="spin" size={13} /> translating…</div>
                    </>
                  )}

                  {en.status === "done" && (
                    <>
                      <div className="bubble-src" dir="auto" lang={en.srcCode} title={"heard: " + en.raw}>{en.cleaned}</div>
                      <div className="bubble-dst" dir="auto" lang={en.dstCode}>{en.translation}</div>
                    </>
                  )}

                  {en.status === "error" && (
                    <>
                      <div className="bubble-src" dir="auto">{en.raw}</div>
                      <div className="err-row">
                        translation failed
                        <button className="retry" onClick={() => retryEntry(en.id)}>retry</button>
                      </div>
                    </>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="dock">
          <div className="status">{statusLine()}</div>

          <button
            className={"mic" + (listening ? " listening" : "")}
            onClick={toggleListening}
            disabled={!supported}
            title={listening ? "Stop listening" : "Start listening"}
            aria-label={listening ? "Stop listening" : "Start listening"}
            aria-pressed={listening}
            style={listening ? { "--signal": ACCENTS[expSide], "--sol": ACCENTS[1 - expSide] } : undefined}
          >
            <span className="pulse p1" />
            <span className="pulse p2" />
            <span className="mic-inner">
              {speaking ? <Volume2 size={30} /> : <Mic size={30} />}
            </span>
          </button>

          <div className="toggles">
            <button
              className={"toggle" + (autoSpeak ? " on" : "")}
              onClick={() => { autoSpeakRef.current = !autoSpeakRef.current; setAutoSpeak(autoSpeakRef.current); }}
              title="Speak translations aloud"
            >
              {autoSpeak ? <Volume2 size={13} /> : <VolumeX size={13} />} auto-speak
            </button>
            <button
              className={"toggle" + (autoFlip ? " on" : "")}
              onClick={() => { autoFlipRef.current = !autoFlipRef.current; setAutoFlip(autoFlipRef.current); }}
              title="Conversation mode: after each turn, expect the other language. Turn off for one speaker dictating."
            >
              <Repeat size={13} /> auto-flip
            </button>
          </div>

          <div className="typedrow">
            <input
              dir="auto"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendTyped(); }}
              placeholder="Or type in either language…"
              aria-label="Type text to translate"
            />
            <button className="send" onClick={sendTyped} title="Translate" aria-label="Translate typed text">
              <Send size={16} />
            </button>
          </div>

          <div className="pipeline">web speech api → claude → speechsynthesis · mic pauses while speaking</div>
        </div>
      </div>
    </div>
  );
}
