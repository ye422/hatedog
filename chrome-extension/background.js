// background.js

// 1. 서비스 워커 시작 시 로그 (확장 프로그램 로드/업데이트 시 한 번 실행)
console.log('YouTube 댓글 분석기: background.js (Service Worker) 시작됨.');

chrome.runtime.onInstalled.addListener(() => {
    console.log('YouTube 댓글 분석기: 확장 프로그램 설치됨/업데이트됨.');
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    // 2. onUpdated 이벤트 발생 시 상세 정보 로그
    console.log(`YouTube 댓글 분석기: Tab ID ${tabId} 업데이트 감지. URL: ${tab.url}, Status: ${changeInfo.status}`);
    if (changeInfo.status) { // status 변화가 있을 때만 로그 (너무 많은 로그 방지)
        console.log('YouTube 댓글 분석기: changeInfo:', JSON.stringify(changeInfo, null, 2));
    }


    // 3. 유튜브 도메인인지 확인하는 로그 (URL이 정의되어 있을 때만)
    if (tab.url) {
        if (tab.url.includes('youtube.com')) {
            console.log(`YouTube 댓글 분석기: 현재 탭(${tabId})은 YouTube 페이지입니다: ${tab.url}`);

            // 4. 'watch' 페이지인지 확인하고 content_script 주입 로직 실행
            if (
                changeInfo.status === 'complete' && // 로딩 완료 확인
                tab.url.includes('youtube.com/watch')
            ) {
                console.log(`YouTube 댓글 분석기: YouTube 'watch' 페이지(${tab.url}) 로딩 완료. content_script.js 주입 시도.`);
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content_script.js'],
                })
                    .then(() => {
                        console.log('YouTube 댓글 분석기: content_script.js 성공적으로 주입됨 (via background).');
                    })
                    .catch(err => console.error('YouTube 댓글 분석기: content_script.js 주입 실패:', err));
            } else if (changeInfo.status === 'complete') {
                console.log(`YouTube 댓글 분석기: YouTube 페이지(${tab.url})이지만 'watch' 페이지가 아님. content_script.js 주입 안 함.`);
            }
        } else {
            console.log(`YouTube 댓글 분석기: 현재 탭(${tabId})은 YouTube 페이지가 아님: ${tab.url}`);
        }
    } else {
        console.log(`YouTube 댓글 분석기: Tab ID ${tabId} 업데이트 - URL 정보 없음 (아마도 새 탭 또는 로딩 초기 단계).`);
    }
});

// (선택사항) 브라우저 액션(팝업 아이콘) 클릭 시 로그
chrome.action.onClicked.addListener((tab) => {
    console.log(`YouTube 댓글 분석기: 액션 아이콘 클릭됨. 현재 탭: ${tab.id}, URL: ${tab.url}`);
    // 여기에 팝업을 열거나 다른 동작을 추가할 수 있습니다.
    // 예: chrome.scripting.executeScript({ target: {tabId: tab.id}, func: () => alert("Hello from action!") });
});