import logging
import csv
import os
from typing import List, Dict, Optional
from langchain_openai import ChatOpenAI
from langchain_core.documents import Document # VectorDB 업데이트를 위해 필요

# 필요한 모듈 및 설정값 import
import config
import llm_analyzer # LLM 모델(chat_openai_model)과 vectorstore, embeddings_model 접근
from db import get_reason_list_for_word, erase_db # DB 함수 접근

logger = logging.getLogger(__name__)


def generate_csv_entry_from_report(word: str, reasons: List[str]) -> Optional[Dict[str, str]]:
    """
    GPT-4.1 api를  사용하여 신고된 단어와 사유들을 기반으로 CSV에 추가할 새로운 항목을 생성합니다.
    """
    #GPT-4.1 모델 사용 (llm_analyzer와 독립)
    try:
        definition_gen_model = ChatOpenAI(model="gpt-4.1", temperature=0.3)
    except Exception as e:
        logger.error("모델 초기화 실패", exc_info=True)
        return None

    known_categories = ["정치", "게임", "젠더", "인종", "기타 (계층/직업)", "기타 (일반)"]
    reasons_str = "\n- ".join(reasons)

    prompt_str = f"""다음은 사용자들이 '{word}' 단어에 대해 신고한 내용과 그 사유들입니다.
이 정보를 바탕으로, 해당 단어가 어떤 범주의 혐오 표현인지, 그리고 어떤 맥락/의미로 사용되는지를 정리하여
CSV 형식의 데이터를 한 줄 생성해주세요.

[신고된 단어]: {word}

[신고 사유 목록]:
- {reasons_str}

[출력 형식 (정확히 이 형식으로만 응답)]:
범주,예시표현,간략 정의/맥락

[세부 지침]:
1. '예시표현'은 주어진 [신고된 단어]를 그대로 사용합니다.
2. '범주'는 다음 목록 중 가장 적절한 것을 선택해야 합니다: {", ".join(known_categories)}
   만약 적절한 항목이 없다면 '기타 (일반)'으로 지정하고, 정의/맥락에 그 이유를 포함해주세요.
3. '간략 정의/맥락'은 신고 사유들을 종합하여, 해당 단어가 왜 혐오 표현으로 간주되는지를
   명확하고 간결하게 한두 문장으로 설명합니다.

[생성된 CSV 데이터 (한 줄)]:
"""

    logger.info(f"새로운 혐오 표현 항목 생성을 요청합니다. 단어: {word}")
    logger.debug(f"프롬프트:\n{prompt_str}")

    try:
        response = definition_gen_model.invoke(prompt_str)
        generated_csv_line = response.content if hasattr(response, 'content') else str(response)
        generated_csv_line = generated_csv_line.strip()
        logger.info(f"응답 (단어: {word}): {generated_csv_line}")

        # --- 여기를 수정합니다 ---
        # maxsplit=2를 사용하여 처음 두 개의 콤마에서만 분리합니다.
        parts = generated_csv_line.split(',', 2)

        # 각 부분의 앞뒤 공백과 따옴표를 제거합니다.
        cleaned_parts = [p.strip().replace('"', '') for p in parts]

        if len(cleaned_parts) == 3:
            category, expression, definition = cleaned_parts
            if expression != word:
                logger.warning(f"예시표현이 원본 단어와 다름: '{expression}' → '{word}'로 변경")
                expression = word
            return {
                "범주": category,
                "예시표현": expression,
                "간략 정의/맥락": definition
            }
        else:
            # 에러 로그에 parts 내용을 포함하여 디버깅에 용이하게 만듭니다.
            logger.error(f"응답 파싱 실패. 예상 필드 수(3)와 다름({len(cleaned_parts)}). 응답: '{generated_csv_line}'")
            return None

    except Exception as e:
        logger.error(f"LLM 호출 또는 파싱 중 오류 (단어: {word})", exc_info=True)
        return None
    
def append_to_csv(new_entry: Dict[str, str], csv_filepath: str) -> bool:
    """
    주어진 항목을 CSV 파일에 추가합니다.
    'label'은 항상 '혐오 발언'으로 고정합니다.
    """
    try:
        file_exists_and_not_empty = os.path.exists(csv_filepath) and os.path.getsize(csv_filepath) > 0

        # label 필드 강제 추가
        complete_entry = new_entry.copy()
        complete_entry["label"] = "혐오 발언"

        with open(csv_filepath, 'a', newline='', encoding='utf-8') as csvfile:
            fieldnames = ["범주", "예시표현", "간략 정의/맥락", "label"]  # 헤더 순서 고정
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            if not file_exists_and_not_empty:
                writer.writeheader()
            writer.writerow(complete_entry)

        logger.info(f"새 항목이 '{csv_filepath}'에 추가되었습니다: {complete_entry}")
        return True
    except Exception as e:
        logger.error(f"CSV 파일 ('{csv_filepath}') 쓰기 중 오류: {e}", exc_info=True)
        return False

def update_faiss_vectorstore(new_entry: Dict[str, str]) -> bool:
    """
    새로운 CSV 항목으로 VectorDB(FAISS)를 업데이트합니다.
    (기존 llm_analyzer.update_vector_db_with_new_entry 로직과 거의 동일,
     vectorstore와 embeddings_model을 llm_analyzer 모듈에서 가져와 사용)
    """
    if not llm_analyzer.vectorstore or not llm_analyzer.embeddings_model: # llm_analyzer의 전역 객체 사용
        logger.error("Vectorstore 또는 Embeddings model이 초기화되지 않았습니다 (via llm_analyzer). DB 업데이트 불가.")
        return False

    try:
        page_content = new_entry.get(config.CONTENT_COLUMN_NAME, new_entry.get("예시표현"))
        metadata = {
            k: v for k, v in new_entry.items() 
            if k in config.METADATA_COLUMN_NAMES or k in ["범주", "간략 정의/맥락", "label"]
        }
        if config.CONTENT_COLUMN_NAME in metadata:
            del metadata[config.CONTENT_COLUMN_NAME]
        if "예시표현" in metadata and config.CONTENT_COLUMN_NAME != "예시표현":
             del metadata["예시표현"]

        new_doc = Document(page_content=page_content, metadata=metadata)
        
        logger.info(f"VectorDB에 새 문서 추가 시도: {new_doc}")
        llm_analyzer.vectorstore.add_documents([new_doc]) # llm_analyzer의 vectorstore 사용
        llm_analyzer.vectorstore.save_local(config.FAISS_SAVE_PATH) # llm_analyzer의 vectorstore 사용
        logger.info(f"VectorDB 업데이트 완료 및 '{config.FAISS_SAVE_PATH}'에 저장됨.")
        
        # 중요: llm_analyzer.vectorstore가 변경되었으므로, 만약 다른 곳에서 이 객체를 직접 참조한다면
        # save_local 이후에 llm_analyzer.vectorstore = FAISS.load_local(...) 등으로
        # llm_analyzer 모듈 내의 전역 변수 자체를 업데이트 해줘야 할 수 있습니다.
        # 현재는 add_documents가 in-memory 객체를 변경하고 save_local이 디스크에 반영하므로,
        # 다음 initialize_llm_components 호출 전까지는 현재 Flask 프로세스 내에서는 반영된 상태입니다.

        return True
    except Exception as e:
        logger.error(f"VectorDB 업데이트 중 오류 발생: {e}", exc_info=True)
        return False

def process_triggered_report(word: str):
    """
    신고 횟수가 충족된 단어에 대한 전체 처리 로직을 담당합니다.
    """
    logger.info(f"단어 '{word}'에 대한 자동 처리 시작.")
    
    reasons_list = get_reason_list_for_word(word)
    if not reasons_list:
        logger.error(f"단어 '{word}'의 신고 사유를 가져오는 데 실패했습니다.")
        return False # 처리 실패

    # 1. LLM을 통해 새로운 CSV 항목 생성
    new_entry_dict = generate_csv_entry_from_report(word, reasons_list)
    if not new_entry_dict:
        logger.error(f"LLM으로부터 새 항목 생성 실패 (단어: {word}). 처리 중단.")
        return False # 처리 실패

    logger.info(f"LLM으로부터 생성된 새 항목 (단어: {word}): {new_entry_dict}")
    
    # 2. mz_hate_speech.csv 파일에 추가
    if not append_to_csv(new_entry_dict, config.CSV_FILE_PATH):
        logger.error(f"CSV 파일 업데이트 실패 (단어: {word}). 처리 중단.")
        return False # 처리 실패
    
    # 3. VectorDB 업데이트
    if not update_faiss_vectorstore(new_entry_dict):
        logger.error(f"VectorDB 업데이트 실패 (단어: {word}). CSV는 추가되었으나 DB는 이전 상태일 수 있음. 처리 중단.")
        # 심각한 오류: 데이터 불일치 가능성. 롤백 또는 관리자 알림 필요.
        return False # 처리 실패
        
    # 4. DB에서 해당 단어의 신고 기록 삭제
    try:
        erase_db(word)
        logger.info(f"단어 '{word}'에 대한 신고 기록이 DB에서 삭제되었습니다.")
    except Exception as e:
        logger.error(f"DB에서 신고 기록 삭제 중 오류 발생 (단어: {word}): {e}", exc_info=True)
        # 이미 CSV와 VectorDB는 업데이트 되었으므로, 이 실패는 로깅만 하고 성공으로 간주할 수도 있음.
        # 또는, 전체 롤백 로직을 고려. 여기서는 일단 로깅만.
        return False # 처리 실패 (DB 정리가 안되었으므로)

    logger.info(f"단어 '{word}'에 대한 자동 처리 성공적으로 완료.")
    return True # 모든 처리 성공