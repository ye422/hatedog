// content_script.js

// 1. 중복 로딩 방지 플래그
if (window.ytCommentsAnalyzerInitialized) {
    console.log("YouTube 댓글 분석기: 이미 초기화됨. 추가 실행을 방지합니다.");
} else {
    window.ytCommentsAnalyzerInitialized = true;
    console.log("YouTube 댓글 분석기: content_script.js 로드 및 초기화 시작.");

    const SERVER_URL = "https://b146-34-124-222-31.ngrok-free.app"; // 서버 URL (ngrok 또는 실제 서버)
    const SERVER_ANALYZE_URL = SERVER_URL + "/analyze";
    const SERVER_REPORT_WORD_URL = SERVER_URL + "/report_word";
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

    let isScraping = false; // 스크래핑 함수 실행 중 플래그

    // --- 큐 처리 시간 측정용 변수 ---
    let queueFillStartTime = null;
    let queueProcessingFinished = false; // 큐 처리 시간 측정을 한 번만 하기 위한 플래그

    // --- 상태 및 UI 관련 클래스 ---
    const CHECKING_TEXT = "확인중...";
    const CENSORED_TEXT = "검열됨";
    const CLASS_CHECKING = "yt-comment-analyzer-checking";
    const CLASS_FILTERED_HATE = "yt-comment-analyzer-filtered-hate";
    const CLASS_PROCESSED_NORMAL = "yt-comment-analyzer-processed-normal";
    const VISUAL_INDICATOR_CLASS = "yt-comment-analyzer-indicator";
    const HIDDEN_ORIGINAL_SPAN_CLASS = "yt-analyzer-hidden-original-text";

    // 느낌표 추가
    // --- 상태 및 UI 관련 클래스 (버튼 관련) ---
    const CUSTOM_ACTION_BUTTON_CLASS = 'yt-analyzer-custom-action-button';
    const CUSTOM_MENU_RENDERER_CLASS = 'yt-analyzer-custom-menu-renderer';



    const DEBOUNCE_DELAY = 100;

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
                    textForId = tempTextCheck;
                } else {
                    return null;
                }
            } else { // 초기 스캔 시 (UI 변경 전)
                if (tempTextCheck === CHECKING_TEXT || tempTextCheck === CENSORED_TEXT) {
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
        return null;
    }


    function setElementUIToChecking(element, originalTextContent) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            if (!element.dataset.originalContentAnalyzer) {
                element.dataset.originalContentAnalyzer = originalTextContent;
            }
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
        element.dataset.analyzerState = 'processed_normal';

        const indicator = element.querySelector(`.${VISUAL_INDICATOR_CLASS}`);
        if (indicator) indicator.remove();
    }

    function setElementUIToCensored(element) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            textElement.textContent = CENSORED_TEXT;
        }
        element.classList.remove(CLASS_CHECKING, CLASS_PROCESSED_NORMAL);
        element.classList.add(CLASS_FILTERED_HATE);
        element.dataset.analyzerState = 'processed_hate';
    }


    function sendCommentToServer(commentTask) {
        console.log(`YouTube 댓글 분석기: 🚀 서버로 댓글 전송 시도 (ID: ${commentTask.id.slice(0, 50)}...)`);

        fetch(SERVER_ANALYZE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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
                processRequestQueue();
            });
    }

    function processRequestQueue() {
        if (processingXHR || requestQueue.length === 0) {
            if (requestQueue.length === 0 && !processingXHR) {
                if (queueFillStartTime && !queueProcessingFinished) {
                    const queueEmptyTime = performance.now();
                    const duration = (queueEmptyTime - queueFillStartTime) / 1000; // 초 단위
                    console.log(`YouTube 댓글 분석기: ✅ 큐 비워짐. 총 처리 시간: ${duration.toFixed(2)}초`);
                    queueProcessingFinished = true;
                }
            }
            return;
        }
        processingXHR = true;
        const nextTask = requestQueue.shift();
        console.log(`YouTube 댓글 분석기: 큐에서 다음 작업 가져옴 (남은 큐: ${requestQueue.length}개), ID: ${nextTask.id.slice(0, 50)}`);
        sendCommentToServer(nextTask);
    }




    async function scrapeAndProcessComments() { // async로 변경하여 내부 await 사용 가능 (선택적이지만, 복잡한 DOM 조작 시 유용할 수 있음)
        if (isScraping) {
            console.log("YouTube 댓글 분석기: 이미 스크래핑 진행 중. 이번 호출 건너뜀.");
            return;
        }
        isScraping = true;
        console.log("YouTube 댓글 분석기: 🔍 댓글 스캔 시작...");

        try {
            const commentElements = document.querySelectorAll(COMMENT_WRAPPER_SELECTOR);
            let newTasksAddedToQueue = 0;

            commentElements.forEach(el => {
                const currentAnalyzerState = el.dataset.analyzerState;
                // 이미 최종 처리된 (processed_normal, processed_hate) 댓글은 건너뜀
                if (currentAnalyzerState === 'processed_normal' || currentAnalyzerState === 'processed_hate') {
                    return;
                }

                let originalTextForThisComment;
                const contentWrapper = el.querySelector(CONTENT_WRAPPER_SELECTOR);
                if (!contentWrapper) return;

                // 1. 원본 텍스트 확보 (수정된 로직)
                if (el.dataset.originalContentAnalyzer) {
                    // dataset에 저장된 원본 텍스트가 최우선
                    originalTextForThisComment = el.dataset.originalContentAnalyzer;
                } else if (currentAnalyzerState === 'checking') {
                    // UI는 'checking'인데 dataset에 원본이 없는 경우 (이론상 발생하면 안되지만 방어 코드)
                    // 숨겨진 span에서 가져오기 시도
                    const hiddenSpan = contentWrapper.querySelector(`.${HIDDEN_ORIGINAL_SPAN_CLASS}`);
                    if (hiddenSpan && hiddenSpan.textContent) {
                        originalTextForThisComment = hiddenSpan.textContent.trim();
                    } else {
                        // console.warn("YouTube 댓글 분석기: 'checking' 상태지만 원본 텍스트 확보 불가 (dataset 및 hidden span 모두 실패)", el);
                        return; // 원본 없으면 처리 불가
                    }
                } else {
                    // UI가 아직 'checking'이 아니고, dataset에도 원본이 없는 초기 상태 (완전 새 댓글)
                    const currentVisibleText = contentWrapper.textContent?.trim();
                    // "확인중..." 이나 "검열됨" 문자열이 아닌, 실제 내용일 때만 원본으로 간주
                    if (currentVisibleText && currentVisibleText !== CHECKING_TEXT && currentVisibleText !== CENSORED_TEXT) {
                        originalTextForThisComment = currentVisibleText;
                    } else {
                        // console.warn("YouTube 댓글 분석기: 초기 스캔에서 유효한 원본 텍스트 확보 불가 (내용 없거나 UI 문자열)", el, currentVisibleText);
                        return; // 유효한 원본 아니면 처리 불가
                    }
                }

                if (!originalTextForThisComment) {
                    // console.warn("YouTube 댓글 분석기: 최종적으로 원본 텍스트 확보 실패", el);
                    return;
                }

                // 2. Comment ID 생성 (확보된 순수 원본 텍스트 기준)
                const contentId = getCommentId(el, true, originalTextForThisComment);
                if (!contentId) {
                    // console.warn("YouTube 댓글 분석기: Comment ID 생성 실패", originalTextForThisComment.slice(0,30));
                    return;
                }

                const commentDataEntry = currentCommentsData[contentId];

                if (commentDataEntry) { // 데이터 저장소에 이미 있는 댓글 (ID 기준)
                    if (commentDataEntry.processed) {
                        if (currentAnalyzerState !== 'processed_normal' && currentAnalyzerState !== 'processed_hate') {
                            console.log(`YouTube 댓글 분석기: 저장된 분석 결과 적용 (ID: ${contentId.slice(0, 50)}), 상태: ${commentDataEntry.classification}`);
                            el.dataset.originalContentAnalyzer = commentDataEntry.originalTextSnapshot; // 복구 위해 원본 다시 확인
                            if (commentDataEntry.classification === "정상") {
                                restoreElementUIToNormal(el);
                            } else if (commentDataEntry.classification === "혐오") {
                                setElementUIToCensored(el);
                            }
                        }
                    } else if (commentDataEntry.sending) {
                        if (currentAnalyzerState !== 'checking') {
                            // 이미 보내는 중인 댓글의 다른 DOM 요소가 발견된 경우
                            setElementUIToChecking(el, commentDataEntry.originalTextSnapshot);
                            // console.log(`YouTube 댓글 분석기: 이미 전송중인 다른 요소 UI 'checking'으로 변경 (ID: ${contentId.slice(0, 50)})`);
                        }
                    } else { // 재시도 로직 (not processed, not sending, e.g. error)
                        console.log(`YouTube 댓글 분석기: 미처리/미전송 댓글 재요청 준비 (ID: ${contentId.slice(0, 50)})`);
                        setElementUIToChecking(el, commentDataEntry.originalTextSnapshot);
                        currentCommentsData[contentId].sending = true;
                        currentCommentsData[contentId].uiState = 'checking';
                        requestQueue.push({ el, id: contentId, text: commentDataEntry.originalTextSnapshot, videoId: getVideoId() });
                        newTasksAddedToQueue++;
                    }
                } else { // 새로운 내용의 댓글 발견
                    console.log(`YouTube 댓글 분석기: 새 댓글 발견, 처리 대기열 추가 (ID: ${contentId.slice(0, 50)}) Text: "${originalTextForThisComment.slice(0, 30)}"`);
                    setElementUIToChecking(el, originalTextForThisComment);
                    currentCommentsData[contentId] = {
                        originalTextSnapshot: originalTextForThisComment,
                        processed: false,
                        sending: true,
                        uiState: 'checking',
                        classification: null
                    };
                    requestQueue.push({ el, id: contentId, text: originalTextForThisComment, videoId: getVideoId() });
                    newTasksAddedToQueue++;
                }
                addCustomActionButtonToComment(el); // 커스텀 버튼 추가
            });

            if (newTasksAddedToQueue > 0) {
                if (!queueFillStartTime && !queueProcessingFinished) {
                    queueFillStartTime = performance.now();
                    console.log(`YouTube 댓글 분석기: ⏱️ 큐 채워지고 처리 시작 시간 기록됨 (${newTasksAddedToQueue}개 작업).`);
                }
                console.log(`YouTube 댓글 분석기: ${newTasksAddedToQueue}개의 새 작업이 큐에 추가됨. 큐 처리 시작.`);
                processRequestQueue();
            }
        } catch (error) {
            console.error("YouTube 댓글 분석기: scrapeAndProcessComments 중 오류 발생", error);
        } finally {
            isScraping = false;
            // console.log("YouTube 댓글 분석기: 댓글 스캔 완료 (isScraping=false).");
        }
    }


    function applyCensorshipToMatchingElements(targetContentId, classification, reason) {
        console.log(`YouTube 댓글 분석기: 📝 서버 결과 DOM 반영 시도 (ID: ${targetContentId.slice(0, 50)}, Class: ${classification})`);
        let updatedCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            if (el.dataset.analyzerState === 'checking') {
                const elContentId = getCommentIdFromHiddenSpan(el);
                if (elContentId === targetContentId) {
                    if (classification === "정상") {
                        restoreElementUIToNormal(el);
                    } else if (classification === "혐오") {
                        setElementUIToCensored(el);
                    } else {
                        console.warn(`YouTube 댓글 분석기: 알 수 없는 분류 (${classification}), 정상으로 처리.`);
                        restoreElementUIToNormal(el);
                    }
                    updatedCount++;
                }
            }
        });
        if (updatedCount > 0) {
            console.log(`YouTube 댓글 분석기: ${updatedCount}개 요소 UI 업데이트 완료 (ID: ${targetContentId.slice(0, 50)})`);
        }
    }

    function restoreAllMatchingElementsToNormalOnError(targetContentId) {
        console.warn(`YouTube 댓글 분석기: 오류 발생, ID ${targetContentId.slice(0, 50)} 관련 댓글 원상 복구 시도.`);
        let restoredCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            if (el.dataset.analyzerState === 'checking') {
                const elContentId = getCommentIdFromHiddenSpan(el);
                if (elContentId === targetContentId) {
                    restoreElementUIToNormal(el);
                    el.dataset.analyzerState = 'error_restored';
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



    // 새로운 버튼을 생성하고 댓글의 액션 메뉴에 추가하는 함수
    function addCustomActionButtonToComment(commentElement) {
        // ... (DEBUG 로그 및 상단 로직은 이전과 동일하게 유지 또는 필요에 따라 사용) ...
        console.log("DEBUG: addCustomActionButtonToComment CALLED for element:", commentElement);

        const actionMenuContainer = commentElement.querySelector('div#action-menu');
        if (!actionMenuContainer) {
            console.warn("DEBUG: Action menu container (div#action-menu) not found.");
            return;
        }

        // 이미 커스텀 메뉴 렌더러가 추가되었는지 확인하여 중복 추가 방지
        if (actionMenuContainer.querySelector(`.${CUSTOM_MENU_RENDERER_CLASS}`)) {
            // console.log("DEBUG: Custom menu renderer already exists. Skipping button addition.");
            return;
        }

        const existingMenuRenderer = actionMenuContainer.querySelector('ytd-menu-renderer');
        if (!existingMenuRenderer) {
            console.warn("DEBUG: Existing ytd-menu-renderer not found.");
            return;
        }

        // 기존 메뉴 렌더러를 복제하여 새로운 메뉴 렌더러 생성
        const newMenuRenderer = existingMenuRenderer.cloneNode(true); // true로 자식 노드까지 복제
        newMenuRenderer.classList.add(CUSTOM_MENU_RENDERER_CLASS); // 커스텀 클래스 추가

        // 복제된 새 메뉴 렌더러의 기존 자식들(아이템들)을 모두 제거 (새 버튼만 넣기 위함)
        while (newMenuRenderer.firstChild) {
            newMenuRenderer.removeChild(newMenuRenderer.firstChild);
        }

        // 기존 메뉴 렌더러 내의 버튼을 샘플로 사용 (스타일 복사 목적)
        const sampleExistingButton = existingMenuRenderer.querySelector('yt-icon-button#button.dropdown-trigger');
        // console.log("DEBUG: Sample existing button (dropdown-trigger):", sampleExistingButton);

        // 새로운 yt-icon-button 생성
        const newButton = document.createElement('yt-icon-button');
        if (sampleExistingButton) {
            newButton.className = sampleExistingButton.className; // 클래스 복사
            newButton.classList.remove('dropdown-trigger'); // 드롭다운 기능은 필요 없으므로 제거
            if (sampleExistingButton.hasAttribute('style-target')) { // style-target 속성이 있다면 복사
                newButton.setAttribute('style-target', sampleExistingButton.getAttribute('style-target'));
            }
        } else {
            // 샘플 버튼이 없는 경우 기본 클래스 추가 (방어 코드)
            newButton.classList.add('style-scope', 'ytd-menu-renderer');
        }
        newButton.classList.add(CUSTOM_ACTION_BUTTON_CLASS); // 커스텀 버튼 식별 클래스 추가

        // 버튼 내부의 <button> 요소 생성
        const buttonInner = document.createElement('button');
        const sampleInnerButton = sampleExistingButton ? sampleExistingButton.querySelector('button#button') : null;
        if (sampleInnerButton) {
            buttonInner.className = sampleInnerButton.className; // 내부 버튼 클래스 복사
        } else {
            buttonInner.classList.add('style-scope', 'yt-icon-button'); // 기본 클래스
        }
        buttonInner.id = 'button'; // YouTube 구조상 id가 'button'인 경우가 많음
        buttonInner.setAttribute('aria-label', '분석기 작업 (느낌표)'); // 접근성을 위한 레이블


        // --- yt-icon 생성 및 내부 구조를 appendChild로 직접 구성 ---
        const icon = document.createElement('yt-icon2'); // yt-icon 대신 yt-icon 사용 (YouTube 최신 구조)
        const sampleIcon = sampleExistingButton ? sampleExistingButton.querySelector('yt-icon') : null;
        if (sampleIcon) {
            icon.className = sampleIcon.className; // yt-icon의 클래스 복사
        } else {
            icon.classList.add('style-scope', 'ytd-menu-renderer'); // 기본 클래스
        }

        // 1. <span class="yt-icon-shape ..."> 생성
        const iconShapeSpan = document.createElement('span');
        const sampleIconShape = sampleIcon ? sampleIcon.querySelector('span.yt-icon-shape') : null;
        if (sampleIconShape) {
            iconShapeSpan.className = sampleIconShape.className;
        } else {
            // 기본 클래스 설정 (YouTube 구조 참조)
            iconShapeSpan.classList.add('yt-icon-shape', 'style-scope', 'yt-icon', 'yt-spec-icon-shape');
        }

        // 2. <div style="width: 100%; ..."> 생성 (SVG를 감싸는 div)
        const svgContainerDiv = document.createElement('div');
        svgContainerDiv.style.width = '100%';
        svgContainerDiv.style.height = '100%';
        svgContainerDiv.style.display = 'block';
        // svgContainerDiv.style.fill = 'currentColor'; // SVG 자체에 fill을 줄 것이므로 여기선 생략 가능

        // 3. <svg> 요소 생성
        const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgElement.setAttribute('height', '24px');
        svgElement.setAttribute('viewBox', '0 0 24 24');
        svgElement.setAttribute('width', '24px');
        svgElement.setAttribute('fill', 'gold'); // 노란색 느낌표
        svgElement.setAttribute('focusable', 'false');
        svgElement.setAttribute('aria-hidden', 'true');
        // SVG에 직접 스타일 적용 (기존 YouTube SVG 구조 참조)
        svgElement.style.pointerEvents = 'none';
        svgElement.style.display = 'inherit';
        svgElement.style.width = '100%';
        svgElement.style.height = '100%';


        // 4. <path> 요소들 생성 (배경 없음, 느낌표)
        const pathBg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathBg.setAttribute('d', 'M0 0h24v24H0V0z');
        pathBg.setAttribute('fill', 'none');

        const pathExclamation = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathExclamation.setAttribute('d', 'M11 15h2v2h-2zm0-8h2v6h-2z');
        // pathExclamation은 부모 svg의 fill="gold"를 상속받음

        // 5. 요소들을 계층적으로 appendChild
        svgElement.appendChild(pathBg);
        svgElement.appendChild(pathExclamation);
        svgContainerDiv.appendChild(svgElement);
        iconShapeSpan.appendChild(svgContainerDiv);
        icon.appendChild(iconShapeSpan); // 최종적으로 icon (yt-icon)에 iconShapeSpan을 추가

        // console.log("DEBUG: Constructed icon (yt-icon) with children. icon.innerHTML:", icon.innerHTML);
        // --- 아이콘 구성 완료 ---

        buttonInner.appendChild(icon); // 내부 버튼에 아이콘 추가
        newButton.appendChild(buttonInner); // yt-icon-button에 내부 버튼 추가

        // yt-interaction 요소 (클릭 시 물결 효과) 추가
        const sampleInteraction = sampleExistingButton ? sampleExistingButton.querySelector('yt-interaction#interaction') : null;
        if (sampleInteraction) {
            const interaction = sampleInteraction.cloneNode(true);
            newButton.appendChild(interaction);
        } else {
            // 샘플이 없을 경우 기본 yt-interaction 생성 (방어 코드)
            const interaction = document.createElement('yt-interaction');
            interaction.id = 'interaction';
            interaction.classList.add('circular', 'style-scope', 'yt-icon-button');
            // yt-interaction의 내부 구조는 복잡하므로, 간단히 innerHTML로 설정하거나,
            // 더 정확하게는 YouTube의 실제 구조를 참조하여 생성해야 함.
            // 여기서는 간단히 비워두거나, 기본 구조를 넣을 수 있음.
            // 예: interaction.innerHTML = `<div class="stroke style-scope yt-interaction"></div><div class="fill style-scope yt-interaction"></div>`;
            newButton.appendChild(interaction);
        }


        // 새 버튼에 클릭 이벤트 리스너 추가
        newButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            event.preventDefault();

            const commentText = commentElement.querySelector(CONTENT_WRAPPER_SELECTOR)?.textContent?.trim();

            const wordToReport = prompt("신고할 단어를 입력하세요:");
            if (!wordToReport) return;

            const reason = prompt("신고 사유를 입력하세요:");
            if (!reason) return;


            try {
                const response = await fetch(SERVER_REPORT_WORD_URL, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        word: wordToReport,
                        reason: reason,
                        context: commentText // optional: 댓글 원문도 같이 보내기
                    })
                });

                if (response.ok) {
                    const result = await response.json();
                    alert("신고가 접수되었습니다!");
                } else {
                    alert("서버 응답 오류!");
                }
            } catch (err) {
                console.error("Fetch error:", err);
                alert("서버에 연결할 수 없습니다.");
            }
        });

        // 완성된 새 버튼을 새 메뉴 렌더러에 추가
        newMenuRenderer.appendChild(newButton);

        // 기존 메뉴 렌더러 뒤에 새로운 메뉴 렌더러를 삽입
        existingMenuRenderer.insertAdjacentElement('afterend', newMenuRenderer);
        // console.log("DEBUG: --- addCustomActionButtonToComment FINISHED ---");
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initializeAndStartObserver, 500);
        });
    } else {
        setTimeout(initializeAndStartObserver, 500);
    }
}