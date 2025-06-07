## 🐶 프로젝트 개요

기존 혐오 표현 탐지 시스템은 대부분 **키워드 필터링**이나  **사전 학습된 분류 모델**에 의존해 왔습니다.  
이러한 방식은 다음과 같은 구조적 한계를 갖고 있습니다:

- 문장의 **문맥(Context)** 을 충분히 이해하지 못하고  
- **신조어, 은어, 패러디 표현** 등 빠르게 변화하는 인터넷 언어에 유연하게 대응하지 못함

우리는 이러한 문제를 해결하기 위해, 기존의 고정된 분류 구조를 보완할 수 있는  
**유연한 아키텍처**를 설계하였습니다.  
이를 통해 **신조어 기반 표현까지 탐지 가능하고**,  
**문맥에 맞는 근거를 생성할 수 있는 혐오 표현 탐지 시스템**을 구현했습니다.

---

## 🧩 시스템 아키텍처 (KoELECTRA + GPT + FAISS RAG)

본 프로젝트는 다음 네 가지 컴포넌트를 기반으로 작동합니다:

### 1. KoELECTRA 멀티레이블 분류기
- 댓글 문장을 입력하면, KoELECTRA 기반 분류기가 문장의  
  **혐오 여부 및 8개 범주(인종, 성별, 정치 등)**에 대한 확률을 예측합니다.
- 이 결과는 **1차적인 분류 정보**로 활용됩니다.

### 2. FAISS 벡터스토어 기반 유사 표현 검색
- KoELECTRA가 직접 이해하지 못하는 **신조어/축약어/패러디 표현**에 대응하기 위해,  
  자체 구축한 혐오 표현 정의 사전(`mz_hate_speech.csv`)을 임베딩하여 **FAISS에 저장**합니다.
- 댓글 내 핵심 표현을 벡터로 매핑하여, **유사한 표현의 정의나 맥락을 검색**합니다.

### 3. LangChain + OpenAI GPT 기반 RAG 구조
- KoELECTRA의 판단 + FAISS 검색 결과를 **LangChain 프롬프트 템플릿에 주입**하고,  
  **OpenAI GPT**를 통해 **최종 혐오 여부 + 자연어 기반 설명(근거)** 을 생성합니다.
- 이 구조는 **Retrieval-Augmented Generation(RAG)** 으로  
  기존 표현 외의 맥락까지 반영할 수 있도록 설계되었습니다.

### 4. Chrome 확장 실시간 연동
- 분석 결과는 **크롬 확장**을 통해 **실시간 시각화**됩니다.  
- 사용자는 단어에 대해 **신고할 수 있으며**,  
  **10회 이상 신고된 표현은 자동으로 벡터스토어에 갱신**됩니다.

---

## 🚀 Colab에서 바로 실행

📎 [Colab에서 실행](https://colab.research.google.com/github/hatedogs/hatedog/blob/main/run.ipynb)

> 이 노트북은 다음을 자동으로 수행합니다:
> - GitHub 레포지토리 클론
> - 의존 라이브러리 설치
> - Flask 서버 실행
> - ngrok 주소 자동 발급

실행 전 다음 환경변수를 수동으로 입력해야 합니다:
- `HF_TOKEN`
- `NGROK_AUTH_TOKEN`
- `OPENAI_API_KEY`

---

## 📦 크롬 확장 다운로드 

- [Chrome Extension ZIP 다운로드](https://github.com/hatedogs/hatedog/releases/tag/chrome-extension/chrome-extension.zip)


## 🧠 주요 기능 요약

| 기능 | 설명 |
|------|------|
| ✅ 멀티레이블 KoELECTRA 혐오 탐지 | 인종, 젠더, 정치 등 8개 범주 |
| ✅ GPT 기반 근거 생성 및 이진 판단 | LangChain 기반 프롬프트 |
| ✅ FAISS 벡터스토어 + RAG 구조 | 신조어/인터넷 은어 대응 |
| ✅ Chrome 확장 제공 | 실시간 댓글 분석, 신고 가능 |
| ✅ **신고 누적 자동 정의 생성** | 신고 10회 시 LLM + RAG 업데이트 |

---

## 📂 폴더 구조 (핵심)

```bash
llm_server/
├── data/
│   └── mz_hate_speech.csv     # CSV 기반 혐오/신조어 사전
├── app.py                     # Flask 진입점
├── config.py                  # 설정값 (CSV 경로, 벡터 저장 위치 등)
├── db.py                      # 신고 수 카운터 + 기록 DB
├── llm_analyzer.py            # GPT 모델 래퍼 + VectorDB
├── vectorDB_update.py         # 전체 신고/정의/CSV/벡터 처리 로직
```

---

## 📌 자동 정의 생성 + 벡터 DB 업데이트

### 🚨 신고 누적 → 자동 처리 파이프라인

크롬 확장에서 사용자가 단어를 신고하면 Flask 서버는 이를 저장하고,  
**신고 수가 10회 누적되면 아래 로직이 자동 실행됩니다:**

1. `db.py`  
   - `get_reason_list_for_word()`로 신고 사유 수집

2. `llm_analyzer.py`  
   - 사유 기반 프롬프트를 GPT로 호출하여 CSV 한 줄 생성

3. `vectorDB_update.py`  
   - `generate_csv_entry_from_report()`로 CSV 항목 구성  
   - `append_to_csv()`로 `mz_hate_speech.csv`에 추가  
   - `update_faiss_vectorstore()`로 FAISS 벡터스토어 동기화  
   - `erase_db()`로 신고 DB 초기화

➡️ **신조어도 신고 10회만 되면 자동 학습됩니다.**

---

## 🧠 `mz_hate_speech.csv` 구조

```csv
범주,예시표현,간략 정의/맥락,label
인종,화짱조,"화교+짱깨+조선족 등 중국계 혐오 표현",혐오 발언
```

- 이 파일은 FAISS 벡터스토어의 소스로 사용되며,
- 새 항목이 추가되면 vectorstore도 함께 동기화됩니다.

---

## 🌐 크롬 확장 (📁 `chrome-extension/`)

### 기능 요약

- 유튜브 댓글 로딩 감지 → `/analyze` 서버 요청
- 결과에 따라 댓글을 "검열됨"/정상으로 표시
- 각 댓글 옆에 `느낌표 버튼`이 나타나면 신고 가능
- `/report_word`로 신고 서버 전송

### 서버 주소 설정

`chrome-extension/content_script.js` 내:

```js
const SERVER_URL = "https://your-ngrok-url.ngrok-free.app";
```

> Colab 사용 시 ngrok 주소는 매번 달라지므로 수시로 갱신 필요

### 설치 방법

1. Chrome → `chrome://extensions` 진입
2. "개발자 모드" ON
3. "압축 해제된 확장 프로그램 로드" 클릭
4. `chrome-extension/` 폴더 선택

---

## 📎 예시 동작 흐름

1. `탑이 유미 없네..`라는 댓글에 사용자가 느낌표 버튼 클릭  
2. 서버는 `유미` 단어에 대해 신고 누적 수 증가  
3. 누적 10회 도달 → GPT 호출 → `"게임","유미","애미와 같은 표현",혐오 발언` 생성  
4. `mz_hate_speech.csv`에 추가  
5. FAISS 벡터스토어 자동 갱신  
6. 다음부터는 같은 표현이 나올 때 **즉시 탐지 가능**

---


## 📊 사용한 데이터

- **Unsmile**: [https://github.com/smilegate-ai/korean_unsmile_dataset]
- **KMHAS (Korean Multi-label Hate Annotation Set)**: [https://huggingface.co/datasets/jeanlee/K-MHaS]

---

## 📄 논문 

본 프로젝트에 대한 자세한 내용은 아래 논문에서 확인할 수 있습니다:  
👉 [KCC 2025 제출 논문 PDF 다운로드](https://github.com/hatedogs/hatedog/releases/download/paper/KCC_2025_paper.pdf)
