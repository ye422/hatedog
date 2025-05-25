import os
import llm_analyzer # 여러분의 llm_analyzer.py
import config       # 여러분의 config.py
from langchain_community.vectorstores import FAISS
from langchain_community.embeddings import HuggingFaceEmbeddings

# LLM 컴포넌트 초기화 또는 로드 (필수)
if not llm_analyzer.vectorstore or not llm_analyzer.embeddings_model:
    print("LLM 컴포넌트 초기화 시도...")
    if not llm_analyzer.embeddings_model:
        llm_analyzer.embeddings_model = HuggingFaceEmbeddings(
            model_name=config.EMBEDDING_MODEL_NAME,
            model_kwargs={'device': config.DEVICE},
            encode_kwargs={'normalize_embeddings': True}
        )
    
    if os.path.exists(config.FAISS_SAVE_PATH) and os.listdir(config.FAISS_SAVE_PATH):
        print(f"FAISS 인덱스 로드 중: {config.FAISS_SAVE_PATH}")
        try:
            # llm_analyzer.vectorstore를 직접 업데이트하거나, 새로운 변수에 할당하여 확인
            current_vectorstore = FAISS.load_local(
                config.FAISS_SAVE_PATH, 
                llm_analyzer.embeddings_model, 
                allow_dangerous_deserialization=True
            )
        except Exception as e:
            print(f"FAISS 인덱스 로드 중 오류: {e}")
            current_vectorstore = None # 로드 실패 시 None으로 설정
    else:
        print("저장된 FAISS 인덱스를 찾을 수 없습니다.")
        current_vectorstore = None
else:
    current_vectorstore = llm_analyzer.vectorstore # 이미 로드된 객체 사용

if current_vectorstore:
    print(f"\n--- VectorDB (FAISS) 내용 확인 ---")
    
    # FAISS 인덱스에 저장된 총 벡터 수 (문서 수와 일치해야 함)
    if hasattr(current_vectorstore, 'index') and hasattr(current_vectorstore.index, 'ntotal'):
        total_docs_in_index = current_vectorstore.index.ntotal
        print(f"FAISS 인덱스 내 총 벡터(문서) 수: {total_docs_in_index}")

    # Docstore에서 문서 정보 가져오기
    # 주의: docstore._dict는 내부 구현이므로 변경될 수 있습니다.
    if hasattr(current_vectorstore, 'docstore') and hasattr(current_vectorstore.docstore, '_dict'):
        docstore_dict = current_vectorstore.docstore._dict
        print(f"Docstore 내 총 문서 수: {len(docstore_dict)}")
        
        # 모든 문서를 출력하면 너무 많을 수 있으므로, 처음 몇 개만 출력하거나 특정 ID로 조회
        count = 0
        max_docs_to_show = 5 # 보여줄 최대 문서 수
        
        for doc_id, document in docstore_dict.items():
            if count < max_docs_to_show:
                print(f"\n문서 ID: {doc_id}")
                print(f"  내용 (page_content): {document.page_content}")
                print(f"  메타데이터 (metadata): {document.metadata}")
            else:
                print(f"\n... (총 {len(docstore_dict)}개 문서 중 처음 {max_docs_to_show}개만 표시) ...")
                break
            count += 1
        
        if not docstore_dict:
            print("Docstore가 비어있습니다.")
            
    else:
        print("Docstore에 접근할 수 없거나 내부 구조가 예상과 다릅니다.")
        print("유사도 검색을 통해 특정 문서를 찾아보는 방식으로 확인해야 할 수 있습니다.")

else:
    print("VectorDB (FAISS)를 로드할 수 없었습니다.")