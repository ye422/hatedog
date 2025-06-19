# app.py
import os
from flask import Flask, request, jsonify, make_response
from flask_cors import CORS
import llm_analyzer
import config
import logging
import time # 각 댓글 처리 시간 측정을 위해 (선택 사항)
# db 관련
from flask import Flask, request, jsonify
from db import init_db, db, add_report, get_word_report_count, get_reason_list_for_word, erase_db

# 새로 만든 모듈에서 함수 import
from vectorDB_update import process_triggered_report 

app = Flask(__name__)
app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///reports.db'
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
init_db(app)

# CORS 정책: 모든 출처, 모든 메소드 허용
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)

if not app.debug:
    app.logger.setLevel(logging.INFO)

components_initialized = False

def initialize_app_components():
    global components_initialized
    if not components_initialized:
        app.logger.info("Flask 앱: LLM 구성 요소 초기화 시작...")
        app.logger.info(f"Flask 앱: 사용 장치: {config.DEVICE}")
        if llm_analyzer.initialize_llm_components():
            components_initialized = True
            app.logger.info("Flask 앱: LLM 구성 요소 초기화 완료.")
        else:
            app.logger.error("Flask 앱: 오류 - LLM 구성 요소 초기화 실패.")
    else:
        app.logger.info("Flask 앱: LLM 구성 요소 이미 초기화됨.")

@app.route('/analyze', methods=['POST', 'OPTIONS'])
def analyze_comment_endpoint():
    if request.method == 'OPTIONS':
        response = make_response()
        # Flask-CORS가 대부분 처리하지만, 명시적으로 추가할 수도 있습니다.
        # 기본적으로 CORS(app, ...) 설정에서 origins, methods, headers가 적절히 설정되어야 합니다.
        # Flask-CORS는 preflight 요청에 대해 자동으로 적절한 헤더를 설정해줍니다.
        # 아래 헤더들은 Flask-CORS 설정과 중복될 수 있으나, 문제 해결을 위해 명시적으로 둘 수도 있습니다.
        response.headers.add('Access-Control-Allow-Origin', '*')
        response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization') # 클라이언트가 보내는 헤더
        response.headers.add('Access-Control-Allow-Methods', 'POST,OPTIONS') # 허용하는 메소드
        app.logger.info("'/analyze' Preflight (OPTIONS) 요청 처리 완료.")
        return response, 204 # 204 No Content는 preflight 응답에 적합

    app.logger.info(f"'/analyze' 엔드포인트 POST 요청 수신 - IP: {request.remote_addr}")

    if not components_initialized:
        app.logger.warning("'/analyze' 요청: 분석기 준비 안됨. 503 반환.")
        return jsonify({"error": "분석기 준비 안됨. 초기화 실패 또는 진행 중일 수 있습니다."}), 503

    if not request.is_json:
        app.logger.warning("'/analyze' 요청: JSON 형식이 아님. 400 반환.")
        return jsonify({"error": "요청은 JSON 형식이어야 합니다."}), 400

    try:
        data = request.get_json()
        app.logger.info(f"수신된 JSON 데이터 (키 목록): {list(data.keys()) if isinstance(data, dict) else 'Not a dict'}")
        if isinstance(data, dict) and 'comments' in data:
             app.logger.info(f"수신된 댓글 수: {len(data['comments'])}")
    except Exception as e:
        app.logger.error(f"JSON 데이터 파싱 중 오류: {e}")
        return jsonify({"error": "잘못된 JSON 형식입니다."}), 400

    # 클라이언트가 보낸 'comments' 배열을 가져옵니다.
    comments_to_analyze = data.get('comments')

    if not comments_to_analyze or not isinstance(comments_to_analyze, list):
        app.logger.warning(f"'/analyze' 요청: 잘못된 'comments' 필드 (리스트가 아님). 요청 데이터: {data}")
        return jsonify({"error": "잘못된 'comments' 필드, 댓글 객체의 배열이어야 합니다."}), 400

    app.logger.info(f"{len(comments_to_analyze)}개 댓글 분석 시작...")
    processed_results = []
    total_processing_time = 0

    for i, comment_data in enumerate(comments_to_analyze):
        start_time = time.time()
        comment_text = comment_data.get('text')
        comment_id = comment_data.get('id', f"unknown_id_{i}") # ID가 없으면 임시 ID 생성

        if not comment_text or not isinstance(comment_text, str):
            app.logger.warning(f"잘못된 댓글 텍스트 (ID: {comment_id}): {comment_text}")
            # 클라이언트가 이 형식으로 오류를 처리할 수 있도록 함
            processed_results.append({
                "id": comment_id,
                "error": "Invalid or missing text field",
                "classification": "오류",
                "is_hateful": False # 또는 다른 기본값
            })
            continue

        #app.logger.info(f"댓글 분석 중 (ID: {comment_id}, 텍스트 일부: {comment_text[:50]}...)")
        try:
            # 각 댓글을 llm_analyzer로 개별 분석
            analysis_result = llm_analyzer.analyze_comment(comment_text)
            #app.logger.info(f"ID {comment_id} 분석 결과: {analysis_result}")

            is_hateful = analysis_result.get("classification", "불명확") == "혐오"
            
            # 클라이언트가 원래 `content_script.js`에서 기대하는 형식으로 결과 구성
            # 원래 content_script는 text 필드를 기대하여 DOM을 업데이트 함.
            # 분석 결과에 따라 다른 텍스트를 보내거나, is_hateful/classification을 보내 클라이언트가 결정하도록 함
            result_text_for_client = f"[{analysis_result.get('classification', 'N/A')}] {analysis_result.get('reason', '')}"
            if is_hateful:
                 # 여기서는 예시로 "검열됨"을 보내지만, 클라이언트가 is_hateful 값을 보고 직접 처리하게 할 수도 있음
                 result_text_for_client = "[혐오 발언 의심되어 내용 가림]"


            processed_results.append({
                "id": comment_id, # 원래 댓글 ID 반환
                "text": result_text_for_client, # DOM 업데이트를 위한 텍스트 (또는 아래처럼 상세 정보)
                "is_hateful": is_hateful,
                "classification": analysis_result.get("classification", "불명확"),
                "reason": analysis_result.get("reason", "파싱 실패"),
                # "raw_llm_output": analysis_result.get("raw_llm_output", ""), # 필요에 따라 포함
                # "koelectra_output": analysis_result.get("koelectra_output", "") # 필요에 따라 포함
            })
        except Exception as e:
            app.logger.error(f"댓글 (ID: {comment_id}) 분석 중 예외 발생: {e}", exc_info=True)
            processed_results.append({
                "id": comment_id,
                "error": "Analysis failed",
                "text": "[분석 오류]",
                "classification": "오류",
                "is_hateful": False
            })
        
        end_time = time.time()
        processing_time = end_time - start_time
        total_processing_time += processing_time
        # ✅ 깔끔한 로그 출력
        app.logger.info(f'\n[분석 결과] 댓글: "{comment_text[:50]}{"..." if len(comment_text) > 50 else ""}"')
        app.logger.info(f'- 판단 사유: {analysis_result.get("reason", "파싱 실패")}')
        app.logger.info(f'- 처리 시간: {processing_time:.2f}초')

    app.logger.info(f"\n총 {len(comments_to_analyze)}개 댓글 처리 완료. 총 소요 시간: {total_processing_time:.2f}초")
    
    # 클라이언트가 기대하는 { "comments": [...] } 형식으로 최종 응답 구성
    response = jsonify({"comments": processed_results})
    # Access-Control-Allow-Origin 헤더는 Flask-CORS 미들웨어가 자동으로 추가해 줄 것입니다.
    # 만약 수동으로 추가하고 싶다면 response.headers.add(...) 사용
    return response


@app.route("/report_word", methods=["POST"])
def report_word():
    data = request.json
    word = data.get("word")
    reason = data.get("reason")

    if not word or not reason:
        app.logger.warning("'/report_word' 요청: word 또는 reason 누락.")
        return jsonify({'error': 'word and reason are required'}), 400

    try:
        add_report(word, reason) # DB에 신고 추가
        app.logger.info(f"새로운 신고 추가: 단어='{word}', 사유='{reason[:30]}...'")

        report_count = get_word_report_count(word)
        app.logger.info(f"단어 '{word}'의 현재 신고 횟수: {report_count}")

        # 신고 횟수가 10회 이상일 때 처리 로직 실행 (config.py 등에서 임계값 관리 권장)
        REPORT_THRESHOLD = 1 
        if report_count >= REPORT_THRESHOLD:
            app.logger.info(f"단어 '{word}' 신고 {REPORT_THRESHOLD}회 도달. 자동 처리 시작.")
            
            # vectorDB_update.py (또는 report_processor.py)의 함수 호출
            # 이 함수 내부에서 get_reason_list_for_word, LLM 호출, CSV 업데이트, VectorDB 업데이트, erase_db 모두 처리
            success = process_triggered_report(word) 
            
            if success:
                app.logger.info(f"단어 '{word}' 자동 처리 성공.")
            else:
                app.logger.error(f"단어 '{word}' 자동 처리 중 문제 발생. vectorDB_update.py 로그 확인 필요.")
                # 실패 시 어떤 응답을 줄지, DB에서 신고 기록을 어떻게 할지 정책 필요
                # 예: 실패 시 erase_db를 호출하지 않아 다음 신고 시 재시도 기회 부여
        
        return jsonify({'status': 'ok', 'report_count': report_count})

    except Exception as e:
        app.logger.error(f"'/report_word' 처리 중 예외 발생: {e}", exc_info=True)
        return jsonify({'error': 'Internal server error during report processing'}), 500

if __name__ == '__main__':
    # Gunicorn 등 WSGI 서버 사용 시에는 이 로깅 설정이 다르게 적용될 수 있음
    gunicorn_logger = logging.getLogger('gunicorn.error')
    app.logger.handlers.extend(gunicorn_logger.handlers) # gunicorn 로거와 핸들러 공유 (선택 사항)
    app.logger.setLevel(logging.INFO) # INFO 레벨 명시적 설정

    initialize_app_components()
    port = int(os.environ.get("PORT", 5000))
    app.logger.info(f"Flask 서버 시작 중... http://0.0.0.0:{port}")
    app.run(host='0.0.0.0', port=port, debug=False)