# config.py
import os
from dotenv import load_dotenv
from typing import List
import torch
from pathlib import Path

load_dotenv() # .env 파일에서 환경 변수 로드

# --- OpenAI API Configuration ---
OPENAI_API_KEY = os.getenv('OPENAI_API_KEY')
OPENAI_MODEL_NAME = "gpt-4.1"

# --- Hugging Face API Configuration ---
HF_TOKEN = os.getenv('HF_TOKEN')

# --- Paths and Model Names (Prioritize Colab Notebook's specifications) ---
# Ensure these paths are correct for your Colab environment (e.g., after Drive mount)
FAISS_SAVE_PATH: str = os.getenv('FAISS_SAVE_PATH', "faissDB_clovax")

# 현재 파일(config.py)의 위치 기준으로 경로 계산
BASE_DIR = Path(__file__).resolve().parent
CSV_FILE_PATH = BASE_DIR / "data" / "mz_hate_speech.csv"

# KOELECTRA Model Configuration
KOELECTRA_BASE_MODEL_NAME = "monologg/koelectra-base-v3-discriminator" 
KOELECTRA_FINETUNED_REPO_ID = "hatedog/koelectra-multilabel-finetuned"
KOELECTRA_FINETUNED_FILENAME = "koelectra_multilabel_model.pt"


EMBEDDING_MODEL_NAME = "dragonkue/snowflake-arctic-embed-l-v2.0-ko" # Matches notebook
# HF_LLM_MODEL_NAME: str = os.getenv('HF_LLM_MODEL_NAME', "hatedog/clovax-lora-finetuned") # Matches notebook
# Let's use a more readily available model for easier setup, can be swapped with clovax if it's public/accessible
HF_LLM_MODEL_NAME = "hatedog/clovax-lora-finetuned"


# --- Ngrok Configuration ---
NGROK_AUTH_TOKEN: str = os.getenv('NGROK_AUTH_TOKEN') # Replace with your actual token

# --- Parameters ---
FEW_SHOT_K: int = int(os.getenv('FEW_SHOT_K', 1)) # Matches notebook
MAX_NEW_TOKENS: int = int(os.getenv('MAX_NEW_TOKENS', 50)) # Matches notebook
TEMPERATURE: float = float(os.getenv('TEMPERATURE', 0.1)) # Matches notebook
TOP_P: float = float(os.getenv('TOP_P', 0.9)) # Matches notebook
DO_SAMPLE: bool = os.getenv('DO_SAMPLE', 'True').lower() == 'true' # Matches notebook
SIMILARITY_THRESHOLD: float = float(os.getenv('SIMILARITY_THRESHOLD', 0.2)) # Matches notebook

# --- CSV/Document Structure ---
CONTENT_COLUMN_NAME: str = '예시표현'
METADATA_COLUMN_NAMES: List[str] = ['범주', '간략 정의/맥락', 'label']
EXAMPLE_SELECTOR_INPUT_KEY: str = 'user_comment' # Key used in prompts for user input

# --- Prompting ---
RAG_CHAIN_INPUT_KEY: str = 'user_comment' # Key for the main input to the RAG chain
KOELECTRA_CONTEXT_KEY: str = 'koelectra_context'
INCLUDE_KOELECTRA_KEY: str = 'include_koelectra'

# --- Device ---
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

# --- Port Configuration ---
PORT: int = int(os.getenv('PORT', 5000)) # Default to 5000 if not set

KOELECTRA_BYPASS_THRESHOLD = 0.9 # Threshold for bypassing KOELECTRA
