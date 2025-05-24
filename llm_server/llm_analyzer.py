import os
import logging
import re
import torch
import torch.nn as nn
from typing import List, Dict, Any, Tuple, Optional
from operator import itemgetter
from huggingface_hub import hf_hub_download
from langchain_community.document_loaders import CSVLoader
from langchain_community.embeddings import HuggingFaceEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_core.prompts import PromptTemplate
from langchain_core.runnables import RunnablePassthrough, RunnableLambda
from langchain_core.output_parsers import StrOutputParser
from langchain_core.documents import Document
from langchain_openai import ChatOpenAI

from transformers import ElectraModel, ElectraTokenizer
from concurrent.futures import ThreadPoolExecutor # For potentially parallelizing KoELECTRA

import config

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)
logging.getLogger("transformers").setLevel(logging.WARNING)
logging.getLogger("tokenizers").setLevel(logging.WARNING)
logging.getLogger("httpx").setLevel(logging.WARNING)

# --- Global Variables for Models and Components ---
koelectra_model: Optional[nn.Module] = None
koelectra_tokenizer: Optional[ElectraTokenizer] = None
embeddings_model: Optional[HuggingFaceEmbeddings] = None
vectorstore: Optional[FAISS] = None
chat_openai_model: Optional[ChatOpenAI] = None
rag_chain: Optional[Any] = None

# --- KoELECTRA Model Definition ---
class KOELECTRAMultiLabel(nn.Module):
    def __init__(self, model_name=config.KOELECTRA_BASE_MODEL_NAME, num_labels=8):
        super().__init__()
        self.encoder = ElectraModel.from_pretrained(model_name)
        self.classifier = nn.Linear(self.encoder.config.hidden_size, num_labels)

    def forward(self, input_ids, attention_mask):
        outputs = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        cls_output = outputs.last_hidden_state[:, 0, :]
        return self.classifier(cls_output)

def load_koelectra_components():
    global koelectra_model, koelectra_tokenizer
    try:
        logger.info(f"Loading KoELECTRA tokenizer: {config.KOELECTRA_BASE_MODEL_NAME}...")
        koelectra_tokenizer = ElectraTokenizer.from_pretrained(config.KOELECTRA_BASE_MODEL_NAME)

        logger.info(f"Downloading fine-tuned KoELECTRA model from Hugging Face: {config.KOELECTRA_FINETUNED_REPO_ID}/{config.KOELECTRA_FINETUNED_FILENAME}...")
        model_path = hf_hub_download(repo_id=config.KOELECTRA_FINETUNED_REPO_ID, filename=config.KOELECTRA_FINETUNED_FILENAME)

        logger.info(f"Initializing KoELECTRA model...")
        koelectra_model = KOELECTRAMultiLabel(model_name=config.KOELECTRA_BASE_MODEL_NAME, num_labels=8).to(config.DEVICE)
        koelectra_model.load_state_dict(torch.load(model_path, map_location=config.DEVICE))
        koelectra_model.eval()

        logger.info("KoELECTRA components loaded successfully.")
        return True
    except Exception as e:
        logger.error(f"Error loading KoELECTRA components: {e}", exc_info=True)
        return False

def get_koelectra_context(text: str) -> Tuple[str, List[int]]:
    if koelectra_model is None or koelectra_tokenizer is None:
        logger.warning("KoELECTRA model or tokenizer not loaded. Returning failure message.")
        return "[KoELECTRA 모델 로드 실패]", []

    label_names = ["출신차별", "외모차별", "정치성향차별", "욕설", "연령차별", "성차별", "인종차별", "종교차별"]
    threshold = 0.4 

    inputs = koelectra_tokenizer(text, return_tensors="pt", truncation=True, padding="max_length", max_length=512)
    input_ids = inputs["input_ids"].to(config.DEVICE)
    attention_mask = inputs["attention_mask"].to(config.DEVICE)

    with torch.no_grad():
        logits = koelectra_model(input_ids, attention_mask)
        probs = torch.sigmoid(logits).cpu().numpy()[0]
        preds = (probs >= threshold).astype(int)

    lines = [f'입력 문장: "{text}"', "카테고리별 확률:"]
    for label, prob in zip(label_names, probs):
        lines.append(f" - {label:<10}: {prob:.3f}")

    active = [label for label, p_val in zip(label_names, preds) if p_val]
    if not active:
        lines.append("판단 유보: 어떤 혐오 카테고리도 threshold(0.4)를 넘지 않음.")
    else:
        lines.append(f"혐오 탐지됨! 속성: {', '.join(active)}")
    
    context_str = "\n".join(lines)
    return context_str, preds.tolist()

# --- Prompt Templates ---
COMMON_PREFIX = """당신은 입력된 한국어 문장이 '혐오' 표현인지 '정상'적인 내용인지 분류하는 전문가입니다.
주어진 문장에 대해, **먼저 '혐오' 또는 '정상' 중 하나로 반드시 분류**하고, 그 다음 **그 판단 근거를 한 문장으로 명확하게 설명**해야 합니다.

[분류 기준]
* 혐오: 특정 집단(성별, 인종, 출신 지역, 종교, 정치 성향, 성적 지향 등)이나 개인에 대한 비하, 차별, 편견, 공격, 모욕, 위협, 조롱 등을 직접적 또는 간접적으로 포함하는 문장.
* 정상: 일상적인 대화, 개인적인 감상, 의견 제시, 질문, 객관적인 정보 전달 등 위의 '혐오' 기준에 해당하지 않는 모든 문장.
* 매우 중요: 문장에 '대깨윤', '쭝꿔' 등 명백한 혐오 단어가 포함되어 있더라도, 문맥상 **해당 혐오 표현의 사용 자체를 비판하거나, 사용하지 말자는 내용이면 '정상'으로 분류**합니다.

[분류 예시 (항상 참고)]
입력: 오늘 점심 뭐 먹지? 너무 배고프다.
[최종 분류]: 정상
[판단 근거]: 점심 메뉴에 대한 고민과 배고픔을 표현하는 일상적인 문장입니다.

입력: 뉴스에서 '틀딱충'이라는 혐오 표현을 사용한 것에 대해 비판하는 기사를 봤어.
[최종 분류]: 정상
[판단 근거]: 혐오 표현이 언급되었으나 문맥상 사용을 비판하는 내용을 전달하고 있으므로 정상입니다.
"""
DYNAMIC_EXAMPLES_PREFIX = "[참고: 입력과 유사한 혐오 분류 예시 (있을 경우 - 다음 형식으로 제공됨)]"
EXAMPLE_SEPARATOR = "\n---\n"
SUFFIX_TEMPLATE_COMMON = """
=== 최종 판단 ===
[입력 문장]
"{user_comment}"
"""
OUTPUT_FORMAT_GUIDANCE_CLASSIFICATION_FIRST = """
(위 정보들을 종합적으로 고려하여, **내부적으로는 단계별 분석을 수행**하되, 출력은 다음 형식으로 **정확히** 작성해 주십시오.)
[최종 분류]: ['혐오' 또는 '정상' 중 하나]
[판단 근거]: [판단 이유를 한 문장으로 작성]
"""
SUFFIX_WITH_KOELECTRA = SUFFIX_TEMPLATE_COMMON + """
[KOELECTRA 분석 결과 (참고용)]
{koelectra_context}
""" + OUTPUT_FORMAT_GUIDANCE_CLASSIFICATION_FIRST
SUFFIX_NO_KOELECTRA = SUFFIX_TEMPLATE_COMMON + OUTPUT_FORMAT_GUIDANCE_CLASSIFICATION_FIRST
FEW_SHOT_EXAMPLE_PROMPT_CLASSIFICATION_FIRST = PromptTemplate(
    input_variables=["user_comment", "간략_정의_맥락", "범주", "label"],
    template="입력: {user_comment}\n[최종 분류]: {label}\n[판단 근거]: {간략_정의_맥락} (참고 범주: {범주})\n"
)

def safe_example_formatter(doc: Document) -> str:
    metadata = doc.metadata
    context_keys = ['간략 정의/맥락', '간략정의/맥락']
    reason_text = next((metadata[key] for key in context_keys if key in metadata), 'N/A')
    category = metadata.get('범주', 'N/A')
    label = metadata.get('label', 'N/A')
    user_comment = doc.page_content.replace("예시표현:", "").strip()
    try:
        return FEW_SHOT_EXAMPLE_PROMPT_CLASSIFICATION_FIRST.format(
            user_comment=user_comment,
            간략_정의_맥락=reason_text,
            범주=category,
            label=label
        )
    except KeyError as e:
        logger.warning(f"KeyError during example formatting: {e}. Metadata: {metadata}")
        return f"입력: {user_comment}\n[최종 분류]: 포맷팅오류\n[판단 근거]: 포맷팅오류"
    
def select_and_format_examples(data_input: Dict, db: FAISS, threshold: float, k: int) -> str:
    user_comment = data_input[config.RAG_CHAIN_INPUT_KEY]
    if not db:
        return "[VectorStore 로드 실패]"
    try:
        results_with_scores: List[Tuple[Document, float]] = db.similarity_search_with_score(user_comment, k=k)
        filtered_docs = [doc for doc, score in results_with_scores if score >= threshold]
        if not filtered_docs:
            return "" 
        formatted_examples = [safe_example_formatter(doc) for doc in filtered_docs]
        return EXAMPLE_SEPARATOR.join(formatted_examples)
    except Exception as e:
        logger.error(f"Error during example selection/formatting: {e}", exc_info=True)
        return "[예시 검색/처리 오류]"

def assemble_final_prompt(input_dict: Dict) -> str:
    user_comment = input_dict[config.RAG_CHAIN_INPUT_KEY]
    selected_examples_str = input_dict.get("selected_examples_str", "")
    include_koelectra = input_dict.get(config.INCLUDE_KOELECTRA_KEY, False)
    koelectra_context_val = input_dict.get(config.KOELECTRA_CONTEXT_KEY, "[KOELECTRA 정보 없음]")
    prompt_parts = [COMMON_PREFIX]
    if selected_examples_str and not selected_examples_str.startswith("["): 
        prompt_parts.append(DYNAMIC_EXAMPLES_PREFIX)
        prompt_parts.append("---")
        prompt_parts.append(selected_examples_str)
        prompt_parts.append("---")
    if include_koelectra:
        final_suffix = SUFFIX_WITH_KOELECTRA.format(
            user_comment=user_comment,
            koelectra_context=koelectra_context_val
        )
    else:
        final_suffix = SUFFIX_NO_KOELECTRA.format(user_comment=user_comment)
    prompt_parts.append(final_suffix)
    final_prompt_str = "\n\n".join(prompt_parts)
    return final_prompt_str

def initialize_llm_components():
    global embeddings_model, vectorstore, chat_openai_model, rag_chain
    logger.info("LLM Analyzer: Initializing components...")
    if not load_koelectra_components():
        logger.error("Failed to load KoELECTRA, halting LLM initialization.")
        return False
    try:
        logger.info(f"Loading embedding model: {config.EMBEDDING_MODEL_NAME}")
        embeddings_model = HuggingFaceEmbeddings(
            model_name=config.EMBEDDING_MODEL_NAME,
            model_kwargs={'device': config.DEVICE},
            encode_kwargs={'normalize_embeddings': True} 
        )
        logger.info(f"Loading documents from: {config.CSV_FILE_PATH}")
        if not os.path.exists(config.CSV_FILE_PATH):
            logger.error(f"CSV file not found at: {config.CSV_FILE_PATH}")
            return False
        loader = CSVLoader(
            file_path=config.CSV_FILE_PATH,
            encoding='utf-8',
            csv_args={'delimiter': ','},
            source_column=config.CONTENT_COLUMN_NAME,
            metadata_columns=config.METADATA_COLUMN_NAMES
        )
        all_documents = loader.load()
        for doc in all_documents:
            doc.metadata = {k.strip(): v for k, v in doc.metadata.items()}
        if not all_documents:
            logger.error("No documents loaded from CSV. Halting initialization.")
            return False
        logger.info(f"Loaded {len(all_documents)} documents.")
        if os.path.exists(config.FAISS_SAVE_PATH) and os.listdir(config.FAISS_SAVE_PATH):
            logger.info(f"Loading FAISS index from '{config.FAISS_SAVE_PATH}'.")
            vectorstore = FAISS.load_local(config.FAISS_SAVE_PATH, embeddings_model, allow_dangerous_deserialization=True)
        else:
            logger.info(f"Creating new FAISS index at '{config.FAISS_SAVE_PATH}'.")
            vectorstore = FAISS.from_documents(all_documents, embeddings_model)
            vectorstore.save_local(config.FAISS_SAVE_PATH)
        if not vectorstore:
             logger.error("FAISS index creation/loading failed.")
             return False
        logger.info(f"Initializing OpenAI LLM: {config.OPENAI_MODEL_NAME}")
        if not config.OPENAI_API_KEY:
            logger.error("OPENAI_API_KEY not found in environment variables or .env file.")
            return False
        chat_openai_model = ChatOpenAI(
            model_name=config.OPENAI_MODEL_NAME,
            openai_api_key=config.OPENAI_API_KEY,
            temperature=config.TEMPERATURE,
            max_tokens=config.MAX_NEW_TOKENS,
            model_kwargs={"top_p": config.TOP_P}
        )
        if not chat_openai_model:
            logger.error("ChatOpenAI model creation failed.")
            return False
        rag_chain = (
            {
                config.RAG_CHAIN_INPUT_KEY: itemgetter(config.RAG_CHAIN_INPUT_KEY),
                config.KOELECTRA_CONTEXT_KEY: itemgetter(config.KOELECTRA_CONTEXT_KEY),
                config.INCLUDE_KOELECTRA_KEY: itemgetter(config.INCLUDE_KOELECTRA_KEY),
                "selected_examples_str": RunnableLambda(
                    lambda x: select_and_format_examples(
                        x,
                        vectorstore, 
                        config.SIMILARITY_THRESHOLD, 
                        config.FEW_SHOT_K
                    )
                )
            }
            | RunnableLambda(assemble_final_prompt)
            | chat_openai_model
            | StrOutputParser()
        )
        logger.info("LLM Analyzer: All components initialized successfully.")
        return True
    except Exception as e:
        logger.error(f"LLM Analyzer: Error during initialization: {e}", exc_info=True)
        return False

def parse_llm_output(llm_text: str) -> Tuple[str, str]:
    classification = "불명확"
    reason = "파싱 실패"
    
    # Updated regex to match the new output format
    # [최종 분류]: <classification>
    # [판단 근거]: <reason>
    
    # Try to find classification
    cls_match = re.search(r"\[최종 분류\]:\s*(혐오|정상)", llm_text, re.IGNORECASE)
    if cls_match:
        classification = cls_match.group(1).strip()
    else: # Fallback if specific markers are missed
        if "혐오" in llm_text and "정상" not in llm_text: classification = "혐오"
        elif "정상" in llm_text and "혐오" not in llm_text: classification = "정상"

    # Try to find reason
    rsn_match = re.search(r"\[판단 근거\]:\s*(.*)", llm_text, re.IGNORECASE)
    if rsn_match:
        reason = rsn_match.group(1).strip()
        reason = re.sub(r'assistant\s*', '', reason, flags=re.IGNORECASE).strip()
        if '\n' in reason: # Take first line if multi-line
            reason = reason.split('\n')[0].strip()
    elif classification != "불명확": # If classification was found but specific reason marker missed
        reason = "이유 명시 없음 (판단 근거 누락)"
        
    return classification, reason

def analyze_comment(comment_text: str) -> Dict[str, Any]:
    if not all([rag_chain, koelectra_model, chat_openai_model, vectorstore, embeddings_model]):
        logger.error("LLM Analyzer: One or more components not initialized. Cannot analyze.")
        missing_components = [name for name, comp in [
            ("RAG chain", rag_chain), ("KoELECTRA model", koelectra_model),
            ("ChatOpenAI model", chat_openai_model), ("Vectorstore", vectorstore),
            ("Embeddings model", embeddings_model)
        ] if not comp]
        return {
            "classification": "오류", 
            "reason": f"분석기 초기화 실패. 누락된 구성 요소: {', '.join(missing_components)}",
            "raw_llm_output": "",
            "koelectra_output": ""
        }

    koelectra_context_str = "[KoELECTRA 분석 정보 없음]"
    try:
        koelectra_context_str, _ = get_koelectra_context(comment_text)
        include_koelectra = "[KoELECTRA 모델 로드 실패]" not in koelectra_context_str and \
                            "판단 유보:" not in koelectra_context_str and \
                            koelectra_context_str.strip() != ""
        input_data = {
            config.RAG_CHAIN_INPUT_KEY: comment_text,
            config.KOELECTRA_CONTEXT_KEY: koelectra_context_str,
            config.INCLUDE_KOELECTRA_KEY: include_koelectra
        }
        logger.debug(f"Invoking RAG chain with input: user_comment='{comment_text[:30]}...', include_koelectra={include_koelectra}")
        raw_llm_output = rag_chain.invoke(input_data)
        logger.debug(f"Raw LLM output for '{comment_text[:50]}...':\n{raw_llm_output}")
        classification, reason = parse_llm_output(raw_llm_output)
        logger.info(f"Analyzed '{comment_text[:50]}...': Class='{classification}', Reason='{reason[:50]}...'")
        return {
            "classification": classification,
            "reason": reason,
            "raw_llm_output": raw_llm_output,
            "koelectra_output": koelectra_context_str
        }
    except Exception as e:
        logger.error(f"LLM Analyzer: Error during RAG chain execution for '{comment_text[:50]}...': {e}", exc_info=True)
        return {
            "classification": "오류",
            "reason": f"분석 중 오류 발생: {str(e)}",
            "raw_llm_output": "",
            "koelectra_output": koelectra_context_str
        }

def analyze_comments_batch(comments: List[str], max_concurrency: int = 5) -> List[Dict[str, Any]]:
    """
    Analyzes a batch of comments, parallelizing LLM calls.
    max_concurrency: Max concurrent requests to OpenAI. Adjust based on your rate limits.
    """
    if not all([rag_chain, koelectra_model, chat_openai_model, vectorstore, embeddings_model]):
        logger.error("LLM Analyzer: One or more components not initialized. Cannot analyze batch.")
        error_reason = "분석기 초기화 실패. 필수 구성 요소 누락."
        return [{
            "classification": "오류", "reason": error_reason,
            "raw_llm_output": "", "koelectra_output": ""
        }] * len(comments)

    logger.info(f"Starting batch analysis for {len(comments)} comments with max_concurrency={max_concurrency}.")

    # 1. Get KoELECTRA context for all comments (sequentially for now, can be parallelized if slow)
    # If KoELECTRA becomes a bottleneck for large batches, this part can be parallelized
    # using ThreadPoolExecutor similar to how rag_chain.batch works internally for LLM calls.
    koelectra_outputs_map: Dict[str, str] = {}
    rag_input_list: List[Dict[str, Any]] = []

    for i, comment_text in enumerate(comments):
        # It's good practice to provide some feedback for long-running batch jobs
        if (i + 1) % 10 == 0 or (i + 1) == len(comments) :
             logger.info(f"Processing KoELECTRA for comment {i+1}/{len(comments)}...")
        koelectra_context_str, _ = get_koelectra_context(comment_text)
        koelectra_outputs_map[comment_text] = koelectra_context_str
        
        include_koelectra = "[KoELECTRA 모델 로드 실패]" not in koelectra_context_str and \
                            "판단 유보:" not in koelectra_context_str and \
                            koelectra_context_str.strip() != ""
        
        rag_input_list.append({
            config.RAG_CHAIN_INPUT_KEY: comment_text,
            config.KOELECTRA_CONTEXT_KEY: koelectra_context_str,
            config.INCLUDE_KOELECTRA_KEY: include_koelectra
        })
    
    logger.info("KoELECTRA processing complete. Invoking RAG chain in batch...")

    # 2. Invoke RAG chain in batch
    # ChatOpenAI (and many other LLM providers in LangChain) will handle parallel API calls
    # when .batch() is used. The `max_concurrency` is passed via the config.
    try:
        # The `config` argument allows passing configurations like `max_concurrency`
        # which some runnables (like ChatModel) can use.
        raw_llm_outputs: List[str] = rag_chain.batch(
            rag_input_list, 
            config={"max_concurrency": max_concurrency}
        )
    except Exception as e:
        logger.error(f"LLM Analyzer: Error during RAG chain batch execution: {e}", exc_info=True)
        error_reason = f"RAG 배치 처리 중 오류 발생: {str(e)}"
        return [{
            "classification": "오류", "reason": error_reason,
            "raw_llm_output": "", "koelectra_output": koelectra_outputs_map.get(comments[i], "")
        } for i in range(len(comments))]

    logger.info("RAG chain batch processing complete. Parsing results...")
    
    # 3. Parse results
    batch_results: List[Dict[str, Any]] = []
    for i, raw_output in enumerate(raw_llm_outputs):
        original_comment = comments[i] # Assumes .batch() preserves order of inputs in outputs
        classification, reason = parse_llm_output(raw_output)
        
        batch_results.append({
            "original_comment": original_comment, # Helpful for mapping back
            "classification": classification,
            "reason": reason,
            "raw_llm_output": raw_output,
            "koelectra_output": koelectra_outputs_map.get(original_comment, "[KoELECTRA 정보 없음]")
        })
        logger.debug(f"Batch analyzed '{original_comment[:30]}...': Class='{classification}', Reason='{reason[:30]}...'")

    logger.info(f"Batch analysis finished for {len(comments)} comments.")
    return batch_results