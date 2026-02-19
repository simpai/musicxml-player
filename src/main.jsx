import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JSZip from "jszip";
import { midiToFrequency, parseMusicXML } from "./musicxml.js";
import "./app.css";

const audioState = { ctx: null, nodes: [] };
const PLAYBACK_OFFSET_SEC = 0.12;
const MIN_NOTE_SEC = 0.02;
const VEROVIO_SCRIPT_SRC = "https://www.verovio.org/javascript/latest/verovio-toolkit-wasm.js";

function stopAudio() {
  for (const { osc, gain } of audioState.nodes) {
    try {
      osc.stop();
    } catch (_) {}
    try {
      osc.disconnect();
      gain.disconnect();
    } catch (_) {}
  }
  audioState.nodes = [];
}

async function ensureAudioContext() {
  if (!audioState.ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioState.ctx = new Ctx();
  }
  if (audioState.ctx.state === "suspended") {
    await audioState.ctx.resume();
  }
  return audioState.ctx;
}

function schedulePlayback(notes, audioCtx, offsetSec) {
  stopAudio();
  const playbackStartSec = audioCtx.currentTime + offsetSec;
  const playableNotes = notes.filter((note) => !note.isRest && note.midi != null);

  for (const note of playableNotes) {
    const start = playbackStartSec + note.startSec;
    const durationSec = Math.max(note.durationSec || 0, MIN_NOTE_SEC);
    const end = start + durationSec;
    const attackEnd = Math.min(start + 0.02, end - 0.001);

    if (!(end > start + 0.001)) continue;

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(midiToFrequency(note.midi), start);

    gain.gain.setValueAtTime(0.0001, start);
    if (attackEnd > start + 0.0005) {
      gain.gain.exponentialRampToValueAtTime(0.24, attackEnd);
    } else {
      gain.gain.setValueAtTime(0.24, start + 0.001);
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(start);
    osc.stop(end + 0.03);

    audioState.nodes.push({ osc, gain });
  }

  return { playbackStartSec };
}

async function extractXmlFromMxl(arrayBuffer) {
  const zip = await JSZip.loadAsync(arrayBuffer);
  let xmlPath = "";

  const containerFile = zip.file("META-INF/container.xml");
  if (containerFile) {
    const containerText = await containerFile.async("text");
    const doc = new DOMParser().parseFromString(containerText, "application/xml");
    xmlPath = doc.querySelector("rootfile")?.getAttribute("full-path") || "";
  }

  if (!xmlPath) {
    const fallback = Object.keys(zip.files).find(
      (name) => !zip.files[name].dir && !name.startsWith("META-INF/") && /\.(musicxml|xml)$/i.test(name)
    );
    xmlPath = fallback || "";
  }

  if (!xmlPath || !zip.file(xmlPath)) {
    throw new Error("MXL 내부에서 MusicXML 문서를 찾지 못했습니다.");
  }

  return zip.file(xmlPath).async("text");
}

async function loadMusicXmlText(path) {
  const res = await fetch(`/samples/${path}?ts=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("MusicXML 파일을 불러오지 못했습니다.");

  if (/\.mxl$/i.test(path)) {
    return extractXmlFromMxl(await res.arrayBuffer());
  }

  return res.text();
}

function ensureVerovioScript() {
  return new Promise((resolve, reject) => {
    if (window.verovio?.toolkit) {
      resolve(window.verovio);
      return;
    }

    const existing = document.querySelector(`script[data-verovio="1"]`);
    if (existing) {
      const onLoad = () => resolve(window.verovio);
      const onError = () => reject(new Error("Verovio 스크립트 로딩 실패"));
      existing.addEventListener("load", onLoad, { once: true });
      existing.addEventListener("error", onError, { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = VEROVIO_SCRIPT_SRC;
    script.defer = true;
    script.dataset.verovio = "1";
    script.onload = () => resolve(window.verovio);
    script.onerror = () => reject(new Error("Verovio 스크립트 로딩 실패"));
    document.head.appendChild(script);
  });
}

function waitForVerovioRuntime(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const vrv = window.verovio;
      if (vrv?.toolkit) {
        const mod = vrv.module;
        if (!mod || mod.runtimeInitialized || mod.calledRun) {
          resolve(vrv);
          return;
        }
        const prev = mod.onRuntimeInitialized;
        mod.onRuntimeInitialized = () => {
          if (typeof prev === "function") prev();
          resolve(vrv);
        };
        return;
      }

      if (Date.now() - start > timeoutMs) {
        reject(new Error("Verovio 런타임 초기화 실패"));
        return;
      }
      setTimeout(poll, 60);
    };
    poll();
  });
}

async function ensureVerovioToolkit(toolkitRef) {
  await ensureVerovioScript();
  const verovio = await waitForVerovioRuntime();
  if (!verovio?.toolkit) {
    throw new Error("Verovio toolkit을 사용할 수 없습니다.");
  }

  if (!toolkitRef.current) {
    const toolkit = new verovio.toolkit();
    toolkit.setOptions({
      pageHeight: 2800,
      pageWidth: 1900,
      scale: 36,
      adjustPageHeight: 1,
      footer: "none",
      header: "none",
    });
    toolkitRef.current = toolkit;
  }

  return toolkitRef.current;
}

function renderWithVerovio(container, toolkit, xmlText) {
  container.innerHTML = "";
  toolkit.loadData(xmlText);
  const pageCount = Number(toolkit.getPageCount() || 0);
  for (let page = 1; page <= pageCount; page += 1) {
    const pageSvg = toolkit.renderToSVG(page, {});
    const pageEl = document.createElement("div");
    pageEl.innerHTML = pageSvg;
    container.appendChild(pageEl);
  }
}

function App() {
  const [sampleList, setSampleList] = useState([]);
  const [selectedPath, setSelectedPath] = useState("");
  const [selectedTitle, setSelectedTitle] = useState("");
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState("");
  const [isPlaying, setIsPlaying] = useState(false);
  const [playTime, setPlayTime] = useState(0);

  const playbackStartAudioSecRef = useRef(0);
  const rafRef = useRef(0);
  const viewportRef = useRef(null);
  const sheetContainerRef = useRef(null);
  const verovioToolkitRef = useRef(null);

  useEffect(() => {
    fetch("/samples/index.json?ts=" + Date.now(), { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("샘플 목록을 불러오지 못했습니다.");
        return res.json();
      })
      .then((list) => {
        setSampleList(list);
        if (list.length > 0) {
          setSelectedPath(list[0].file);
          setSelectedTitle(list[0].title);
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selectedPath || !sheetContainerRef.current) return;
    let cancelled = false;

    const run = async () => {
      try {
        setError("");
        setPlayTime(0);
        setIsPlaying(false);
        setParsed(null);
        stopAudio();
        if (rafRef.current) cancelAnimationFrame(rafRef.current);
        if (viewportRef.current) viewportRef.current.scrollLeft = 0;
        sheetContainerRef.current.innerHTML = "";

        const xmlText = await loadMusicXmlText(selectedPath);
        if (cancelled) return;

        const parsedResult = parseMusicXML(xmlText);
        setParsed(parsedResult);

        const toolkit = await ensureVerovioToolkit(verovioToolkitRef);
        if (cancelled) return;
        renderWithVerovio(sheetContainerRef.current, toolkit, xmlText);
      } catch (e) {
        setError(e.message || "파일 로딩 실패");
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [selectedPath]);

  useEffect(() => {
    if (!parsed || parsed.notes.length === 0) return;

    let cancelled = false;
    const run = async () => {
      try {
        const ctx = await ensureAudioContext();
        if (cancelled) return;
        const controller = schedulePlayback(parsed.notes, ctx, PLAYBACK_OFFSET_SEC);
        setIsPlaying(true);
        playbackStartAudioSecRef.current = controller.playbackStartSec;

        const tick = () => {
          const t = Math.max(0, ctx.currentTime - playbackStartAudioSecRef.current);
          const clamped = Math.min(t, parsed.totalDurationSec);
          setPlayTime(clamped);
          if (clamped >= parsed.totalDurationSec) {
            setIsPlaying(false);
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
        };

        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        setError(`오디오 시작 실패: ${e.message}`);
      }
    };

    run();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      setIsPlaying(false);
      setPlayTime(0);
      stopAudio();
    };
  }, [parsed]);

  useEffect(() => {
    if (!viewportRef.current || !parsed || parsed.totalDurationSec <= 0) return;
    const maxScroll = Math.max(0, viewportRef.current.scrollWidth - viewportRef.current.clientWidth);
    const progress = Math.min(1, Math.max(0, playTime / parsed.totalDurationSec));
    viewportRef.current.scrollLeft = progress * maxScroll;
  }, [playTime, parsed]);

  const currentMeasure = useMemo(() => {
    if (!parsed) return "-";
    let number = "-";
    for (const m of parsed.measureMarkers) {
      if (playTime >= m.sec) number = m.number;
      else break;
    }
    return number;
  }, [parsed, playTime]);

  return (
    <div className="app-shell">
      <section className="top-pane">
        <h1>내장 MusicXML</h1>
        <div className="sample-list">
          {sampleList.map((item) => (
            <button
              key={item.file}
              className={item.file === selectedPath ? "sample-item active" : "sample-item"}
              onClick={() => {
                setSelectedPath(item.file);
                setSelectedTitle(item.title);
              }}
            >
              <span className="title">{item.title}</span>
              <span className="meta">{item.duration}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="bottom-pane">
        <div className="status-row">
          <div>
            <strong>{selectedTitle || "선택된 파일 없음"}</strong>
            <span>{parsed?.partName ? ` (${parsed.partName})` : ""}</span>
          </div>
          <div className="time-badge">
            {isPlaying ? "재생 중" : "대기"} | {playTime.toFixed(1)}s / {(parsed?.totalDurationSec || 0).toFixed(1)}s | 마디 {currentMeasure}
          </div>
        </div>

        <div className="preview-viewport" ref={viewportRef}>
          <div className="score-track">
            <div className="sheet-container" ref={sheetContainerRef} />
          </div>
        </div>

        {error ? <div className="error">{error}</div> : null}
      </section>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);
