#!/usr/bin/env node
/**
 * Aquatic CSI — 구글 뉴스 '부캉이' 주요 뉴스 상위 2건 수집기
 * 결과: data/news.json  (index.html 이 읽어 감)
 *
 * 실행: node tools/update-news.mjs          (Node 18 이상, 외부 패키지 없음)
 * 주기 실행: .github/workflows/deploy.yml (GitHub Actions, 매시간) 이 실행 후 Pages 배포
 *
 * 1) 구글 뉴스 검색 RSS('부캉이', 메인 '더 보기' 링크와 같은 검색)  ← 여기까지만 성공하면 갱신됨
 *    (스토리 RSS는 '사용할 수 없는 피드입니다.' 가짜 항목만 돌려주어 제외)
 * 2) (선택) news.google.com 중계 링크를 실제 기사 URL로 변환 → 기사 요약(og:description) 추출
 *    2단계가 실패해도 제목·언론사·날짜·구글 뉴스 링크로 정상 갱신
 * 3) 피드 자체를 못 받으면 기존 news.json 을 덮어쓰지 않음(종료 코드 1)
 */
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.NEWS_OUT || resolve(ROOT, "data/news.json");
const QUERY = process.env.NEWS_QUERY || "부캉이";
const STORY_ID = process.env.NEWS_STORY_ID || "CAAqNggKIjBDQklTSGpvSmMzUnZjbmt0TXpZd1NoRUtEd2liX3QtV0VoRUMteGVJRHpCb1NpZ0FQAQ";
const LOCALE = "hl=ko&gl=KR&ceid=KR:ko";
const feedOf = q => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&${LOCALE}`;
const FEEDS = (process.env.NEWS_FEEDS ? process.env.NEWS_FEEDS.split(",") : [feedOf(QUERY)]);
// 상단 고정 키워드 (메인 NEWS 맨 위 2건, '더 보기' 없음)
const FEATURED_QUERY = process.env.NEWS_FEATURED_QUERY || "부캉이 김상화";
const FEATURED_FEEDS = (process.env.NEWS_FEATURED_FEEDS ? process.env.NEWS_FEATURED_FEEDS.split(",") : [feedOf(FEATURED_QUERY)]);
const LIMIT = 2;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, opts = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(15000),
    ...opts,
    headers: { "User-Agent": UA, "Accept-Language": "ko-KR,ko;q=0.9", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res;
}

/* ── 문자셋을 고려한 HTML 디코딩 (EUC-KR 언론사 대응) ── */
async function getHtml(url) {
  const res = await get(url);
  const buf = new Uint8Array(await res.arrayBuffer());
  let cs = (res.headers.get("content-type") || "").match(/charset=([\w-]+)/i)?.[1];
  if (!cs) {
    const head = new TextDecoder("latin1").decode(buf.slice(0, 4096));
    cs = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try { return { html: new TextDecoder((cs || "utf-8").toLowerCase()).decode(buf), finalUrl: res.url }; }
  catch { return { html: new TextDecoder("utf-8").decode(buf), finalUrl: res.url }; }
}

const decodeEntities = s => String(s ?? "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
  .replace(/&(lsquo|rsquo|ldquo|rdquo|middot|hellip|ndash|mdash);/g, (_, k) => ({ lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", middot: "·", hellip: "…", ndash: "–", mdash: "—" })[k])
  .replace(/&amp;/g, "&");
const stripTags = s => decodeEntities(decodeEntities(s)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const tag = (xml, name) => xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "";

/* ── RSS 파싱 ── */
function parseRss(xml) {
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(m => {
    const it = m[1];
    const source = stripTags(tag(it, "source"));
    let title = stripTags(tag(it, "title"));
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    return {
      title, source,
      sourceUrl: it.match(/<source[^>]*url="([^"]+)"/i)?.[1] || "",
      link: decodeEntities(tag(it, "link")).trim(),
      pubDate: tag(it, "pubDate").trim(),
    };
  }).filter(x =>
    x.title && x.link && x.source &&                       // 언론사 없는 항목(구글 안내 문구) 제외
    /\/articles\//.test(x.link) &&                        // 실제 기사 링크만
    !/사용할 수 없는 피드|feed is unavailable/i.test(x.title));
}

/* ── news.google.com 중계 링크 → 실제 기사 URL ── */
async function resolveGoogleLink(link) {
  if (!/news\.google\.com/.test(link)) return link;
  const id = link.match(/\/(?:rss\/)?articles\/([^?/]+)/)?.[1];
  if (!id) return link;
  // 구형 인코딩: base64 안에 URL이 그대로 들어 있음
  try {
    const raw = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1");
    const direct = raw.match(/https?:\/\/[\x21-\x7e]+/)?.[0];
    if (direct && !direct.includes("AU_yqL")) return direct;
  } catch {}
  // 신형 인코딩: 서명·타임스탬프 받아 batchexecute 호출
  try {
    const page = await (await get(`https://news.google.com/rss/articles/${id}`)).text();
    const sg = page.match(/data-n-a-sg="([^"]+)"/)?.[1];
    const ts = page.match(/data-n-a-ts="([^"]+)"/)?.[1];
    if (!sg || !ts) return link;
    const req = [[["Fbv4je",
      `["garturlreq",[["X","X",["X","X"],null,null,1,1,"KR:ko",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`,
      null, "generic"]]];
    const res = await get("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: "f.req=" + encodeURIComponent(JSON.stringify(req)),
    });
    const text = await res.text();
    const url = text.match(/\\"garturlres\\",\\"(https?:[^\\"]+)\\"/)?.[1]
             || text.match(/"garturlres","(https?:[^"]+)"/)?.[1];
    return url ? url.replace(/\\u003d/g, "=").replace(/\\u0026/g, "&") : link;
  } catch { return link; }
}

/* ── 기사 페이지 메타 ── */
function meta(html, key) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i");
  return decodeEntities(html.match(re1)?.[1] || html.match(re2)?.[1] || "").trim();
}
async function enrich(item) {
  const url = await resolveGoogleLink(item.link);
  let snippet = "", finalUrl = url;
  if (!/news\.google\.com/.test(url)) {
    try {
      const { html, finalUrl: f } = await getHtml(url);
      finalUrl = f || url;
      snippet = meta(html, "og:description") || meta(html, "description") || meta(html, "twitter:description");
    } catch (e) { console.warn("기사 메타 실패:", url, e.message); }
  }
  const d = new Date(item.pubDate);
  const kst = isNaN(d) ? null : new Date(d.getTime() + 9 * 3600e3);
  return {
    source: item.source || (finalUrl ? new URL(finalUrl).hostname : ""),
    mark: (item.source || "N").trim().charAt(0),
    title: item.title,
    date: kst ? `${kst.getUTCFullYear()}. ${kst.getUTCMonth() + 1}. ${kst.getUTCDate()}.` : "",
    published: isNaN(d) ? null : d.toISOString(),
    snippet: stripTags(snippet),
    url: finalUrl,
  };
}

async function fetchTop(feeds, exclude = new Set()) {
  let items = [], used = "";
  for (const feed of feeds) {
    try {
      const xml = await (await get(feed)).text();
      items = parseRss(xml);
      if (items.length) { used = feed; break; }
    } catch (e) { console.warn("피드 실패:", feed, e.message); }
  }
  // 상단 고정 기사와 같은 제목 제외, 같은 언론사 중복 제거 후 상위 2건
  const seen = new Set(), top = [];
  for (const it of items) {
    if (exclude.has(it.title) || seen.has(it.source)) continue;
    seen.add(it.source); top.push(it);
    if (top.length === LIMIT) break;
  }
  const out = [];
  for (const it of top) { out.push(await enrich(it)); await sleep(400); }
  return { out, used };
}

async function main() {
  let prev = null;
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

  // 1) 상단 고정: '부캉이 김상화' — 못 받으면 이전 값 유지
  const f = await fetchTop(FEATURED_FEEDS);
  const featured = f.out.length ? f.out : (prev && prev.featured) || [];
  if (!f.out.length) console.warn("상단 고정 기사 없음 — 이전 값 유지");

  // 2) 일반: '부캉이' (상단 고정과 겹치는 기사 제외)
  const g = await fetchTop(FEEDS, new Set(featured.map(n => n.title)));
  if (!g.out.length && !f.out.length) { console.error("뉴스 없음 — 기존 파일 유지"); process.exit(1); }
  const items = g.out.length ? g.out : (prev && prev.items) || [];

  const now = new Date().toISOString();
  const same = prev && JSON.stringify(prev.items) === JSON.stringify(items) && JSON.stringify(prev.featured || []) === JSON.stringify(featured);
  const data = {
    query: QUERY, feed: g.used || (prev && prev.feed) || "",
    featuredQuery: FEATURED_QUERY,
    updated: same ? prev.updated : now, checked: now,
    featured, items
  };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `changed=${same ? "false" : "true"}\n`, { flag: "a" });
  console.log(same ? "기사 변경 없음 (checked 시각만 갱신)" : "기사 변경됨");
  console.log(`저장: ${OUT}`);
  featured.forEach(n => console.log(` * [${n.source}] ${n.title}`));
  items.forEach(n => console.log(` - [${n.source}] ${n.title}`));
}
main().catch(e => { console.error(e); process.exit(1); });
