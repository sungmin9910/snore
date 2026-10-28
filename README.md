# 🌙 슬립센스 (SleepSense) - 아이폰 최적화 초저발열·원거리 수면 소리 감지 웹앱

코골이, 잠꼬대, 이갈이(마찰음) 및 미세 수면 소음을 감지했을 때만 앞뒤 여백(2.5초 사전 버퍼 포함)을 붙여 짧은 `WAV` 조각으로 저장하는 스마트 수면 레코더입니다.

## ✨ 핵심 설계 특징

1. **발열 완전 차단 아키텍처 (Zero-Heat Blackout Mode)**
   - `[🌑 수면용 암전 화면 켜기]` 진입 시 브라우저의 `requestAnimationFrame` 그래픽/캔버스 렌더링과 DOM 업데이트를 **100% 중단**하여 GPU 부하를 0%로 만듭니다.
   - 암전 진입 5초 후 안내 문구까지 완전히 소등(`.pure-zero-pixel`)되어 **아이폰 OLED 디스플레이의 모든 픽셀이 물리적으로 꺼집니다.**
   - 오디오 엔진을 `16kHz` 모노 저전력 파이프라인으로 구동하며, 주파수 분류 연산은 소리가 실제로 감지된 순간에만 동작합니다.

2. **원거리·사소한 소리 포착 엔진 (Long-Range Micro-Sound Detection)**
   - 브라우저 기본 WebRTC 노이즈 억제(`noiseSuppression`)를 해제하여 작은 이갈이나 코골이가 지워지는 현상을 방지했습니다.
   - **Pre-Amp 디지털 증폭기(`GainNode`, 최대 15배 / +23.5dB)**와 **80Hz 고역통과 필터(`BiquadFilterNode`)**를 결합해 에어컨/냉장고 저주파 웅웅거림은 걸러내고 먼 거리의 작은 소리만 선명하게 증폭합니다.
   - **2.5초 사전 녹음 순환 버퍼(Pre-Roll Circular Buffer)**: 소리가 감지되기 2.5초 전의 소리부터 파일에 포함시켜 짧은 잠꼬대나 이갈이의 앞부분이 잘리지 않습니다.

## 🏠 집에서 이어서 사용하는 방법

### 방법 1: GitHub Pages로 배포하여 아이폰에서 바로 접속 (가장 추천)
아이폰 Safari에서 마이크 권한 및 화면 꺼짐 방지(`Wake Lock`)를 사용하려면 보안 연결(`HTTPS`)이 필요합니다. GitHub Pages에 올리면 집에서 PC를 켜두지 않아도 아이폰만으로 언제든 접속할 수 있습니다.
1. GitHub에 새 레포지토리를 만들고 현재 폴더의 파일(`index.html`, `styles.css`, `app.js`, `manifest.json`, `README.md`)을 푸시(Push)합니다.
2. GitHub 레포지토리의 **Settings -> Pages** 메뉴에서 Branch를 `main`(또는 `master`)으로 선택하고 **Save**를 누릅니다.
3. 1~2분 뒤 생성되는 `https://<아이디>.github.io/<레포지토리명>/` 주소로 아이폰 Safari에서 접속합니다.
4. 아이폰 Safari 하단 **[공유 버튼] -> [홈 화면에 추가]**를 누르면 일반 앱처럼 바탕화면에 설치됩니다.

### 방법 2: 파일만 집으로 가져가서 실행하기
1. 현재 폴더(`radiant-oppenheimer`)의 파일 4개(`index.html`, `styles.css`, `app.js`, `manifest.json`)를 USB, 카카오톡 나에게 보내기, 구글 드라이브, 또는 GitHub를 통해 집 컴퓨터로 옮깁니다.
2. 로컬 PC에서 테스트할 때는 VS Code의 `Live Server` 확장 프로그램이나 터미널에서 `python -m http.server 8000` 명령어를 실행해 `http://localhost:8000`으로 접속하면 바로 작동합니다.
