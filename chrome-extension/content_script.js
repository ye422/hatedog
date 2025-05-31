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
    // START OF MODIFIED SECTION: New class for user viewing hate comment
    const CLASS_PROCESSED_HATE_USER_VIEWING = "yt-comment-analyzer-processed-hate-user-viewing"; // NEW CLASS
    // END OF MODIFIED SECTION
    const VISUAL_INDICATOR_CLASS = "yt-comment-analyzer-indicator";
    const HIDDEN_ORIGINAL_SPAN_CLASS = "yt-analyzer-hidden-original-text";
    const VIEW_ORIGINAL_BUTTON_CLASS = "yt-analyzer-view-original-button";
    // START OF MODIFIED SECTION: New class for hide again button
    const HIDE_AGAIN_BUTTON_CLASS = "yt-analyzer-hide-again-button"; // NEW CLASS
    // END OF MODIFIED SECTION

    // 느낌표 추가
    // --- 상태 및 UI 관련 클래스 (버튼 관련) ---
    const CUSTOM_ACTION_BUTTON_CLASS = 'yt-analyzer-custom-action-button';
    const CUSTOM_MENU_RENDERER_CLASS = 'yt-analyzer-custom-menu-renderer';

    const DEBOUNCE_DELAY = 100;

    function getVideoId() {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('v') || 'unknown_video_id';
    }

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
        // START OF MODIFIED SECTION: Adjust condition to not mistake user-viewing state for original text
        if (currentVisibleText && currentVisibleText !== CHECKING_TEXT && currentVisibleText !== CENSORED_TEXT && !el.querySelector(`.${HIDE_AGAIN_BUTTON_CLASS}`)) {
            // END OF MODIFIED SECTION
            return currentVisibleText;
        }
        return null;
    }


    function setElementUIToChecking(element, originalTextContent) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            if (!element.dataset.originalContentAnalyzer || element.dataset.originalContentAnalyzer !== originalTextContent) {
                element.dataset.originalContentAnalyzer = originalTextContent;
            }
            textElement.innerHTML = `${CHECKING_TEXT}<span class="${HIDDEN_ORIGINAL_SPAN_CLASS}" style="display: none;">${originalTextContent}</span>`;
        }
        element.classList.add(CLASS_CHECKING);
        // START OF MODIFIED SECTION: Remove new class as well
        element.classList.remove(CLASS_PROCESSED_NORMAL, CLASS_FILTERED_HATE, CLASS_PROCESSED_HATE_USER_VIEWING);
        // END OF MODIFIED SECTION
        element.dataset.analyzerState = 'checking';

        const viewButton = textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`);
        if (viewButton) viewButton.remove();
        // START OF MODIFIED SECTION: Remove hide again button if present
        const hideButton = textElement.querySelector(`.${HIDE_AGAIN_BUTTON_CLASS}`);
        if (hideButton) hideButton.remove();
        // END OF MODIFIED SECTION
    }

    function restoreElementUIToNormal(element, fromUserAction = false) {
        const originalTextContent = element.dataset.originalContentAnalyzer || "";
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        if (textElement) {
            textElement.textContent = originalTextContent;
        }
        // START OF MODIFIED SECTION: Remove new class as well
        element.classList.remove(CLASS_CHECKING, CLASS_FILTERED_HATE, CLASS_PROCESSED_HATE_USER_VIEWING);
        // END OF MODIFIED SECTION
        element.classList.add(CLASS_PROCESSED_NORMAL);
        element.dataset.analyzerState = 'processed_normal';

        const indicator = element.querySelector(`.${VISUAL_INDICATOR_CLASS}`);
        if (indicator) indicator.remove();

        const viewButton = textElement && textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`);
        if (viewButton) viewButton.remove();
        // START OF MODIFIED SECTION: Remove hide again button if present
        const hideButton = textElement && textElement.querySelector(`.${HIDE_AGAIN_BUTTON_CLASS}`);
        if (hideButton) hideButton.remove();
        // END OF MODIFIED SECTION


        if (fromUserAction) {
            const originalTextForId = getOriginalTextFromElement(element) || element.dataset.originalContentAnalyzer; // Ensure we get original text
            const contentId = generateCommentId(originalTextForId);
            if (contentId && currentCommentsData[contentId]) {
                currentCommentsData[contentId].userOverridden = true;
                // START OF MODIFIED SECTION: If user restores, it means they consider it normal
                currentCommentsData[contentId].classification = '정상'; // Explicitly mark as normal by user
                // END OF MODIFIED SECTION
                currentCommentsData[contentId].uiState = 'user_restored_to_normal';
                console.log(`YouTube 댓글 분석기: 사용자가 정상으로 복원 (ID: ${contentId.slice(0, 50)})`);
            }
        }
    }

    // START OF MODIFIED SECTION: New function to show original hate comment with a "Hide Again" button
    function showOriginalHateCommentWithHideButton(element) {
        const originalTextContent = element.dataset.originalContentAnalyzer || "";
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        const contentId = generateCommentId(originalTextContent);

        if (textElement) {
            textElement.textContent = originalTextContent + " "; // Restore original text, add space for button

            // Remove "View Original" button if present
            const viewButton = textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`);
            if (viewButton) viewButton.remove();

            // Add "Hide Again" button if it doesn't exist
            if (!textElement.querySelector(`.${HIDE_AGAIN_BUTTON_CLASS}`)) {
                const hideButton = document.createElement('span');
                hideButton.textContent = "[다시 가리기]";
                hideButton.className = HIDE_AGAIN_BUTTON_CLASS;
                hideButton.style.cursor = "pointer";
                hideButton.style.marginLeft = "5px";
                hideButton.style.textDecoration = "underline";
                hideButton.style.color = "var(--yt-spec-text-secondary)";

                hideButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    console.log("YouTube 댓글 분석기: '다시 가리기' 버튼 클릭됨", element);
                    if (contentId && currentCommentsData[contentId]) {
                        currentCommentsData[contentId].userOverridden = false; // System will censor it again
                        currentCommentsData[contentId].uiState = 'processed_hate'; // Back to system-censored state
                    }
                    setElementUIToCensored(element); // This will remove the hideButton and add viewButton
                });
                textElement.appendChild(hideButton);
            }
        }
        element.classList.remove(CLASS_CHECKING, CLASS_PROCESSED_NORMAL, CLASS_FILTERED_HATE);
        element.classList.add(CLASS_PROCESSED_HATE_USER_VIEWING);
        element.dataset.analyzerState = 'processed_hate_user_viewing';

        if (contentId && currentCommentsData[contentId]) {
            // userOverridden is already true when this function is called via "View Original"
            // No need to set classification here, it remains '혐오'
        }
    }
    // END OF MODIFIED SECTION

    function setElementUIToCensored(element) {
        const textElement = element.querySelector(CONTENT_WRAPPER_SELECTOR) || element.querySelector(TEXT_SPAN_SELECTOR);
        const originalTextForId = getOriginalTextFromElement(element) || element.dataset.originalContentAnalyzer;
        const contentId = generateCommentId(originalTextForId);

        if (textElement) {
            if (!element.dataset.originalContentAnalyzer && originalTextForId) {
                element.dataset.originalContentAnalyzer = originalTextForId;
            }
            textElement.textContent = CENSORED_TEXT + " ";

            // Remove "Hide Again" button if present
            const hideButton = textElement.querySelector(`.${HIDE_AGAIN_BUTTON_CLASS}`);
            if (hideButton) hideButton.remove();

            if (!textElement.querySelector(`.${VIEW_ORIGINAL_BUTTON_CLASS}`)) {
                const viewButton = document.createElement('span');
                viewButton.textContent = "[보기]";
                viewButton.className = VIEW_ORIGINAL_BUTTON_CLASS;
                viewButton.style.cursor = "pointer";
                viewButton.style.marginLeft = "5px";
                viewButton.style.textDecoration = "underline";
                viewButton.style.color = "var(--yt-spec-text-secondary)";

                viewButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    console.log("YouTube 댓글 분석기: '보기' 버튼 클릭됨", element);
                    // START OF MODIFIED SECTION: Call new function and update state
                    if (contentId && currentCommentsData[contentId]) {
                        currentCommentsData[contentId].userOverridden = true;
                        currentCommentsData[contentId].uiState = 'user_viewing_hate';
                        // classification remains '혐오'
                    }
                    showOriginalHateCommentWithHideButton(element);
                    // END OF MODIFIED SECTION
                });
                textElement.appendChild(viewButton);
            }
        }
        // START OF MODIFIED SECTION: Remove new class as well
        element.classList.remove(CLASS_CHECKING, CLASS_PROCESSED_NORMAL, CLASS_PROCESSED_HATE_USER_VIEWING);
        // END OF MODIFIED SECTION
        element.classList.add(CLASS_FILTERED_HATE);
        element.dataset.analyzerState = 'processed_hate';

        if (contentId && currentCommentsData[contentId]) {
            // If setElementUIToCensored is called (e.g. by "Hide Again" or server),
            // userOverridden should be false unless it's the initial server censorship.
            // The click handlers for "Hide Again" and "View Original" manage userOverridden.
            // If called by server, userOverridden is false by default.
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
                    if (currentCommentsData[result.id]) {
                        currentCommentsData[result.id].processed = true;
                        currentCommentsData[result.id].sending = false;
                        currentCommentsData[result.id].classification = result.classification;
                        // uiState will be set by applyCensorship or if user has overridden
                        // If user has overridden, their choice takes precedence.
                        if (!currentCommentsData[result.id].userOverridden) {
                            currentCommentsData[result.id].uiState = result.classification === '혐오' ? 'processed_hate' : 'processed_normal';
                        }
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
            return;
        }
        isScraping = true;

        try {
            const commentElements = document.querySelectorAll(COMMENT_WRAPPER_SELECTOR);
            let newTasksAddedToQueue = 0;

            commentElements.forEach(el => {
                const currentAnalyzerState = el.dataset.analyzerState;
                const originalTextForThisComment = getOriginalTextFromElement(el) || el.dataset.originalContentAnalyzer;

                if (!originalTextForThisComment) {
                    return;
                }

                const contentId = generateCommentId(originalTextForThisComment);
                if (!contentId) {
                    return;
                }

                if (!el.dataset.originalContentAnalyzer) {
                    el.dataset.originalContentAnalyzer = originalTextForThisComment;
                }

                const commentDataEntry = currentCommentsData[contentId];

                if (commentDataEntry) {
                    if (commentDataEntry.userOverridden) {
                        // START OF MODIFIED SECTION: Handle user override for hate comments (show with "Hide Again")
                        if (commentDataEntry.classification === '혐오') {
                            if (currentAnalyzerState !== 'processed_hate_user_viewing') {
                                showOriginalHateCommentWithHideButton(el);
                            }
                        } else { // User considered it normal
                            if (currentAnalyzerState !== 'processed_normal') {
                                restoreElementUIToNormal(el); // Don't pass fromUserAction
                            }
                        }
                        // END OF MODIFIED SECTION
                        addCustomActionButtonToComment(el);
                        return;
                    }

                    if (commentDataEntry.processed) {
                        if (commentDataEntry.classification === "혐오" && currentAnalyzerState !== 'processed_hate') {
                            setElementUIToCensored(el);
                        } else if (commentDataEntry.classification === "정상" && currentAnalyzerState !== 'processed_normal') {
                            restoreElementUIToNormal(el);
                        }
                    } else if (commentDataEntry.sending) {
                        if (currentAnalyzerState !== 'checking') {
                            setElementUIToChecking(el, commentDataEntry.originalTextSnapshot);
                        }
                    } else {
                        setElementUIToChecking(el, commentDataEntry.originalTextSnapshot);
                        currentCommentsData[contentId].sending = true;
                        currentCommentsData[contentId].uiState = 'checking';
                        requestQueue.push({ id: contentId, text: commentDataEntry.originalTextSnapshot, videoId: getVideoId() });
                        newTasksAddedToQueue++;
                    }
                } else {
                    setElementUIToChecking(el, originalTextForThisComment);
                    currentCommentsData[contentId] = {
                        originalTextSnapshot: originalTextForThisComment,
                        processed: false,
                        sending: true,
                        uiState: 'checking',
                        classification: null,
                        userOverridden: false
                    };
                    requestQueue.push({ id: contentId, text: originalTextForThisComment, videoId: getVideoId() });
                    newTasksAddedToQueue++;
                }
                addCustomActionButtonToComment(el);
            });

            if (newTasksAddedToQueue > 0) {
                if (!queueFillStartTime && !queueProcessingFinished) {
                    queueFillStartTime = performance.now();
                }
                processRequestQueue();
            }
        } catch (error) {
            console.error("YouTube 댓글 분석기: scrapeAndProcessComments 중 오류 발생", error);
        } finally {
            isScraping = false;
        }
    }


    function applyCensorshipToMatchingElements(targetContentId, classification, reason) {
        let updatedCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            const originalTextForThisElement = getOriginalTextFromElement(el) || el.dataset.originalContentAnalyzer;
            const elContentId = generateCommentId(originalTextForThisElement);

            if (elContentId === targetContentId) {
                const commentData = currentCommentsData[targetContentId];
                if (commentData && commentData.userOverridden) {
                    // START OF MODIFIED SECTION: If user is viewing a hate comment, server result shouldn't change it back to censored
                    if (commentData.classification === '혐오' && el.dataset.analyzerState === 'processed_hate_user_viewing') {
                        // console.log(`YouTube 댓글 분석기: 사용자 원본 보기 상태 유지 (ID: ${targetContentId.slice(0,50)})`);
                        return; // Keep user's choice to view original
                    }
                    // If user marked as normal, restoreElementUIToNormal would have handled it.
                    // console.log(`YouTube 댓글 분석기: 사용자 복원 상태이므로 서버 결과(${classification}) 무시 (ID: ${targetContentId.slice(0,50)})`);
                    // END OF MODIFIED SECTION
                    return;
                }

                if (el.dataset.analyzerState === 'checking' || (commentData && commentData.classification !== classification) ||
                    (classification === "혐오" && el.dataset.analyzerState !== 'processed_hate') ||
                    (classification === "정상" && el.dataset.analyzerState !== 'processed_normal')) {
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
    }

    function restoreAllMatchingElementsToNormalOnError(targetContentId) {
        console.warn(`YouTube 댓글 분석기: 오류 발생, ID ${targetContentId.slice(0, 50)} 관련 댓글 원상 복구 시도.`);
        let restoredCount = 0;
        document.querySelectorAll(COMMENT_WRAPPER_SELECTOR).forEach(el => {
            const originalTextForThisElement = getOriginalTextFromElement(el) || el.dataset.originalContentAnalyzer;
            const elContentId = generateCommentId(originalTextForThisElement);

            if (elContentId === targetContentId) {
                if (el.dataset.analyzerState === 'checking') {
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
            if (mutation.type === "characterData" && mutation.target.parentElement.closest(COMMENT_WRAPPER_SELECTOR)) {
                const commentWrapper = mutation.target.parentElement.closest(COMMENT_WRAPPER_SELECTOR);
                if (commentWrapper && (!commentWrapper.dataset.analyzerState || commentWrapper.dataset.analyzerState === 'error_restored')) {
                    newRelevantChanges = true;
                }
            }
            if (newRelevantChanges) break;
        }

        if (newRelevantChanges) {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                scrapeAndProcessComments();
            }, DEBOUNCE_DELAY);
        }
    }

    function initializeAndStartObserver() {
        const commentsSectionElement = document.querySelector(COMMENTS_SECTION_SELECTOR);

        if (!commentsSectionElement) {
            setTimeout(initializeAndStartObserver, 500);
            return;
        }

        console.log("YouTube 댓글 분석기: ✅ 댓글 섹션 발견. 초기 댓글 스캔 및 MutationObserver 시작.");
        scrapeAndProcessComments();

        if (commentObserver) commentObserver.disconnect();
        commentObserver = new MutationObserver(handleCommentMutations);
        commentObserver.observe(commentsSectionElement, { childList: true, subtree: true, characterData: true });

        window.addEventListener('unload', () => {
            if (commentObserver) commentObserver.disconnect();
            clearTimeout(debounceTimer);
        });
    }

    function addCustomActionButtonToComment(commentElement) {
        const actionMenuContainer = commentElement.querySelector('div#action-menu');
        if (!actionMenuContainer) {
            return;
        }

        if (actionMenuContainer.querySelector(`.${CUSTOM_MENU_RENDERER_CLASS}`)) {
            return;
        }

        const existingMenuRenderer = actionMenuContainer.querySelector('ytd-menu-renderer');
        if (!existingMenuRenderer) {
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


        const icon = document.createElement('yt-icon2');
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
        svgElement.setAttribute('fill', 'red'); // Changed fill color for visibility
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
        pathExclamation.setAttribute('d', 'M11 15h2v2h-2zm0-8h2v6h-2z'); // Exclamation mark icon

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
                commentElement.dataset.originalContentAnalyzer || // Fallback to dataset
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
                    await response.json();
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