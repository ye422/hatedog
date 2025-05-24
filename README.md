# 🐶 HATEDOG: KoELECTRA 기반 혐오 표현 탐지기

한국어 댓글을 입력하면 **KoELECTRA + OpenAI GPT + LangChain + RAG**을 이용해  
혐오 여부와 그 판단 근거를 함께 반환하는 API 서버입니다.  
함께 제공되는 크롬 확장을 통해 유튜브 댓글을 실시간 수집하고 서버에 자동 분석 요청할 수 있습니다.

---

## 🚀 Colab에서 바로 실행하기

📎 [Colab에서 실행](https://colab.research.google.com/github/ye422/hatedog/blob/main/run.ipynb)

> ✅ **이 프로젝트는 Colab 환경에서 테스트되고 개발되었습니다.**  
> 로컬 환경 설정 없이 바로 실행해보기에 가장 간단한 방법입니다.

> 이 노트북은 다음을 자동으로 수행합니다:
> - GitHub 레포지토리 클론
> - 필요한 라이브러리 설치
> - ngrok 공개 주소 생성
> - Flask 서버 실행

실행 전 아래와 같은 **환경변수 3개를 수동으로 입력**해야 합니다:

```python
import os
os.environ["HF_TOKEN"] = "hf_..."         # Hugging Face 토큰
os.environ["NGROK_AUTH_TOKEN"] = "2B..."  # ngrok 토큰
os.environ["OPENAI_API_KEY"] = "sk-..."   # OpenAI API 키
```

### 🧠 서버 기능 요약

✅ KoELECTRA 기반 멀티레이블 혐오 탐지 (8개 범주)

✅ LangChain + OpenAI GPT를 통한 최종 이진 분류 및 근거 생성

✅ FAISS 벡터스토어 기반 RAG 구조로 신조어 대응

✅ 크롬 확장과 통합

✅ Flask API로 /analyze, /report_word 제공

### 📂 폴더 구조

```bash
hatedog/
├── chrome-extension/       # 크롬 확장 코드
├── llm_server/             # Flask 서버 및 분석 로직
│   ├── app.py
│   ├── config.py
│   ├── llm_analyzer.py
│   ├── db.py
│   ├── data/
│   │   └── mz_hate_speech.csv  # ✅ 기본 예시 포함 (수정 가능)
│   └── ...
└── run.ipynb               # Colab 실행 진입점
```

### 🔍 mz_hate_speech.csv: 신조어 기반 RAG 확장

`llm_server/data/mz_hate_speech.csv`에는
MZ세대 혐오 표현/정상 표현 예시가 담겨 있으며,
초기 실행 시 자동으로 벡터스토어에 임베딩되어 RAG 기반 프롬프트에 활용됩니다.

### CSV 포맷 예시:
```csv
범주,예시표현,간략 정의/맥락,label
인종,화짱조,"화교, 짱깨, 조선족의 줄임말로, 중국계 사람에 대한 인종차별 표현",혐오 발언
```

✅ 이 파일은 기본으로 포함되어 있으며,

📝 사용자가 직접 내용 추가/수정 후 재시작하면 탐지기의 인식 범위를 확장할 수 있습니다.

---

## 🌐 Chrome 확장 (📁 `chrome-extension/`)

이 프로젝트에는 YouTube 댓글을 실시간으로 감지하여  
**KoELECTRA + GPT 기반 서버에 전송하고 결과를 UI에 반영하는 크롬 확장**이 포함됩니다.

### ⚙️ 주요 구성 요소

| 파일 | 역할 |
|------|------|
| `content_script.js` | 댓글을 감지하고 서버에 전송하며, UI를 '검열됨/정상'으로 표시 |
| `background.js`     | YouTube `watch` 페이지를 감지하고 `content_script.js`를 자동으로 삽입 |
| `manifest.json`     | 확장 프로그램 정의 (V3, 서비스 워커 기반) |
| `icon.png`          | 확장 아이콘 |


### 🔍 작동 방식

1. **YouTube `watch` 페이지에 접근하면 자동으로 감지**
2. **댓글이 새로 로딩되면 자동으로 서버에 전송**
3. **혐오 표현이면 "검열됨", 아니면 원문 유지**
4. 각 댓글 옆 메뉴에 **느낌표 버튼**이 추가됨 → 직접 단어를 신고 가능

### 🔐 서버와의 통신

- 분석 요청: `POST /analyze`
- 단어 신고: `POST /report_word`

서버 주소(`SERVER_URL`)는 `content_script.js` 내 상단에서 수동 설정해야 합니다:

```javascript
const SERVER_URL = "https://your-ngrok-url.ngrok-free.app"; // 반드시 실제 ngrok 주소로 변경
⚠️ Colab에서 ngrok로 서버 실행 시, 매번 새 주소가 생성되므로 SERVER_URL은 수시로 갱신 필요
```

### 🧪 설치 방법 (Chrome 확장)

1. Chrome 브라우저에서 `chrome://extensions` 접속
2. 우측 상단 "개발자 모드" 활성화
3. "압축해제된 확장 프로그램 로드" 클릭
4. `chrome-extension/` 폴더 선택
5. YouTube 영상 페이지로 이동 → 댓글 분석이 자동으로 동작하는지 확인

### 📎 예시 동작 화면
댓글이 "검열됨"으로 바뀌거나

UI 오른쪽 메뉴에 노란색 느낌표 아이콘(신고 버튼)이 추가됨

