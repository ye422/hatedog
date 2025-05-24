// content_script.js

// 1. 중복 로딩 방지 플래그
if (window.ytCommentsAnalyzerInitialized) {
    console.log("YouTube 댓글 분석기: 이미 초기화됨. 추가 실행을 방지합니다.");
} else {
    window.ytCommentsAnalyzerInitialized = true;
    console.log("YouTube 댓글 분석기: content_script.js 로드 및 초기화 시작.");

    const SERVER_URL = "서버 URL로 변경 필요" // 서버 URL (ngrok 또는 실제 서버)
    const COMMENTS_SECTION_SELECTOR = "ytd-comments#comments"; // 댓글 섹션 전체
    const COMMENT_WRAPPER_SELECTOR = "ytd-comment-thread-renderer, ytd-comment-view-model[is-reply]";
    const CONTENT_WRAPPER_SELECTOR = "#content-text";
    const TEXT_SPAN_SELECTOR = "span.yt-core-attributed-string"; // 실제 텍스트가 표시되는 span

    // currentCommentsData: key: contentId, value: { originalTextSnapshot, processed, sending, uiState, classification }
    let currentCommentsData = {};
    let processingXHR = false; // 한 번에 하나의 서버 요청만 처리하기 위한 플래그
    let commentObserver = null;
    let debounceTimer = null;
    let requestQueue = []; // 서버 요청 대기 큐 (개별 댓글 작업 객체 저장)

    // --- 상태 및 UI 관련 클래스 ---
    const CHECKING_TEXT = "확인중...";
    const CENSORED_TEXT = "검열됨";
    const CLASS_CHECKING = "yt-comment-analyzer-checking";
    const CLASS_FILTERED_HATE = "yt-comment-analyzer-filtered-hate";
    const CLASS_PROCESSED_NORMAL = "yt-comment-analyzer-processed-normal";
    const VISUAL_INDICATOR_CLASS = "yt-comment-analyzer-indicator";
    const HIDDEN_ORIGINAL_SPAN_CLASS = "yt-analyzer-hidden-original-text";

    const DEBOUNCE_DELAY = 1000;

    function getVideoId() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('v') || 'unknown_video_id';
    }

    function getCommentId(el, forInitialScan = false) {
        const contentWrapper = el.querySelector(CONTENT_WRAPPER_SELECTOR);
        if (contentWrapper) {
            let textForId = "";
            const tempTextCheck = contentWrapper.textContent?.trim();

            if (!forInitialScan) { // UI 업데이트 후 ID 재생성 시도 시
                const hiddenSpan = contentWrapper.querySelector(`.${HIDDEN_ORIGINAL_SPAN_CLASS}`);
                if (hiddenSpan) {
                    textForId = hiddenSpan.textContent?.trim();
                } else if (tempTextCheck !== CHECKING_TEXT && tempTextCheck !== CENSORED_TEXT) {
                    // 숨겨진 스팬 없고, 확인중/검열됨도 아니면 현재 보이는 텍스트 사용
                    textForId = tempTextCheck;
                } else {
                    return null; // ID 생성 불가
                }
            } else { // 초기 스캔 시 (UI 변경 전)
                if (tempTextCheck === CHECKING_TEXT || tempTextCheck === CENSORED_TEXT) {
                    // 이 경우는 scrapeAndProcessComments에서 걸러지지만, 방어적으로 추가
                    return null;
                }
                textForId = tempTextCheck;
            }

            if (!textForId) return null;

            const shortText = textForId.slice(0, 30).replace(/\s+/g, "");
            return `pseudo--${getVideoId()}--${shortText}`;
        }
        return null;
    }

    // getCommentIdFromHiddenSpan은 ID 재생성 시 숨겨진 원본 텍스트를 우선적으로 사용
    function getCommentIdFromHiddenSpan(el) {
        const contentWrapper = el.querySelector(CONTENT_WRAPPER_SELECTOR);
        if (contentWrapper) {
            const hiddenSpan = contentWrapper.querySelector(`.${HIDDEN_ORIGINAL_SPAN_CLASS}`);
            if (hiddenSpan && hiddenSpan.textContent) {
                const originalText = hiddenSpan.textContent.trim();
                if (originalText) {
                    const shortText = originalText.slice(0, 30).replace(/\s+/g, "");
                    return `pseudo--${getVideoId()}--${shortText}`;
                }
            }
        }
        // Fallback: 숨겨진 스팬 없거나 내용 없으면, 현재 보이는 텍스트로 (단, CHECKING/CENSORED 제외)
        // 이 함수는 주로 'checking' 상태의 element에서 호출되므로, hidden span이 중요.
        // 만약 hidden span이 없다면 getCommentId(el, false)와 유사하게 동작해야 하나,
        // 이 함수의 주 목적은 '확인중' UI 내의 원본을 찾는 것이므로 null 반환이 적절할 수 있음.
        // console.warn("YouTube 댓글 분석기: 숨겨진 span에서 ID 생성 실패, el:", el);
        return null;
    }


    function setElementUIToChecking(element, originalTextContent) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            if (!element.dataset.originalContentAnalyzer) {
                element.dataset.originalContentAnalyzer = originalTextContent;
            }
            // console.log("YouTube 댓글 분석기: 원본 텍스트 저장:", originalTextContent.slice(0,30));
            textElement.innerHTML = `${CHECKING_TEXT}<span class="${HIDDEN_ORIGINAL_SPAN_CLASS}" style="display: none;">${originalTextContent}</span>`;
        }
        element.classList.add(CLASS_CHECKING);
        element.classList.remove(CLASS_PROCESSED_NORMAL, CLASS_FILTERED_HATE);
        element.dataset.analyzerState = 'checking';
    }

    function restoreElementUIToNormal(element) {
        const originalTextContent = element.dataset.originalContentAnalyzer || "";
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            textElement.textContent = originalTextContent;
        }
        element.classList.remove(CLASS_CHECKING, CLASS_FILTERED_HATE);
        element.classList.add(CLASS_PROCESSED_NORMAL);
        element.dataset.analyzerState = 'processed_normal'; // 좀 더 명확한 상태

        const indicator = element.querySelector(`.${VISUAL_INDICATOR_CLASS}`);
        if (indicator) indicator.remove();
    }

    function setElementUIToCensored(element) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            // 원본은 dataset.originalContentAnalyzer에 이미 저장되어 있어야 함.
            // CENSORED_TEXT 뒤에 숨겨진 원본을 또 넣을 필요는 없음. setElementUIToChecking에서 이미 처리.
            textElement.textContent = CENSORED_TEXT;
        }
        element.classList.remove(CLASS_CHECKING, CLASS_PROCESSED_NORMAL);
        element.classList.add(CLASS_FILTERED_HATE);
        element.dataset.analyzerState = 'processed_hate'; // 좀 더 명확한 상태
    }


    function sendCommentToServer(commentTask) {
        console.log(`YouTube 댓글 분석기: 🚀 서버로 댓글 전송 시도 (ID: ${commentTask.id.slice(0, 50)}...)`);

        fetch(SERVER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // 서버가 여전히 'comments' 배열을 기대한다고 가정
            body: JSON.stringify({ comments: [{ id: commentTask.id, text: commentTask.text, videoId: commentTask.videoId }] }),
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP 에러 ${response.status}: ${response.statusText}`);
                }
                return response.json();
            })
            .then(data => {
                console.log("YouTube 댓글 분석기: ✅ 서버 응답 받음:", data);
                if (data && data.comments && data.comments.length > 0) {
                    const result = data.comments[0];
                    applyCensorshipToMatchingElements(result.id, result.classification, result.reason);
                    if (currentCommentsData[result.id]) {
                        currentCommentsData[result.id].processed = true;
                        currentCommentsData[result.id].sending = false;
                        currentCommentsData[result.id].classification = result.classification;
                        currentCommentsData[result.id].uiState = 'processed';
                    }
                } else {
                    console.warn("YouTube 댓글 분석기: 서버 응답 형식이 잘못됨.", data);
                    // 오류 발생 시, 해당 contentId를 가진 'checking' 상태의 모든 댓글을 원상복구
                    restoreAllMatchingElementsToNormalOnError(commentTask.id);
                    if (currentCommentsData[commentTask.id]) {
                        currentCommentsData[commentTask.id].sending = false;
                        currentCommentsData[commentTask.id].uiState = 'error';
                    }
                }
            })
            .catch(error => {
                console.error(`YouTube 댓글 분석기: ❌ 서버 전송/처리 오류 (ID: ${commentTask.id.slice(0, 50)}):`, error);
                restoreAllMatchingElementsToNormalOnError(commentTask.id);
                if (currentCommentsData[commentTask.id]) {
                    currentCommentsData[commentTask.id].sending = false;
                    currentCommentsData[commentTask.id].uiState = 'error';
                }
            })
            .finally(() => {
                console.log(`YouTube 댓글 분석기: 서버 요청 처리 완료 (ID: ${commentTask.id.slice(0, 50)}).`);
                processingXHR = false;
                processRequestQueue(); // 다음 작업 시도
            });
    }

    function processRequestQueue() {
        if (processingXHR || requestQueue.length === 0) {
            if (requestQueue.length === 0 && !processingXHR) {
                // console.log("YouTube 댓글 분석기: 모든 댓글 처리 완료 (큐 비어있음).");
            }
            return;
        }
        processingXHR = true;
        const nextTask = requestQueue.shift();
        console.log(`YouTube 댓글 분석기: 큐에서 다음 작업 가져옴 (남은 큐: ${requestQueue.length}개), ID: ${nextTask.id.slice(0, 50)}`);
        sendCommentToServer(nextTask);
    }


    function scrapeAndProcessComments() {
        console.log("YouTube 댓글 분석기: 🔍 댓글 스캔 시작...");
        const commentElements = document.querySelectorAll(COMMENT_WRAPPER_SELECTOR);
        let newTasksAddedToQueue = 0;

        commentElements.forEach(el => {
            const currentAnalyzerState = el.dataset.analyzerState;
            // 이미 최종 처리된 (processed_normal, processed_hate) 댓글은 건너뜀
            if (currentAnalyzerState === 'processed_normal' || currentAnalyzerState === 'processed_hate') {
                return;
            }

            // UI가 "확인중..."(checking)이지만 아직 currentCommentsData에 sending=true로 마킹되지 않은 경우,
            // 또는 DOM 요소는 아직 마킹 안됐지만 내용은 이미 보내진 경우 등을 고려해야함.
            // ID 생성을 먼저 시도.
            // getCommentId는 현재 보이는 텍스트 기준(초기 스캔)
            const visibleText = el.querySelector(CONTENT_WRAPPER_SELECTOR)?.textContent?.trim();
            if (!visibleText || visibleText === CHECKING_TEXT || visibleText === CENSORED_TEXT) {
                // 만약 UI가 CHECKING_TEXT인데 dataset.analyzerState가 'checking'이 아니면 이상한 상태.
                // 여기서는 일단 화면에 보이는 텍스트가 유효하지 않으면 ID 생성 시도 안함.
                // getCommentIdFromHiddenSpan을 써야하는 경우는 applyCensorshipToMatchingElements 쪽.
                return;
            }

            const contentId = getCommentId(el, true); // 초기 스캔이므로 true
            if (!contentId) return;

            const commentDataEntry = currentCommentsData[contentId];

            if (commentDataEntry) {
                if (commentDataEntry.processed) {
                    // 이미 분석 완료된 내용 -> 이 DOM 요소에 즉시 UI 적용
                    if (currentAnalyzerState !== 'processed_normal' && currentAnalyzerState !== 'processed_hate') {
                        console.log(`YouTube 댓글 분석기: 캐시된 결과 적용 (ID: ${contentId.slice(0, 50)}), 상태: ${commentDataEntry.classification}`);
                        if (commentDataEntry.classification === "정상") {
                            restoreElementUIToNormal(el);
                        } else if (commentDataEntry.classification === "혐오") {
                            setElementUIToCensored(el);
                        }
                        // dataset.originalContentAnalyzer 설정은 setElementUIToChecking에서 하므로,
                        // 캐시 적용 시에는 원본 텍스트를 다시 설정해줘야 함.
                        // 또는, setElementUIToChecking을 무조건 호출하고, 그 안에서 data 속성 중복 저장을 막는 방법도 있음.
                        if (!el.dataset.originalContentAnalyzer) {
                            el.dataset.originalContentAnalyzer = commentDataEntry.originalTextSnapshot || visibleText;
                        }
                    }
                } else if (commentDataEntry.sending) {
                    // 내용이 현재 전송/분석 중 -> 이 DOM 요소 UI를 'checking'으로 (아직 아니라면)
                    if (currentAnalyzerState !== 'checking') {
                        setElementUIToChecking(el, visibleText); // 원본 텍스트는 현재 보이는 텍스트
                        console.log(`YouTube 댓글 분석기: 이미 전송중인 내용의 다른 요소 UI 'checking'으로 변경 (ID: ${contentId.slice(0, 50)})`);
                    }
                } else { // not processed, not sending (e.g. previous error, or re-scan)
                    // 재시도 로직: 이전에 오류가 났거나, 어떤 이유로 sending=false, processed=false가 된 경우
                    console.log(`YouTube 댓글 분석기: 미처리/미전송 댓글 재요청 준비 (ID: ${contentId.slice(0, 50)})`);
                    setElementUIToChecking(el, visibleText);
                    currentCommentsData[contentId] = {
                        originalTextSnapshot: visibleText,
                        processed: false,
                        sending: true, // 이제 보낼거니까 true
                        uiState: 'checking',
                        classification: null
                    };
                    requestQueue.push({ el, id: contentId, text: visibleText, videoId: getVideoId() });
                    newTasksAddedToQueue++;
                }
            } else {
                // 새로운 내용의 댓글 발견
                console.log(`YouTube 댓글 분석기: 새 댓글 발견, 처리 대기열 추가 (ID: ${contentId.slice(0, 50)})`);
                setElementUIToChecking(el, visibleText);
                currentCommentsData[contentId] = {
                    originalTextSnapshot: visibleText,
                    processed: false,
                    sending: true, // 큐에 넣고 바로 processRequestQueue가 호출되면 sending 상태가 됨
                    uiState: 'checking',
                    classification: null
                };
                requestQueue.push({ el, id: contentId, text: visibleText, videoId: getVideoId() });
                newTasksAddedToQueue++;
            }
        });

        if (newTasksAddedToQueue > 0) {
            console.log(`YouTube 댓글 분석기: ${newTasksAddedToQueue}개의 새 작업이 큐에 추가됨. 큐 처리 시작.`);
            processRequestQueue(); // 큐에 작업이 추가되었으므로 처리 시도
        } else {
            // console.log("YouTube 댓글 분석기: 스캔 결과, 새로 보내거나 재시도할 댓글 없음.");
        }
    }


    function applyCensorshipToMatchingElements(targetContentId, classification, reason) {
        console.log(`YouTube 댓글 분석기: 📝 서버 결과 DOM 반영 시도 (ID: ${targetContentId.slice(0, 50)}, Class: ${classification})`);
        let updatedCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            // dataset.analyzerState가 'checking'인 요소들만 업데이트 대상
            if (el.dataset.analyzerState === 'checking') {
                // ID를 숨겨진 원본 텍스트에서 가져와 비교
                const elContentId = getCommentIdFromHiddenSpan(el); // Checking 상태이므로 hidden span에서 ID 추출
                if (elContentId === targetContentId) {
                    if (classification === "정상") {
                        restoreElementUIToNormal(el);
                    } else if (classification === "혐오") {
                        setElementUIToCensored(el);
                    } else { // 예외 케이스 (e.g. 알수없음 등) - 일단 정상 처리
                        console.warn(`YouTube 댓글 분석기: 알 수 없는 분류 (${classification}), 정상으로 처리.`);
                        restoreElementUIToNormal(el);
                    }
                    updatedCount++;
                }
            }
        });
        if (updatedCount > 0) {
            console.log(`YouTube 댓글 분석기: ${updatedCount}개 요소 UI 업데이트 완료 (ID: ${targetContentId.slice(0, 50)})`);
        } else {
            // console.log(`YouTube 댓글 분석기: ID ${targetContentId.slice(0,50)}에 대해 업데이트할 'checking' 상태의 요소 없음.`);
        }
    }

    function restoreAllMatchingElementsToNormalOnError(targetContentId) {
        console.warn(`YouTube 댓글 분석기: 오류 발생, ID ${targetContentId.slice(0, 50)} 관련 댓글 원상 복구 시도.`);
        let restoredCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            if (el.dataset.analyzerState === 'checking') {
                const elContentId = getCommentIdFromHiddenSpan(el);
                if (elContentId === targetContentId) {
                    restoreElementUIToNormal(el); // dataset.analyzerState는 'processed_normal'로 바뀜
                    el.dataset.analyzerState = 'error_restored'; // 오류 후 복구되었음을 명시
                    restoredCount++;
                }
            }
        });
        if (restoredCount > 0) {
            console.log(`YouTube 댓글 분석기: ${restoredCount}개 요소 오류로 인해 원상 복구됨 (ID: ${targetContentId.slice(0, 50)})`);
        }
    }


    function handleCommentMutations(mutationsList) {
        let newRelevantChanges = false;
        for (const mutation of mutationsList) {
            if (mutation.type === "childList" && mutation.addedNodes.length > 0) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && (node.matches(COMMENT_WRAPPER_SELECTOR) || node.querySelector(COMMENT_WRAPPER_SELECTOR))) {
                        newRelevantChanges = true;
                        break;
                    }
                }
            }
            if (newRelevantChanges) break;
        }

        if (newRelevantChanges) {
            console.log("YouTube 댓글 분석기: ➕ 새로운 댓글 관련 노드 추가 감지. 디바운스 타이머 설정.");
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                scrapeAndProcessComments();
            }, DEBOUNCE_DELAY);
        }
    }

    function initializeAndStartObserver() {
        const commentsSectionElement = document.querySelector(COMMENTS_SECTION_SELECTOR);

        if (!commentsSectionElement) {
            console.log("YouTube 댓글 분석기: 댓글 섹션(", COMMENTS_SECTION_SELECTOR, ")을 아직 찾을 수 없음. 0.5초 후 재시도.");
            setTimeout(initializeAndStartObserver, 500);
            return;
        }

        console.log("YouTube 댓글 분석기: ✅ 댓글 섹션 발견. 초기 댓글 스캔 및 MutationObserver 시작.");
        scrapeAndProcessComments(); // 초기 스캔

        if (commentObserver) commentObserver.disconnect();
        commentObserver = new MutationObserver(handleCommentMutations);
        commentObserver.observe(commentsSectionElement, { childList: true, subtree: true });

        window.addEventListener('unload', () => {
            if (commentObserver) commentObserver.disconnect();
            clearTimeout(debounceTimer);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initializeAndStartObserver, 500);
        });
    } else {
        setTimeout(initializeAndStartObserver, 500);
    }
}