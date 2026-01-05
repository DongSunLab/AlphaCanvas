# 🎨 AlphaCanvas

**AI-Powered Mathematical Graph Drawing Tool**

수학 도형과 그래프를 AI 에이전트와 함께 작도하는 웹 기반 도구

[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.109+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)

[English](#english) | [한국어](#한국어)

---

## English

### ✨ Features

#### 🖊️ Drawing Tools
- **Lines & Segments** - Draw lines, segments, and rays through two points
- **Bézier Curves** - Create smooth curves with control points
- **Circles** - Draw circles using center+point or three points
- **Tangent Lines** - Draw tangent lines at any point on curves
- **Angle Markers** - Display angles between two lines
- **Area Fill** - Paint closed regions with colors
- **Math Labels** - Render mathematical expressions with KaTeX

#### 🤖 AI Agent Integration
- Natural language drawing commands
- Context-aware conversation with history
- Graph state analysis and modification
- Auto-calculate intersections, lengths, angles
- Supports **GPT-5.2**, **Gemini**, and **Claude**

#### 📤 Export & Utilities
- SVG export (100mm standard)
- Clipboard copy (Ctrl+C)
- Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
- Pan & Zoom navigation
- Magnifier mode

### 🛠️ Tech Stack

| Frontend | Backend |
|----------|---------|
| React 19 | FastAPI |
| TypeScript | OpenAI API |
| PixiJS (2D Rendering) | Google Gemini API |
| Zustand (State) | Anthropic Claude API |
| D3.js (Interactions) | WebSocket |
| KaTeX (Math) | - |

### 🚀 Quick Start

```bash
# Clone
git clone https://github.com/DongSunLab/AlphaCanvas.git
cd AlphaCanvas

# Backend setup
pip install -r requirements.txt

# Frontend setup
cd frontend
npm install

# Run backend (from project root)
python -m uvicorn backend.app.main:app --reload --port 8000

# Run frontend (in another terminal)
cd frontend
npm run dev
```

Then open http://localhost:5173

### 📖 Usage Examples

```
"Draw y = x^2 graph"
"Draw a line passing through the origin"
"Find the intersection of these two lines"
"Draw a tangent line at this point"
```

---

## 한국어

### ✨ 주요 기능

#### 🖊️ 작도 도구
- **직선 및 선분** - 두 점을 지정하여 직선, 선분, 반직선 그리기
- **베지어 곡선** - 부드러운 곡선 작도
- **원** - 세 점 또는 중심과 한 점으로 원 그리기
- **접선** - 곡선 위의 점에서 접선 그리기
- **각도 표시** - 두 직선 사이의 각도 표시
- **영역 페인트** - 닫힌 영역에 색상 채우기
- **수식 라벨** - KaTeX를 사용한 수학 수식 표시

#### 🤖 AI 에이전트
- 자연어로 작도 명령
- 대화 이력 기반 컨텍스트 유지
- 그래프 상태 분석 및 수정
- 교점, 길이, 각도 등 자동 계산
- **GPT-5.2**, **Gemini**, **Claude** 지원

#### 📤 내보내기 및 편의 기능
- SVG 내보내기 (100mm 기준)
- 클립보드 복사 (Ctrl+C)
- 실행 취소/다시 실행 (Ctrl+Z / Ctrl+Shift+Z)
- 팬/줌 네비게이션
- 돋보기 모드

### 🚀 빠른 시작

```bash
# 클론
git clone https://github.com/DongSunLab/AlphaCanvas.git
cd AlphaCanvas

# 백엔드 설정
pip install -r requirements.txt

# 프론트엔드 설정
cd frontend
npm install

# 백엔드 실행 (프로젝트 루트에서)
python -m uvicorn backend.app.main:app --reload --port 8000

# 프론트엔드 실행 (다른 터미널에서)
cd frontend
npm run dev
```

브라우저에서 http://localhost:5173 접속

### ⌨️ 단축키

| 단축키 | 기능 |
|--------|------|
| `Ctrl+C` | SVG 클립보드 복사 |
| `Ctrl+Z` | 실행 취소 |
| `Ctrl+Shift+Z` | 다시 실행 |
| `Delete` | 선택한 객체 삭제 |
| `마우스 휠` | 줌 인/아웃 |
| `마우스 드래그` | 팬 (이동) |

### 🔑 환경 변수 설정

프로젝트 루트에 `.env` 파일 생성:

```env
OPENAI_API_KEY=your_openai_api_key
GOOGLE_API_KEY=your_gemini_api_key
ANTHROPIC_API_KEY=your_claude_api_key
CORS_ORIGINS=http://localhost:5173,http://localhost:8000
```

### 📁 프로젝트 구조

```
AlphaCanvas/
├── frontend/              # React + TypeScript 프론트엔드
│   ├── src/
│   │   ├── App.tsx       # 메인 앱
│   │   ├── components/   # UI 컴포넌트
│   │   ├── renderer/     # PixiJS 렌더링
│   │   ├── geometry/     # 기하학 연산
│   │   ├── state/        # Zustand 상태 관리
│   │   └── workers/      # Web Workers
│   └── package.json
├── backend/              # FastAPI 백엔드
│   └── app/
│       ├── main.py       # 메인 서버
│       ├── agent.py      # AI 에이전트
│       ├── llm.py        # LLM 클라이언트
│       └── compute.py    # 기하학 계산
└── requirements.txt      # Python 의존성
```

### 🌐 API 엔드포인트

| 엔드포인트 | 설명 |
|------------|------|
| `GET /health` | 헬스 체크 |
| `WebSocket /ws` | AI 에이전트 실시간 통신 |
| `POST /api/intersections` | 교점 계산 |

---
