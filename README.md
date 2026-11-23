# Aquatic CSI

The Shark Lab(강원대학교 수의과대학 수생생물의학실) 시민과학 사진 수집 사이트.
GitHub Pages로 배포하고 도메인은 Cloudflare에서 연결합니다.

## 구조
```
index.html                    페이지 (CSS·JS 인라인)
assets/img/                   배경·로고·고정 타이포 이미지
data/news.json                '부캉이' 주요 뉴스 2건 (자동 갱신)
tools/update-news.mjs         뉴스 수집기 (Node 18+, 외부 패키지 없음)
.github/workflows/deploy.yml  매시간 뉴스 갱신 + Pages 배포
.nojekyll                     Jekyll 처리 끔
```

## 1. GitHub 설정 (최초 1회)
1. 이 폴더 전체를 저장소의 `main` 브랜치에 푸시
2. Settings → Pages → Build and deployment → **Source: GitHub Actions**
3. Settings → Actions → General → Workflow permissions → **Read and write permissions**
4. Actions 탭 → `deploy` → **Run workflow** 로 첫 배포
   - 이후 매시간 자동 실행. 기사가 바뀌면 `data/news.json` 이 커밋되고 사이트에 반영됨

## 2. Cloudflare 도메인 연결
1. GitHub: Settings → Pages → Custom domain 에 도메인 입력 (예: `csi.example.kr`) → Save
2. Cloudflare DNS
   - 서브도메인: `CNAME  csi  →  <github-사용자명>.github.io`
   - 루트 도메인: `A` 레코드 4개 `185.199.108.153` `185.199.109.153` `185.199.110.153` `185.199.111.153`
3. 처음에는 **DNS only(회색 구름)** 로 두고 GitHub에서 인증서 발급(Enforce HTTPS 체크 가능) 확인 후 Proxied(주황 구름)로 전환해도 됨
4. Proxied 사용 시 SSL/TLS 모드는 **Full** (Flexible 쓰면 무한 리다이렉트)
5. 뉴스 파일은 페이지에서 `?v=` 쿼리로 5분 단위 캐시를 우회하므로 별도 캐시 규칙 불필요

## 뉴스 갱신 방식
- 구글 뉴스 스토리 RSS(주요 뉴스) → 없으면 검색 RSS(`부캉이`)에서 상위 2건(언론사 중복 제외)
- 제목·언론사·날짜는 RSS만으로 확보. 기사 요약은 원문 페이지에서 추가로 가져오며, 실패해도 갱신은 진행
- 피드 자체를 받지 못하면 직전 `news.json` 유지
- 로컬 테스트: `node tools/update-news.mjs`
- GitHub 예약 실행은 부하에 따라 수 분~수십 분 늦어질 수 있음
