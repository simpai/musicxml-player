# MusicXML Preview Player (React + Vite)

요구사항 기반으로 만든 프로토타입입니다.

## 실행

프로젝트 루트(`/home/simpai/musicxml-player`)에서:

```bash
cd /home/simpai/musicxml-player
npm install
npm run dev
```

브라우저에서 `http://localhost:5173` 접속.

## 포함 기능

- 상단: 내장 MusicXML 목록(타일형)
- 하단: 선택 파일 자동 미리보기 + 자동 재생
- verovio 기반 악보 렌더링
- MusicXML 노트의 음정/박자 기반 오디오 재생(Web Audio)
- 재생 진행률 기반 자동 가로 스크롤
- `.musicxml/.xml` 뿐 아니라 `.mxl`(압축 바이너리 MusicXML)도 로드 지원

## 샘플 파일

- `public/samples/bright-steps-30s.musicxml`
- `public/samples/arpeggio-flow-30s.musicxml`
- `public/samples/gentle-motion-30s.musicxml`

세 파일 모두 템포 120, 4/4, 총 60박(약 30초)입니다.

## 사용자 파일 추가 방법

1. 파일을 `public/samples/` 아래에 복사
2. `public/samples/index.json`에 항목 추가

예시:

```json
{"title":"내 파일", "file":"my-song.mxl", "duration":"약 40초"}
```

`file`은 `.musicxml`, `.xml`, `.mxl` 모두 가능합니다.
