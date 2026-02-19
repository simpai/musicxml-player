const STEP_TO_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function textOf(parent, selector) {
  const node = parent.querySelector(selector);
  return node ? node.textContent.trim() : null;
}

function midiFromPitch(step, alter, octave) {
  const semitone = STEP_TO_SEMITONE[step] + alter;
  return (octave + 1) * 12 + semitone;
}

function diatonicFromPitch(step, octave) {
  return octave * 7 + STEP_TO_INDEX[step];
}

export function parseMusicXML(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");

  if (xml.querySelector("parsererror")) {
    throw new Error("MusicXML 파싱에 실패했습니다.");
  }

  const partName = textOf(xml, "part-list score-part part-name") || "Unknown Part";
  const part = xml.querySelector("score-partwise > part");
  if (!part) {
    throw new Error("MusicXML에 part가 없습니다.");
  }

  const measures = Array.from(part.children).filter((el) => el.tagName === "measure");

  let divisions = 1;
  let tempo = 120;
  let currentTimeSec = 0;
  let currentBeat = 0;
  let lastChordStartSec = 0;
  let lastChordStartBeat = 0;
  const notes = [];
  const measureMarkers = [];

  for (const measure of measures) {
    measureMarkers.push({ beat: currentBeat, sec: currentTimeSec, number: measure.getAttribute("number") || "" });
    const measureStartSec = currentTimeSec;
    const measureStartBeat = currentBeat;
    let measureMaxSec = currentTimeSec;
    let measureMaxBeat = currentBeat;

    const divValue = textOf(measure, "attributes > divisions");
    if (divValue) {
      divisions = Number(divValue);
    }

    const soundNode = measure.querySelector("direction > sound[tempo]");
    const soundTempo = soundNode ? soundNode.getAttribute("tempo") : null;
    const metronomeTempo = textOf(measure, "direction metronome per-minute");
    const maybeTempo = Number(soundTempo || metronomeTempo || tempo);
    if (Number.isFinite(maybeTempo) && maybeTempo > 0) {
      tempo = maybeTempo;
    }

    const elements = Array.from(measure.children);

    for (const el of elements) {
      if (el.tagName === "attributes") {
        const innerDivValue = textOf(el, "divisions");
        if (innerDivValue) {
          divisions = Number(innerDivValue);
        }
        continue;
      }

      if (el.tagName === "direction") {
        const soundTempo = el.querySelector("sound[tempo]")?.getAttribute("tempo") || null;
        const metronomeTempo = textOf(el, "metronome per-minute");
        const maybeTempoInDirection = Number(soundTempo || metronomeTempo || tempo);
        if (Number.isFinite(maybeTempoInDirection) && maybeTempoInDirection > 0) {
          tempo = maybeTempoInDirection;
        }
        continue;
      }

      if (el.tagName === "backup" || el.tagName === "forward") {
        const durationRaw = Number(textOf(el, "duration") || "0");
        const durationBeat = durationRaw / divisions;
        const durationSec = durationBeat * (60 / tempo);
        const sign = el.tagName === "backup" ? -1 : 1;

        currentTimeSec = Math.max(measureStartSec, currentTimeSec + sign * durationSec);
        currentBeat = Math.max(measureStartBeat, currentBeat + sign * durationBeat);
        measureMaxSec = Math.max(measureMaxSec, currentTimeSec);
        measureMaxBeat = Math.max(measureMaxBeat, currentBeat);
        continue;
      }

      if (el.tagName !== "note") continue;

      const noteEl = el;
      const durationRaw = Number(textOf(noteEl, "duration") || "0");
      const durationBeat = durationRaw / divisions;
      const durationSec = durationBeat * (60 / tempo);
      const isChord = Boolean(noteEl.querySelector("chord"));
      const isRest = Boolean(noteEl.querySelector("rest"));

      const startSec = isChord ? lastChordStartSec : currentTimeSec;
      const startBeat = isChord ? lastChordStartBeat : currentBeat;

      let midi = null;
      let diatonic = null;
      let alter = 0;

      if (!isRest) {
        const step = textOf(noteEl, "pitch > step") || "C";
        alter = Number(textOf(noteEl, "pitch > alter") || "0");
        const octave = Number(textOf(noteEl, "pitch > octave") || "4");
        midi = midiFromPitch(step, alter, octave);
        diatonic = diatonicFromPitch(step, octave);
      }

      notes.push({
        startSec,
        durationSec,
        endSec: startSec + durationSec,
        startBeat,
        durationBeat,
        isRest,
        midi,
        diatonic,
        alter,
      });

      if (!isChord) {
        lastChordStartSec = currentTimeSec;
        lastChordStartBeat = currentBeat;
        currentTimeSec += durationSec;
        currentBeat += durationBeat;
        measureMaxSec = Math.max(measureMaxSec, currentTimeSec);
        measureMaxBeat = Math.max(measureMaxBeat, currentBeat);
      }
    }

    currentTimeSec = measureMaxSec;
    currentBeat = measureMaxBeat;
  }

  const totalDurationSec = notes.reduce((acc, note) => Math.max(acc, note.endSec), 0);
  return { partName, notes, measureMarkers, totalDurationSec };
}

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
