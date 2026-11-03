// 공간 뷰 건물 텍스처(KTX2) 트랜스코더 워커의 껍데기 [globe]
// KTX2Loader 는 트랜스코더를 blob 워커로 띄운다 — blob 워커는 페이지 CSP 를 물려받아 eval 이 막힌다
// (Basis 트랜스코더의 embind 가 new Function 을 쓴다). 주소로 띄운 워커는 이 파일 응답의 CSP 를 따르므로,
// 서버가 이 파일에만 eval 을 허락하고(server.js), 여기서 로더가 만든 blob 을 그대로 불러온다.
importScripts(new URL(location.href).searchParams.get('src'));
