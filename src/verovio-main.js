import JSZip from "jszip";
import "./basic.css";

const app = document.getElementById("app");
app.innerHTML = `
  <div class="toolbar">
    <label for="sampleSelect">샘플</label>
    <select id="sampleSelect"></select>
    <button id="reloadBtn" type="button">다시 렌더</button>
    <span class="status" id="status">초기화 중...</span>
  </div>
  <div class="sheet-wrap">
    <div class="sheet" id="sheet"></div>
  </div>
`;

const sampleSelect = document.getElementById("sampleSelect");
const reloadBtn = document.getElementById("reloadBtn");
const statusEl = document.getElementById("status");
const sheetEl = document.getElementById("sheet");

let toolkit = null;

function setStatus(text) {
  statusEl.textContent = text;
}

function waitForVerovio(timeoutMs = 20000) {
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
        reject(new Error("Verovio 스크립트를 불러오지 못했습니다."));
        return;
      }
      setTimeout(poll, 60);
    };
    poll();
  });
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

async function loadXmlText(filePath) {
  const res = await fetch(`/samples/${filePath}?ts=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`파일 로딩 실패: ${filePath}`);

  if (/\.mxl$/i.test(filePath)) {
    return extractXmlFromMxl(await res.arrayBuffer());
  }
  return res.text();
}

function ensureToolkit(vrv) {
  if (!toolkit) {
    toolkit = new vrv.toolkit();
    toolkit.setOptions({
      pageHeight: 2800,
      pageWidth: 1900,
      scale: 36,
      adjustPageHeight: 1,
      footer: "none",
      header: "none",
    });
  }
}

async function renderSelected() {
  const filePath = sampleSelect.value;
  if (!filePath) return;

  setStatus(`렌더링 중: ${filePath}`);
  sheetEl.innerHTML = "";

  try {
    const vrv = await waitForVerovio();
    ensureToolkit(vrv);
    const xmlText = await loadXmlText(filePath);

    toolkit.loadData(xmlText);
    const pageCount = Number(toolkit.getPageCount() || 0);

    if (pageCount <= 0) {
      throw new Error("렌더링 가능한 페이지가 없습니다.");
    }

    for (let page = 1; page <= pageCount; page += 1) {
      const svg = toolkit.renderToSVG(page, {});
      const pageEl = document.createElement("div");
      pageEl.innerHTML = svg;
      sheetEl.appendChild(pageEl);
    }

    setStatus(`완료: ${filePath} (페이지 ${pageCount})`);
  } catch (err) {
    setStatus(`오류: ${err.message}`);
  }
}

async function init() {
  try {
    setStatus("샘플 목록 로딩 중...");
    const res = await fetch(`/samples/index.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("샘플 목록 로딩 실패");

    const list = await res.json();
    sampleSelect.innerHTML = list
      .map((item) => `<option value="${item.file}">${item.title} (${item.file})</option>`)
      .join("");

    await renderSelected();
  } catch (err) {
    setStatus(`오류: ${err.message}`);
  }
}

sampleSelect.addEventListener("change", () => {
  renderSelected();
});

reloadBtn.addEventListener("click", () => {
  renderSelected();
});

init();
