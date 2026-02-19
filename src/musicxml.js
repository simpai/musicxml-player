const STEP_TO_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const STEP_TO_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_TYPE_TO_BEAT = {
  maxima: 32,
  longa: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  "16th": 0.25,
  "32nd": 0.125,
  "64th": 0.0625,
  "128th": 0.03125,
  "256th": 0.015625,
};

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

function noteBeatFromType(noteEl) {
  const type = textOf(noteEl, "type");
  let beat = type ? NOTE_TYPE_TO_BEAT[type] || 0 : 0;

  const dots = noteEl.querySelectorAll("dot").length;
  for (let i = 0; i < dots; i += 1) {
    beat += beat / Math.pow(2, i + 1);
  }

  const actual = Number(textOf(noteEl, "time-modification > actual-notes") || "0");
  const normal = Number(textOf(noteEl, "time-modification > normal-notes") || "0");
  if (Number.isFinite(actual) && Number.isFinite(normal) && actual > 0 && normal > 0) {
    beat *= normal / actual;
  }

  return beat;
}

function noteDurationBeat(noteEl, divisions, fallbackBeat = 0) {
  const durationText = textOf(noteEl, "duration");
  const durationRaw = Number(durationText);
  if (durationText != null && Number.isFinite(durationRaw) && durationRaw >= 0) {
    return divisions > 0 ? durationRaw / divisions : fallbackBeat;
  }

  const typeBeat = noteBeatFromType(noteEl);
  if (typeBeat > 0) return typeBeat;
  return fallbackBeat;
}

function parseTempoFromDirection(directionEl) {
  const soundTempoRaw = directionEl.querySelector("sound[tempo]")?.getAttribute("tempo") || "";
  const metronomeTempoRaw = textOf(directionEl, "metronome per-minute") || "";
  const soundTempo = Number(soundTempoRaw);
  const metronomeTempo = Number(metronomeTempoRaw);
  if (Number.isFinite(soundTempo) && soundTempo > 0) return soundTempo;
  if (Number.isFinite(metronomeTempo) && metronomeTempo > 0) return metronomeTempo;
  return null;
}

function buildTempoTrack(tempoEvents) {
  const sorted = [...tempoEvents].sort((a, b) => a.beat - b.beat);
  const deduped = [];
  for (const event of sorted) {
    if (deduped.length === 0) {
      deduped.push(event);
      continue;
    }
    const prev = deduped[deduped.length - 1];
    if (Math.abs(prev.beat - event.beat) < 1e-8) {
      prev.tempo = event.tempo;
    } else {
      deduped.push(event);
    }
  }

  if (deduped.length === 0 || deduped[0].beat > 0) {
    deduped.unshift({ beat: 0, tempo: 120 });
  } else if (deduped[0].beat < 0) {
    deduped[0].beat = 0;
  }

  return deduped;
}

function beatToSec(beat, tempoTrack) {
  const targetBeat = Math.max(0, beat);
  let sec = 0;
  let prevBeat = 0;
  let tempo = tempoTrack[0]?.tempo || 120;

  for (const event of tempoTrack) {
    if (event.beat <= prevBeat) {
      tempo = event.tempo;
      continue;
    }
    if (event.beat >= targetBeat) {
      break;
    }
    sec += (event.beat - prevBeat) * (60 / tempo);
    prevBeat = event.beat;
    tempo = event.tempo;
  }

  sec += (targetBeat - prevBeat) * (60 / tempo);
  return sec;
}

function parsePart(partEl, partName, partIndex) {
  const measures = Array.from(partEl.children).filter((el) => el.tagName === "measure");

  let divisions = 1;
  let currentBeat = 0;
  let lastChordStartBeat = 0;
  const notes = [];
  const measureMarkers = [];
  const tempoEvents = [];

  for (const measure of measures) {
    const measureStartBeat = currentBeat;
    let measureMaxBeat = currentBeat;
    measureMarkers.push({ beat: currentBeat, number: measure.getAttribute("number") || "" });

    const elements = Array.from(measure.children);
    const pendingGrace = [];

    const flushGraceBefore = (anchorBeat) => {
      if (pendingGrace.length === 0) return;

      const totalGraceBeat = pendingGrace.reduce((acc, note) => acc + note.durationBeat, 0);
      const startBeat = Math.max(measureStartBeat, anchorBeat - totalGraceBeat);
      let graceCursor = startBeat;
      let lastGraceStart = startBeat;

      for (const note of pendingGrace) {
        const noteStartBeat = note.isChord ? lastGraceStart : graceCursor;
        if (!note.isChord) {
          lastGraceStart = noteStartBeat;
          graceCursor += note.durationBeat;
        }

        notes.push({
          ...note,
          startBeat: noteStartBeat,
          endBeat: noteStartBeat + note.durationBeat,
        });
      }
      pendingGrace.length = 0;
    };

    for (const el of elements) {
      if (el.tagName === "attributes") {
        const innerDivValue = Number(textOf(el, "divisions") || "");
        if (Number.isFinite(innerDivValue) && innerDivValue > 0) {
          divisions = innerDivValue;
        }
        continue;
      }

      if (el.tagName === "direction") {
        const tempo = parseTempoFromDirection(el);
        if (tempo != null) {
          tempoEvents.push({ beat: currentBeat, tempo });
        }
        continue;
      }

      if (el.tagName === "backup" || el.tagName === "forward") {
        flushGraceBefore(currentBeat);
        const durationRaw = Number(textOf(el, "duration") || "0");
        const durationBeat = divisions > 0 ? durationRaw / divisions : 0;
        const sign = el.tagName === "backup" ? -1 : 1;
        currentBeat = Math.max(measureStartBeat, currentBeat + sign * durationBeat);
        measureMaxBeat = Math.max(measureMaxBeat, currentBeat);
        continue;
      }

      if (el.tagName !== "note") continue;

      const noteEl = el;
      const isChord = Boolean(noteEl.querySelector("chord"));
      const isRest = Boolean(noteEl.querySelector("rest"));
      const isGrace = Boolean(noteEl.querySelector("grace"));
      const voice = textOf(noteEl, "voice") || "1";
      const staff = textOf(noteEl, "staff") || "1";

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

      const durationBeat = isGrace
        ? noteDurationBeat(noteEl, divisions, 0.125)
        : noteDurationBeat(noteEl, divisions, 0);

      const noteCommon = {
        durationBeat,
        isRest,
        isGrace,
        isChord,
        midi,
        diatonic,
        alter,
        partIndex,
        partName,
        voice,
        staff,
      };

      if (isGrace) {
        pendingGrace.push(noteCommon);
        continue;
      }

      if (!isChord) {
        flushGraceBefore(currentBeat);
      }

      const startBeat = isChord ? lastChordStartBeat : currentBeat;
      notes.push({
        ...noteCommon,
        startBeat,
        endBeat: startBeat + durationBeat,
      });

      if (!isChord) {
        lastChordStartBeat = currentBeat;
        currentBeat += durationBeat;
        measureMaxBeat = Math.max(measureMaxBeat, currentBeat);
      }
    }

    flushGraceBefore(currentBeat);
    currentBeat = measureMaxBeat;
  }

  return { partName, notes, measureMarkers, tempoEvents, totalBeat: currentBeat };
}

export function parseMusicXML(xmlText) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(xmlText, "application/xml");
  if (xml.querySelector("parsererror")) {
    throw new Error("MusicXML 파싱에 실패했습니다.");
  }

  const partNameById = new Map();
  for (const scorePart of Array.from(xml.querySelectorAll("part-list > score-part"))) {
    const id = scorePart.getAttribute("id") || "";
    partNameById.set(id, textOf(scorePart, "part-name") || "Unknown Part");
  }

  const partEls = Array.from(xml.querySelectorAll("score-partwise > part"));
  if (partEls.length === 0) {
    throw new Error("MusicXML에 part가 없습니다.");
  }

  const parsedParts = partEls.map((partEl, index) => {
    const partId = partEl.getAttribute("id") || "";
    const partName = partNameById.get(partId) || `Part ${index + 1}`;
    return parsePart(partEl, partName, index);
  });

  const tempoTrack = buildTempoTrack(parsedParts.flatMap((part) => part.tempoEvents));

  const notes = parsedParts
    .flatMap((part) => part.notes)
    .map((note) => {
      const startSec = beatToSec(note.startBeat, tempoTrack);
      const endSec = beatToSec(note.endBeat, tempoTrack);
      const durationSec = Math.max(0, endSec - startSec);
      return { ...note, startSec, endSec, durationSec };
    })
    .sort((a, b) => (a.startSec - b.startSec) || (a.partIndex - b.partIndex) || (a.midi || 0) - (b.midi || 0));

  const markerSource = parsedParts[0]?.measureMarkers || [];
  const measureMarkers = markerSource.map((marker) => ({
    number: marker.number,
    beat: marker.beat,
    sec: beatToSec(marker.beat, tempoTrack),
  }));

  const totalDurationSec = notes.reduce((acc, note) => Math.max(acc, note.endSec), 0);
  const partNames = parsedParts.map((part) => part.partName);
  const partName =
    partNames.length <= 1 ? partNames[0] || "Unknown Part" : `${partNames[0]} 외 ${partNames.length - 1}개 파트`;

  return { partName, partNames, notes, measureMarkers, totalDurationSec };
}

export function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
