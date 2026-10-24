# ⚡ AGY Web Console (`agy-web`)

Windows **ConPTY (Pseudo Console)** 파이프라인을 통해 로컬 웹 브라우저(`http://127.0.0.1:3080`)에서 실제 터미널을 열어 **Antigravity CLI (`agy`)**를 사용하는 것과 100% 동일한 경험을 제공하는 로컬 웹 콘솔 서버 및 브라우저 브릿지 플랫폼입니다.

단순한 `stdin/stdout` 파이프가 아닌 Windows 네이티브 가상 콘솔(`ConPTY`)과 `xterm.js`를 WebSocket으로 직결하여 대화형 TUI, 24-bit TrueColor, 슬래시 명령어 자동완성, 한글 IME 입력, 마우스 스크롤 및 창 크기 동기화를 완벽하게 지원하며, **내부/브라우저 북마크 관리**, **현재 열린 브라우저 탭 조회**, **네이버 메일(`mail.naver.com`) 읽기 및 콘솔 전달** 기능까지 통합되어 있습니다.

---

## 🏗️ 1. 시스템 아키텍처 (System Architecture)

```text
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           Web Browser (http://127.0.0.1:3080)                    │
│                                                                                  │
│  ┌──────────────────────────────┐   ┌─────────────────────────────────────────┐  │
│  │ xterm.js Terminal Viewport   │   │ 🧭 Browser & Mail Hub Drawer            │  │
│  │ - FitAddon (자동 해상도 맞춤) │   │ - ⭐ 내부 북마크 바 & 관리 (bookmarks.json)│  │
│  │ - Unicode11Addon (한글/TUI)  │   │ - 📧 네이버 메일 리더 (목록/본문 -> 콘솔) │  │
│  │ - WebLinksAddon (한글 분리)   │   │ - 📚 로컬 Chrome/Edge/Whale/Brave 북마크 │  │
│  │ - Ctrl+C / Ctrl+V 클립보드   │   │ - 🌐 열린 브라우저 탭/창 실시간 인스펙터  │  │
│  └──────────────┬───────────────┘   └────────────────────┬────────────────────┘  │
└─────────────────┼────────────────────────────────────────┼───────────────────────┘
                  │ WebSocket (/ws?sessionId=...)          │ REST API (/api/*)
                  ▼                                        ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                        Node.js Local Server (server.js)                          │
│                                                                                  │
│  ┌─────────────────────────────────────────┐  ┌───────────────────────────────┐  │
│  │ Always-On ConPTY Session Manager        │  │ Browser Bridge                │  │
│  │ - 서버 시작 시 상시 세션(session-primary)│  │ (browser-bridge.js)           │  │
│  │   백그라운드 선구동 및 자동 복구         │  │ - Chromium Bookmarks JSON 파서│  │
│  │ - 250KB Scrollback 버퍼 (질의 시퀀스 필터)│  │ - CDP (9222) 실시간 탭/DOM제어│  │
│  │ - /clear & cls 상태 인식 화면 초기화     │  │ - Win32 활성 브라우저 창 감지 │  │
│  └──────────────┬──────────────────────────┘  └───────────────┬───────────────┘  │
└─────────────────┼─────────────────────────────────────────────┼──────────────────┘
                  │ node-pty (Windows ConPTY, TrueColor)        │
                  ▼                                             ▼
┌────────────────────────────────────────────┐  ┌──────────────────────────────────┐
│ PowerShell (pwsh.exe / powershell.exe)     │  │ Local Browsers & Extension       │
│  ├─ PATH 최상단: ./bin (Start-Process 래퍼)│  │ - ./extension (Chrome/Edge MV3)  │
│  │               + Git Bash 우선 매핑      │  │ - mail.naver.com 메일/본문 추출  │
│  └─ 상시 실행: agy -c (--continue)          │  │ - 열린 탭 실시간 동기화          │
└────────────────────────────────────────────┘  └──────────────────────────────────┘
```

---

## ✨ 2. 주요 구현 기능 상세

### 2.1 네이티브 콘솔 파이프라인 및 상시(Always-On) 세션
- **Windows ConPTY 직결 (`useConpty: true`)**:
  - `xterm-256color` 및 `COLORTERM=truecolor` 환경을 구성하여 `agy`의 풀스크린/인라인 TUI 렌더링, 키보드 단축키, 화살표 탐색이 Windows Terminal과 동일하게 작동합니다.
- **백그라운드 상시 프로세스 (`session-primary`)**:
  - 브라우저가 접속할 때마다 PowerShell과 `agy`가 새로 켜지는 지연을 없애기 위해, **웹 서버(`server.js`)가 구동되는 즉시 백그라운드에서 상시 콘솔 세션을 미리 생성하고 `agy`를 실행**해 대기합니다.
  - 브라우저를 닫았다가 다시 열거나 새로고침(`F5`)하더라도 기존에 실행 중인 `agy` 화면 상태에 끊김 없이 즉시 이어서 접속됩니다.
- **대화 연속성 보장 (`agy -c` / `--continue`)**:
  - `.session-continuity.json` 상태 파일을 통해 서버가 재시작되더라도 `agy -c` 옵션으로 직전 대화 컨텍스트를 자동으로 이어서 복원합니다.
  - 상시 세션 프로세스가 종료될 경우 자동으로 백그라운드에서 재생성됩니다.
- **다중 세션(탭) 및 작업 경로(CWD) 지정**:
  - 상단 **`＋ 새 콘솔`** 및 **`📁 경로 지정`** 모달을 통해 원하는 로컬 프로젝트 폴더별로 여러 개의 독립된 PowerShell + `agy` 탭을 동시에 열어 작업할 수 있습니다. (탭 더블클릭 시 이름 변경 지원)

### 2.2 터미널 조작 편의성 개선 (`Ctrl+C`, `Ctrl+V`, 화면 클리어)
- **스마트 `Ctrl+C` 및 `Ctrl+V` 붙여넣기**:
  - **`Ctrl+V` / `Ctrl+Shift+V`**: 클립보드 텍스트를 읽어 `xterm.js`의 `term.paste()`로 전달함으로써 `agy` TUI의 Bracketed Paste 모드와 멀티라인 줄바꿈 정규화를 완벽히 지원합니다.
  - **`Ctrl+C` / `Ctrl+Shift+C`**: 마우스로 드래그하여 선택한 텍스트가 있을 때는 클립보드로 복사하고 선택을 해제하며, 선택 영역이 없을 때는 콘솔 인터럽트 시그널(`\x03`, `SIGINT`)을 전송합니다.
- **상태 인식 화면 지우기 (`🧹 화면 지우기`)**:
  - 단순히 브라우저 캔버스만 지우면 다음 키 입력 시 `agy` TUI가 이전 대화 버퍼를 다시 그리는 문제를 해결하기 위해, 서버가 현재 프롬프트 상태를 판별합니다.
  - `agy` TUI 내부일 때는 `Ctrl+U` -> `/clear` -> `Enter`를 순차 패킷으로 전송하여 `agy` 뷰포트와 대화 화면을 실제로 초기화하고, PowerShell 프롬프트(`PS C:\...>`) 상태일 때는 `cls`를 실행한 뒤 서버 스크롤백과 브라우저 스크롤백(`\x1b[2J\x1b[3J\x1b[H`)을 동시에 비웁니다.

### 2.3 스마트 URL 열기 및 중복 탭 방지
- **Bash `Start-Process` / `open` / `xdg-open` 호환 래퍼 (`./bin/`)**:
  - `agy` 내부의 `Bash` 도구가 Windows의 `WindowsApps\bash.exe`(WSL 스텁)를 호출해 `Start-Process: command not found` 오류가 발생하는 문제를 해결하기 위해, 세션 `PATH` 최상단에 `./bin` 래퍼 스크립트와 Git Bash 경로를 등록했습니다.
  - `agy`가 `Start-Process "https://..."`를 실행하면 `/api/open-url`을 호출하여 현재 보고 있는 브라우저에서 즉시 해당 URL을 엽니다.
- **터미널 내 URL 원클릭 열기 & 한글 조사 분리**:
  - `agy`가 마우스 트래킹 모드(`?1000h`)를 켠 상태에서도 `Ctrl+클릭` 없이 **일반 마우스 좌클릭**만으로 링크가 열립니다.
  - `https://mail.naver.com)을`처럼 URL 뒤에 한글 조사나 닫는 괄호가 붙어 있을 때 정규식과 `cleanTerminalUrl()`이 한글 조사 및 괄호를 자동으로 분리하여 정확한 주소로 이동합니다.
  - `file:///...` 로컬 파일 링크 클릭 시 브라우저 보안 차단을 우회하여 서버가 Windows 탐색기/기본 앱(`explorer.exe`)으로 직접 파일을 열어줍니다.
- **중복 탭 생성 원천 방지**:
  - TUI가 화면을 다시 그릴 때 이전 대화 기록의 `Start-Process` 문자열을 재감지하지 않도록 차단했습니다.
  - 동일한 URL(도메인+경로)을 다시 열 때는 `_blank`로 새 탭을 복제하지 않고, 결정론적 타겟 이름(`getStableTabTarget`) 및 열린 창 참조 맵(`openedTabWindows`)을 통해 **이미 열려 있는 탭으로 즉시 포커스를 이동(`existingWin.focus()`)**합니다.
  - CDP 활성화 시에는 `/json/activate/:id`로 기존 탭을 직접 활성화합니다.

### 2.4 내부 북마크 바 & 로컬 브라우저(Chrome/Edge/Whale/Brave) 북마크 연동
- **빠른 내부 북마크 바 (`⭐ 북마크`)**:
  - 툴바 하단에 상시 표시되며 `bookmarks.json`에 영구 저장됩니다.
  - 북마크 클릭 시 해당 탭으로 이동하고, 우측 **`⌨️` 버튼** 클릭 시 **현재 활성화된 `agy` 콘솔 입력창에 해당 URL을 즉시 타이핑**해 줍니다.
- **설치된 로컬 브라우저 북마크 자동 스캔 (`📚 브라우저 북마크`)**:
  - 별도 설정 없이 PC에 설치된 **Google Chrome, Microsoft Edge, Naver Whale, Brave**의 모든 프로필(`Default`, `Profile *`) 내 `Bookmarks` JSON 파일을 직접 파싱하여 검색·열기·콘솔 입력·내부 북마크 저장을 지원합니다.

### 2.5 현재 열린 브라우저 탭/창 인스펙터 (`🌐 열린 탭/창`)
- **3단계 하이브리드 탭 감지**:
  1. **실시간 전체 탭 (CDP 9222 포트 & 로컬 확장 프로그램)**: 열려 있는 모든 브라우저 탭의 정확한 제목과 URL을 실시간으로 표시합니다.
  2. **Windows 프로세스 활성 창 제목**: 별도 설정 없이도 현재 실행 중인 `chrome`, `msedge`, `whale`, `brave`, `firefox` 프로세스의 활성 창 제목과 PID를 즉시 조회합니다.
  3. **웹 콘솔에서 연 탭 & Chromium 세션(`Sessions/Session_*`, `Tabs_*`) URL 추출**: 최근 열린 탭 URL을 추출하여 바로 열거나 콘솔로 전달할 수 있습니다.

### 2.6 네이버 메일(`mail.naver.com`) 리더 및 콘솔 전달 (`📧 네이버 메일`)
- 열려 있는 네이버 메일 페이지에서 **메일 목록(안읽음 여부, 제목, 보낸사람, 날짜)**과 **현재 열려 있는 메일 본문**을 읽어와 웹 콘솔 우측 패널에 표시합니다.
- **3가지 연동 방식 모두 지원**:
  1. **북마크릿 (`📥 네이버 메일 → AGY 전송`)**: 현재 열려 있는 일반 브라우저를 재시작하거나 확장 프로그램을 설치할 필요 없이, 북마크 바에 드래그한 버튼을 네이버 메일 탭에서 클릭하면 즉시 메일 목록과 본문이 전송됩니다.
  2. **Chrome/Edge 확장 프로그램 (`./extension`)**: `chrome://extensions`에서 로드하면 네이버 메일 접속 시마다 백그라운드에서 100% 자동으로 메일과 열린 탭 목록을 동기화합니다.
  3. **CDP 연동 브라우저**: `[🔌 실시간 연동 브라우저로 네이버 메일 열기]` 클릭 시 네이버 메일 내부 JSON API(`/json/list`)와 DOM을 직접 제어하여 메일 목록 및 개별 본문(`📖 본문`)을 실시간으로 읽어옵니다.
- **`🤖 목록 콘솔로 전달` / `🤖 본문 콘솔에 전달`**:
  - 원클릭으로 최근 메일 목록 전체나 특정 메일 본문을 `agy` 프롬프트에 자동 입력하여 요약, 중요 메일 분류, 답장 초안 작성을 바로 지시할 수 있습니다.

---

## 📂 3. 프로젝트 디렉토리 구조

```text
C:\Users\meesokim\agy-web\
├── server.js                  # Express + WebSocket + node-pty(ConPTY) 메인 서버
├── browser-bridge.js          # 내부 북마크, 로컬 브라우저 북마크/탭/세션 파서, CDP 및 네이버 메일 브릿지
├── bookmarks.json             # 내부 북마크 영구 저장 파일 (자동 생성)
├── .session-continuity.json   # 상시 세션 대화 연속성(-c) 추적 상태 파일
├── package.json               # 프로젝트 의존성 정의
├── start.bat                  # PowerShell 실행 정책(ExecutionPolicy) 우회 원클릭 실행 배치 파일
├── README.md                  # 프로젝트 상세 문서
├── bin/                       # Bash 도구 호환용 URL 실행 래퍼 스크립트
│   ├── Start-Process          # agy Bash 도구에서 Start-Process 호출 시 /api/open-url 연동
│   ├── open                   # macOS 스타일 open 명령 래퍼
│   └── xdg-open               # Linux 스타일 xdg-open 명령 래퍼
├── extension/                 # 일반 Chrome/Edge 브라우저 자동 동기화용 확장 프로그램 (Manifest V3)
│   ├── manifest.json          # 확장 프로그램 매니페스트
│   ├── background.js          # 열린 모든 브라우저 탭 실시간 동기화 워커
│   └── content-naver-mail.js  # mail.naver.com 메일 목록 및 본문 자동 추출 스크립트
└── public/                    # 프론트엔드 정적 파일
    ├── index.html             # 메인 웹 콘솔 레이아웃, 북마크 바, 브라우저/메일 허브 드로어
    ├── style.css              # 다크 테마 터미널 및 허브 UI 스타일시트
    └── app.js                 # xterm.js 파이프라인, 단축키, 중복 탭 방지, 북마크/탭/메일 허브 로직
```

---

## 🔌 4. REST API 및 WebSocket 명세

### 4.1 콘솔 세션 API
| 메서드 | 경로 | 설명 |
| :--- | :--- | :--- |
| `GET` | `/api/sessions` | 활성 콘솔 세션 목록 조회 (세션이 없으면 상시 세션 자동 생성) |
| `POST` | `/api/sessions` | 새 콘솔 세션 생성 (`{ cwd, title, cols, rows, autoRunAgy }`) |
| `PATCH` | `/api/sessions/:id` | 세션 탭 이름 변경 (`{ title }`) |
| `DELETE` | `/api/sessions/:id` | 세션 종료 및 ConPTY 프로세스 정리 |
| `POST` | `/api/open-url` | URL 또는 로컬 `file://` 경로 열기 (`{ url, sessionId }`) |

### 4.2 북마크, 브라우저 탭 & 네이버 메일 API
| 메서드 | 경로 | 설명 |
| :--- | :--- | :--- |
| `GET` | `/api/bookmarks` | 내부 북마크 목록 조회 (`bookmarks.json`) |
| `POST` | `/api/bookmarks` | 내부 북마크 추가 (`{ title, url, category }`) |
| `PATCH` | `/api/bookmarks/:id` | 내부 북마크 수정 |
| `DELETE` | `/api/bookmarks/:id` | 내부 북마크 삭제 |
| `GET` | `/api/browser/bookmarks` | 로컬 설치 브라우저(Chrome, Edge, Whale, Brave) 북마크 전체 조회 |
| `GET` | `/api/browser/tabs` | 열린 브라우저 탭/창 조회 (CDP + 확장 프로그램 + Windows 창 + 세션 파일) |
| `POST` | `/api/browser/launch-cdp` | CDP(포트 9222) 및 확장 프로그램이 탑재된 브라우저 실행 |
| `POST` | `/api/browser/extension-tabs` | Chrome/Edge 확장 프로그램으로부터 실시간 탭 목록 수신 |
| `GET` | `/api/naver-mail` | 네이버 메일 목록 및 열린 메일 본문 조회 (`?readUrl=...` 지원) |
| `POST` | `/api/naver-mail/sync` | 확장 프로그램 또는 북마크릿으로부터 네이버 메일 데이터 수신 |

### 4.3 WebSocket 프로토콜 (`/ws?sessionId=<id>`)
- **Server → Client**:
  - `init`: `{ type: 'init', session, scrollback }` — 접속/새로고침 시 초기 메타데이터 및 정제된 스크롤백 전달
  - `output`: `{ type: 'output', data }` — 실시간 ConPTY ANSI 출력 스트림
  - `open_url`: `{ type: 'open_url', url }` — 콘솔 내부 명령으로 요청된 URL을 브라우저 탭에서 열기
  - `exit`: `{ type: 'exit', exitCode, signal }` — 프로세스 종료 알림
- **Client → Server**:
  - `input`: `{ type: 'input', data }` — 사용자 키 입력 및 붙여넣기 데이터 전달
  - `resize`: `{ type: 'resize', cols, rows }` — 브라우저 창 크기에 맞춘 ConPTY 크기 동기화
  - `clear`: `{ type: 'clear' }` — 현재 프롬프트 상태(`agy` vs `PowerShell`)에 맞춘 화면 및 버퍼 초기화

---

## 🚀 5. 설치 및 실행 방법

### 5.1 서버 실행
PowerShell 실행 정책(`ExecutionPolicy`)에 구애받지 않도록 포함된 `start.bat` 또는 `node` 명령으로 바로 실행할 수 있습니다.

```powershell
cd C:\Users\meesokim\agy-web
.\start.bat
# 또는
node server.js
```

### 5.2 웹 콘솔 접속
- 브라우저에서 **`http://127.0.0.1:3080`** 으로 접속합니다.
- 기본 포트(`3080`)를 변경하려면 환경 변수 `PORT`를 지정합니다:
  ```powershell
  $env:PORT=4000; node server.js
  ```

---

## 🛠️ 6. 전역 설치된 Antigravity Skills (`mattpocock/skills`)

`~/.gemini/config/skills/`(`C:\Users\meesokim\.gemini\config\skills\`) 경로에 [mattpocock/skills](https://github.com/mattpocock/skills)의 **27개 엔지니어링 및 생산성 스킬**이 함께 설치되어 있어 웹 콘솔 내 `agy`에서 즉시 호출할 수 있습니다.

- **Engineering (20종)**: `/setup-matt-pocock-skills`, `/ask-matt`, `/grill-with-docs`, `/domain-modeling`, `/codebase-design`, `/improve-codebase-architecture`, `/to-spec`, `/to-tickets`, `/wayfinder`, `/tdd`, `/implement`, `/implement-spec`, `/diagnosing-bugs`, `/code-review`, `/pr`, `/prototype`, `/research`, `/triage`, `/retro`, `/wizard`
- **Productivity (7종)**: `/grill-me`, `/grilling`, `/handoff`, `/teach`, `/to-questionnaire`, `/wait-what`, `/writing-for-agents`

---

## 🔧 7. 주요 트러블슈팅 및 기술적 해결 내역

1. **스크롤백 리플레이 시 TUI 화면 깨짐 및 모달 오작동 해결**:
   - `agy` 구동 시 출력되는 터미널 기능 질의 시퀀스(`CSI ? u`, `OSC 7501`, `DSR 6n`)와 임시 대체 화면(`\x1b[?1049h ... \x1b[?1049l`)이 `scrollback`에 남아 있으면, 브라우저 재접속 시 `xterm.js`가 이에 응답 바이트를 `term.onData`로 역전송하여 `agy` 입력으로 들어가는 현상이 발생합니다.
   - 이를 해결하기 위해 서버에서 질의 시퀀스 및 대체 화면 이전 버퍼를 필터링하고, 클라이언트에서도 `init` 리플레이 중에는 `onData` 송신을 음소거(`entry.isReplaying = true`)하도록 구현했습니다.
2. **화면 지우기(`🧹`) 후 입력 시 이전 대화 재출력 해결**:
   - 브라우저 로컬에서만 `term.clear()`를 호출하면 ConPTY 내부 화면 버퍼와 `agy` TUI 상태가 그대로 남아 다음 키 입력 시 이전 화면이 상단에 다시 그려집니다.
   - 서버가 `agy` TUI 상태인지 PowerShell 프롬프트 상태인지 감지하여 `/clear` 또는 `cls`를 분리된 패킷으로 전달해 ConPTY와 `agy` 내부 뷰포트를 실제로 초기화하도록 해결했습니다.
3. **PowerShell `npm.ps1` 실행 정책 차단 및 WSL `bash.exe` 충돌 해결**:
   - ConPTY 스폰 시 `-ExecutionPolicy Bypass`를 기본 적용하고, 세션 `PATH`에 `./bin` 래퍼와 Git Bash를 `WindowsApps\bash.exe`보다 우선 배치하여 `Start-Process` 명령이 언제나 정상 작동하도록 구성했습니다.
