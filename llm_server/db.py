from flask_sqlalchemy import SQLAlchemy
from datetime import datetime , timezone

db = SQLAlchemy()

# --- 모델 정의 ---
class WordReport(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    word = db.Column(db.String, nullable=False)
    reason = db.Column(db.String, nullable=False)
    timestamp = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

# --- 초기화 함수 ---
def init_db(app):
    db.init_app(app)
    with app.app_context():
        db.create_all()

# --- 유틸 함수 예시 ---
def add_report(word: str, reason: str):
    report = WordReport(word=word, reason=reason)
    db.session.add(report)
    db.session.commit()

def get_reason_list_for_word(word: str):
    return [
        r.reason for r in WordReport.query.filter_by(word=word).all()
    ]

def get_word_report_count(word: str) -> int:
    return WordReport.query.filter_by(word=word).count()

#---- 신고 쌓인 단어 삭제 ----
def erase_db(word: str):
    WordReport.query.filter_by(word=word).delete()
    db.session.commit()

