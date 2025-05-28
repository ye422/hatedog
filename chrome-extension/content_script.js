// content_script.js

// 1. 중복 로딩 방지 플래그
if (window.ytCommentsAnalyzerInitialized) {
    console.log("YouTube 댓글 분석기: 이미 초기화됨. 추가 실행을 방지합니다.");
} else {
    window.ytCommentsAnalyzerInitialized = true;
    console.log("YouTube 댓글 분석기: content_script.js 로드 및 초기화 시작.");


    const SERVER_URL = "your_server_url"; // 실제 서버 URL로 변경 필요
    const SERVER_ANALYZE_URL = SERVER_URL + "/analyze";
    const SERVER_REPORT_WORD_URL = SERVER_URL + "/report_word";
    const COMMENTS_SECTION_SELECTOR = "ytd-comments#comments"; // 댓글 섹션 전체
    const COMMENT_WRAPPER_SELECTOR = "ytd-comment-thread-renderer, ytd-comment-view-model[is-reply]";
    const CONTENT_WRAPPER_SELECTOR = "#content-text";
    const TEXT_SPAN_SELECTOR = "span.yt-core-attributed-string"; // 실제 텍스트가 표시되는 span

    // currentCommentsData: key: contentId, value: { originalTextSnapshot, processed, sending, uiState, classification, userOverridden }
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
    const CHECKING_TEXT = "댓글을 확인하고 있어요...🦮";
    const CENSORED_TEXT = "나쁜 말은 물어갔어요! 🐕";
    const CLASS_CHECKING = "yt-comment-analyzer-checking";
    const CLASS_FILTERED_HATE = "yt-comment-analyzer-filtered-hate";
    const CLASS_PROCESSED_NORMAL = "yt-comment-analyzer-processed-normal";
    const VISUAL_INDICATOR_CLASS = "yt-comment-analyzer-indicator";
    const HIDDEN_ORIGINAL_SPAN_CLASS = "yt-analyzer-hidden-original-text";
    const VIEW_ORIGINAL_BUTTON_CLASS = "yt-analyzer-view-original-button"; // NEW CLASS

    // 느낌표 추가
    // --- 상태 및 UI 관련 클래스 (버튼 관련) ---
    const CUSTOM_ACTION_BUTTON_CLASS = 'yt-analyzer-custom-action-button';
    const CUSTOM_MENU_RENDERER_CLASS = 'yt-analyzer-custom-menu-renderer';

    const DEBOUNCE_DELAY = 100;

    function getVideoId() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('v') || 'unknown_video_id';
    }

    // Simplified getCommentId - relies on originalTextForId being passed if known,
    // otherwise tries to derive it.
    function generateCommentId(originalText) {
        if (!originalText) return null;
        const shortText = originalText.slice(0, 30).replace(/\s+/g, "");
        return `pseudo--${getVideoId()}--${shortText}`;
    }


    function getOriginalTextFromElement(el) {
        if (el.dataset.originalContentAnalyzer) {
            return el.dataset.originalContentAnalyzer;
        }
        const hiddenSpan = el.querySelector(`.${HIDDEN_ORIGINAL_SPAN_CLASS}`);
        if (hiddenSpan && hiddenSpan.textContent) {
            return hiddenSpan.textContent.trim();
        }
        const contentWrapper = el.querySelector(CONTENT_WRAPPER_SELECTOR);
        const currentVisibleText = contentWrapper?.textContent?.trim();
        if (currentVisibleText && currentVisibleText !== CHECKING_TEXT && currentVisibleText !== CENSORED_TEXT) {
            return currentVisibleText;
        }
        return null;
    }


    function setElementUIToChecking(element, originalTextContent) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            // Store original content if not already stored or if different
            if (!element.dataset.originalContentAnalyzer || element.dataset.originalContentAnalyzer !== originalTextContent) {
                element.dataset.originalContentAnalyzer = originalTextContent;
            }
            textElement.innerHTML = `${CHECKING_TEXT}<span class="${HIDDEN_ORIGINAL_SPAN_CLASS}" style="display: none;">${originalTextContent}</span>`;
        }
        element.classList.add(CLASS_CHECKING);
        element.classList.remove(CLASS_PROCESSED_NORMAL, CLASS_FILTERED_HATE);
        element.dataset.analyzerState = 'checking';

        // Remove view original button if present
        const viewButton = textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`);
        if (viewButton) viewButton.remove();
    }

    function restoreElementUIToNormal(element, fromUserAction = false) {
        const originalTextContent = element.dataset.originalContentAnalyzer || "";
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            textElement.textContent = originalTextContent; // Just restore text, no hidden span needed here
        }
        element.classList.remove(CLASS_CHECKING, CLASS_FILTERED_HATE);
        element.classList.add(CLASS_PROCESSED_NORMAL);
        element.dataset.analyzerState = 'processed_normal';

        const indicator = element.querySelector(`.${VISUAL_INDICATOR_CLASS}`);
        if (indicator) indicator.remove();

        // Remove view original button if present
        const viewButton = textElement && textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`);
        if (viewButton) viewButton.remove();

        if (fromUserAction) {
            const originalTextForId = getOriginalTextFromElement(element);
            const contentId = generateCommentId(originalTextForId);
            if (contentId && currentCommentsData[contentId]) {
                currentCommentsData[contentId].userOverridden = true;
                currentCommentsData[contentId].uiState = 'user_restored';
                console.log(`YouTube 댓글 분석기: 사용자가 복원 (ID: ${contentId.slice(0, 50)})`);
            }
        }
    }

    function setElementUIToCensored(element) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        const originalTextForId = getOriginalTextFromElement(element); // Get original text for ID
        const contentId = generateCommentId(originalTextForId);

        if (textElement) {
            // Ensure original text is in dataset if not already
            if (!element.dataset.originalContentAnalyzer && originalTextForId) {
                element.dataset.originalContentAnalyzer = originalTextForId;
            }

            textElement.textContent = CENSORED_TEXT + " "; // Add space for the button

            // Add "보기" button if it doesn't exist
            if (!textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`)) {
                const viewButton = document.createElement('span');
                viewButton.textContent = "[보기]";
                viewButton.className = VIEW_ORIGINAL_BUTTON_CLASS;
                viewButton.style.cursor = "pointer";
                viewButton.style.marginLeft = "5px";
                viewButton.style.textDecoration = "underline";
                viewButton.style.color = "var(--yt-spec-text-secondary)"; // Use YouTube's secondary text color

                viewButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    console.log("YouTube 댓글 분석기: '보기' 버튼 클릭됨", element);
                    restoreElementUIToNormal(element, true); // Pass true for userAction
                    // The button is removed by restoreElementUIToNormal
                });
                textElement.appendChild(viewButton);
            }
        }
        element.classList.remove(CLASS_CHECKING, CLASS_PROCESSED_NORMAL);
        element.classList.add(CLASS_FILTERED_HATE);
        element.dataset.analyzerState = 'processed_hate';

        if (contentId && currentCommentsData[contentId]) {
            currentCommentsData[contentId].userOverridden = false; // Explicitly set to false when censored
        }
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
                    // Update currentCommentsData first
                    if (currentCommentsData[result.id]) {
                        currentCommentsData[result.id].processed = true;
                        currentCommentsData[result.id].sending = false;
                        currentCommentsData[result.id].classification = result.classification;
                        currentCommentsData[result.id].uiState = 'processed';
                        // userOverridden is handled by UI functions
                    }
                    applyCensorshipToMatchingElements(result.id, result.classification, result.reason);
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

    async function scrapeAndProcessComments() {
        if (isScraping) {
            // console.log("YouTube 댓글 분석기: 이미 스크래핑 진행 중. 이번 호출 건너뜀.");
            return;
        }
        isScraping = true;
        // console.log("YouTube 댓글 분석기: 🔍 댓글 스캔 시작...");

        try {
            const commentElements = document.querySelectorAll(COMMENT_WRAPPER_SELECTOR);
            let newTasksAddedToQueue = 0;

            commentElements.forEach(el => {
                const currentAnalyzerState = el.dataset.analyzerState;
                const originalTextForThisComment = getOriginalTextFromElement(el);

                if (!originalTextForThisComment) {
                    // console.warn("YouTube 댓글 분석기: 스캔 중 유효한 원본 텍스트 확보 불가", el);
                    return;
                }

                const contentId = generateCommentId(originalTextForThisComment);
                if (!contentId) {
                    // console.warn("YouTube 댓글 분석기: Comment ID 생성 실패", originalTextForThisComment.slice(0,30));
                    return;
                }

                // Ensure original text is stored in dataset for future reference by UI functions
                if (!el.dataset.originalContentAnalyzer) {
                    el.dataset.originalContentAnalyzer = originalTextForThisComment;
                }


                const commentDataEntry = currentCommentsData[contentId];

                if (commentDataEntry) {
                    if (commentDataEntry.userOverridden) {
                        // If user manually reverted, ensure UI is normal and skip further processing for this element
                        if (currentAnalyzerState !== 'processed_normal') {
                            // console.log(`YouTube 댓글 분석기: 사용자 복원 상태 유지 (ID: ${contentId.slice(0, 50)})`);
                            restoreElementUIToNormal(el); // Don't pass fromUserAction here
                        }
                        addCustomActionButtonToComment(el); // Ensure button is present
                        return; // Skip further processing for this element
                    }

                    if (commentDataEntry.processed) {
                        // Apply stored classification if UI doesn't match
                        if (commentDataEntry.classification === "혐오" && currentAnalyzerState !== 'processed_hate') {
                            // console.log(`YouTube 댓글 분석기: 저장된 '혐오' 분석 결과 적용 (ID: ${contentId.slice(0, 50)})`);
                            setElementUIToCensored(el);
                        } else if (commentDataEntry.classification === "정상" && currentAnalyzerState !== 'processed_normal') {
                            // console.log(`YouTube 댓글 분석기: 저장된 '정상' 분석 결과 적용 (ID: ${contentId.slice(0, 50)})`);
                            restoreElementUIToNormal(el);
                        }
                    } else if (commentDataEntry.sending) {
                        if (currentAnalyzerState !== 'checking') {
                            setElementUIToChecking(el, commentDataEntry.originalTextSnapshot);
                        }
                    } else { // Not processed, not sending (e.g., error or initial state for a known ID)
                        // console.log(`YouTube 댓글 분석기: 미처리/미전송 댓글 재요청 준비 (ID: ${contentId.slice(0, 50)})`);
                        setElementUIToChecking(el, commentDataEntry.originalTextSnapshot);
                        currentCommentsData[contentId].sending = true;
                        currentCommentsData[contentId].uiState = 'checking';
                        requestQueue.push({ id: contentId, text: commentDataEntry.originalTextSnapshot, videoId: getVideoId() });
                        newTasksAddedToQueue++;
                    }
                } else { // New comment
                    // console.log(`YouTube 댓글 분석기: 새 댓글 발견, 처리 대기열 추가 (ID: ${contentId.slice(0, 50)}) Text: "${originalTextForThisComment.slice(0, 30)}"`);
                    setElementUIToChecking(el, originalTextForThisComment);
                    currentCommentsData[contentId] = {
                        originalTextSnapshot: originalTextForThisComment,
                        processed: false,
                        sending: true,
                        uiState: 'checking',
                        classification: null,
                        userOverridden: false // Initialize new flag
                    };
                    requestQueue.push({ id: contentId, text: originalTextForThisComment, videoId: getVideoId() });
                    newTasksAddedToQueue++;
                }
                addCustomActionButtonToComment(el);
            });

            if (newTasksAddedToQueue > 0) {
                if (!queueFillStartTime && !queueProcessingFinished) {
                    queueFillStartTime = performance.now();
                    // console.log(`YouTube 댓글 분석기: ⏱️ 큐 채워지고 처리 시작 시간 기록됨 (${newTasksAddedToQueue}개 작업).`);
                }
                // console.log(`YouTube 댓글 분석기: ${newTasksAddedToQueue}개의 새 작업이 큐에 추가됨. 큐 처리 시작.`);
                processRequestQueue();
            }
        } catch (error) {
            console.error("YouTube 댓글 분석기: scrapeAndProcessComments 중 오류 발생", error);
        } finally {
            isScraping = false;
        }
    }


    function applyCensorshipToMatchingElements(targetContentId, classification, reason) {
        // console.log(`YouTube 댓글 분석기: 📝 서버 결과 DOM 반영 시도 (ID: ${targetContentId.slice(0, 50)}, Class: ${classification})`);
        let updatedCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            // We need to get the ID based on its stored original text
            const originalTextForThisElement = getOriginalTextFromElement(el);
            const elContentId = generateCommentId(originalTextForThisElement);

            if (elContentId === targetContentId) {
                const commentData = currentCommentsData[targetContentId];
                if (commentData && commentData.userOverridden) {
                    // console.log(`YouTube 댓글 분석기: 사용자 복원 상태이므로 서버 결과(${classification}) 무시 (ID: ${targetContentId.slice(0,50)})`);
                    // Ensure UI is normal if it somehow got changed
                    if (el.dataset.analyzerState !== 'processed_normal') {
                        restoreElementUIToNormal(el);
                    }
                    return; // Skip applying server result
                }

                // Only update if currently in 'checking' state or if classification changed
                if (el.dataset.analyzerState === 'checking' || (commentData && commentData.classification !== classification)) {
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
        // if (updatedCount > 0) {
        //     console.log(`YouTube 댓글 분석기: ${updatedCount}개 요소 UI 업데이트 완료 (ID: ${targetContentId.slice(0, 50)})`);
        // }
    }

    function restoreAllMatchingElementsToNormalOnError(targetContentId) {
        console.warn(`YouTube 댓글 분석기: 오류 발생, ID ${targetContentId.slice(0, 50)} 관련 댓글 원상 복구 시도.`);
        let restoredCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            const originalTextForThisElement = getOriginalTextFromElement(el);
            const elContentId = generateCommentId(originalTextForThisElement);

            if (elContentId === targetContentId) {
                // Only restore if it was in a 'checking' state, to avoid overriding user actions or already processed states
                if (el.dataset.analyzerState === 'checking') {
                    restoreElementUIToNormal(el);
                    el.dataset.analyzerState = 'error_restored'; // Keep a distinct state for debugging
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
            // Also check for text content changes within existing comments,
            // though this is less common for YouTube comments after initial load.
            // However, edits could trigger this.
            if (mutation.type === "characterData" && mutation.target.parentElement.closest(COMMENT_WRAPPER_SELECTOR)) {
                // Check if the parent comment wrapper is not already being processed or in a final state
                const commentWrapper = mutation.target.parentElement.closest(COMMENT_WRAPPER_SELECTOR);
                if (commentWrapper && (!commentWrapper.dataset.analyzerState || commentWrapper.dataset.analyzerState === 'error_restored')) {
                    // console.log("YouTube 댓글 분석기: 📝 기존 댓글 내용 변경 감지. 재스캔 고려.");
                    // This could be an edit. We might want to re-evaluate.
                    // For now, let's treat it like a new change.
                    newRelevantChanges = true;
                }
            }
            if (newRelevantChanges) break;
        }

        if (newRelevantChanges) {
            // console.log("YouTube 댓글 분석기: ➕ 새로운 댓글/내용 변경 관련 노드 추가 감지. 디바운스 타이머 설정.");
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                scrapeAndProcessComments();
            }, DEBOUNCE_DELAY);
        }
    }

    function initializeAndStartObserver() {
        const commentsSectionElement = document.querySelector(COMMENTS_SECTION_SELECTOR);

        if (!commentsSectionElement) {
            // console.log("YouTube 댓글 분석기: 댓글 섹션(", COMMENTS_SECTION_SELECTOR, ")을 아직 찾을 수 없음. 0.5초 후 재시도.");
            setTimeout(initializeAndStartObserver, 500);
            return;
        }

        console.log("YouTube 댓글 분석기: ✅ 댓글 섹션 발견. 초기 댓글 스캔 및 MutationObserver 시작.");
        scrapeAndProcessComments(); // 초기 스캔

        if (commentObserver) commentObserver.disconnect();
        commentObserver = new MutationObserver(handleCommentMutations);
        commentObserver.observe(commentsSectionElement, { childList: true, subtree: true, characterData: true }); // Added characterData

        window.addEventListener('unload', () => {
            if (commentObserver) commentObserver.disconnect();
            clearTimeout(debounceTimer);
        });
    }

    function addCustomActionButtonToComment(commentElement) {
        // console.log("DEBUG: addCustomActionButtonToComment CALLED for element:", commentElement);

        const actionMenuContainer = commentElement.querySelector('div#action-menu');
        if (!actionMenuContainer) {
            // console.warn("DEBUG: Action menu container (div#action-menu) not found.");
            return;
        }

        if (actionMenuContainer.querySelector(`.${CUSTOM_MENU_RENDERER_CLASS}`)) {
            return;
        }

        const existingMenuRenderer = actionMenuContainer.querySelector('ytd-menu-renderer');
        if (!existingMenuRenderer) {
            // console.warn("DEBUG: Existing ytd-menu-renderer not found.");
            return;
        }

        const newMenuRenderer = existingMenuRenderer.cloneNode(true);
        newMenuRenderer.classList.add(CUSTOM_MENU_RENDERER_CLASS);

        while (newMenuRenderer.firstChild) {
            newMenuRenderer.removeChild(newMenuRenderer.firstChild);
        }

        const sampleExistingButton = existingMenuRenderer.querySelector('yt-icon-button#button.dropdown-trigger');

        const newButton = document.createElement('yt-icon-button');
        if (sampleExistingButton) {
            newButton.className = sampleExistingButton.className;
            newButton.classList.remove('dropdown-trigger');
            if (sampleExistingButton.hasAttribute('style-target')) {
                newButton.setAttribute('style-target', sampleExistingButton.getAttribute('style-target'));
            }
        } else {
            newButton.classList.add('style-scope', 'ytd-menu-renderer');
        }
        newButton.classList.add(CUSTOM_ACTION_BUTTON_CLASS);

        const buttonInner = document.createElement('button');
        const sampleInnerButton = sampleExistingButton ? sampleExistingButton.querySelector('button#button') : null;
        if (sampleInnerButton) {
            buttonInner.className = sampleInnerButton.className;
        } else {
            buttonInner.classList.add('style-scope', 'yt-icon-button');
        }
        buttonInner.id = 'button';
        buttonInner.setAttribute('aria-label', '분석기 작업 (단어 신고)');


        const icon = document.createElement('yt-icon2'); // Changed to yt-icon from yt-icon2
        const sampleIcon = sampleExistingButton ? sampleExistingButton.querySelector('yt-icon') : null;
        if (sampleIcon) {
            icon.className = sampleIcon.className;
        } else {
            icon.classList.add('style-scope', 'ytd-menu-renderer');
        }

        const iconShapeSpan = document.createElement('span');
        const sampleIconShape = sampleIcon ? sampleIcon.querySelector('span.yt-icon-shape') : null;
        if (sampleIconShape) {
            iconShapeSpan.className = sampleIconShape.className;
        } else {
            iconShapeSpan.classList.add('yt-icon-shape', 'style-scope', 'yt-icon', 'yt-spec-icon-shape');
        }

        const svgContainerDiv = document.createElement('div');
        svgContainerDiv.style.width = '100%';
        svgContainerDiv.style.height = '100%';
        svgContainerDiv.style.display = 'block';

        const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svgElement.setAttribute('height', '24px');
        svgElement.setAttribute('viewBox', '0 0 24 24');
        svgElement.setAttribute('width', '24px');
        svgElement.setAttribute('fill', 'gold');
        svgElement.setAttribute('focusable', 'false');
        svgElement.setAttribute('aria-hidden', 'true');
        svgElement.style.pointerEvents = 'none';
        svgElement.style.display = 'inherit';
        svgElement.style.width = '100%';
        svgElement.style.height = '100%';

        const pathBg = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathBg.setAttribute('d', 'M0 0h24v24H0V0z');
        pathBg.setAttribute('fill', 'none');

        const pathExclamation = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathExclamation.setAttribute('d', 'M11 15h2v2h-2zm0-8h2v6h-2z');

        svgElement.appendChild(pathBg);
        svgElement.appendChild(pathExclamation);
        svgContainerDiv.appendChild(svgElement);
        iconShapeSpan.appendChild(svgContainerDiv);
        icon.appendChild(iconShapeSpan);

        buttonInner.appendChild(icon);
        newButton.appendChild(buttonInner);

        const sampleInteraction = sampleExistingButton ? sampleExistingButton.querySelector('yt-interaction#interaction') : null;
        if (sampleInteraction) {
            const interaction = sampleInteraction.cloneNode(true);
            newButton.appendChild(interaction);
        } else {
            const interaction = document.createElement('yt-interaction');
            interaction.id = 'interaction';
            interaction.classList.add('circular', 'style-scope', 'yt-icon-button');
            newButton.appendChild(interaction);
        }

        newButton.addEventListener('click', async (event) => {
            event.stopPropagation();
            event.preventDefault();

            const originalCommentText = getOriginalTextFromElement(commentElement) ||
                commentElement.querySelector(CONTENT_WRAPPER_SELECTOR)?.textContent?.trim();


            const wordToReport = prompt("신고할 단어를 입력하세요 (댓글 내용: " + originalCommentText.slice(0, 50) + "...):");
            if (!wordToReport) return;

            const reason = prompt("신고 사유를 입력하세요:");
            if (!reason) return;

            try {
                const response = await fetch(SERVER_REPORT_WORD_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        word: wordToReport,
                        reason: reason,
                        context: originalCommentText
                    })
                });

                if (response.ok) {
                    await response.json(); // result not used for now
                    alert("신고가 접수되었습니다!");
                } else {
                    const errorData = await response.text();
                    alert(`서버 응답 오류: ${response.status} ${errorData}`);
                }
            } catch (err) {
                console.error("Fetch error:", err);
                alert("서버에 연결할 수 없습니다.");
            }
        });

        newMenuRenderer.appendChild(newButton);
        existingMenuRenderer.insertAdjacentElement('afterend', newMenuRenderer);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(initializeAndStartObserver, 500);
        });
    } else {
        setTimeout(initializeAndStartObserver, 500);
    }
}