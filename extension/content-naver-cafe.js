(() => {
  const SERVER_SYNC_URL = 'http://127.0.0.1:3080/api/naver-cafe/sync';

  function cleanText(str) {
    return (str || '').replace(/\s+/g, ' ').trim();
  }

  async function extractNaverCafeData() {
    const joinedCafes = [];
    const seenCafes = new Set();
    const articles = [];
    const seenArticles = new Set();

    // 1. Fetch joined cafes from Naver Cafe Home API if on top frame
    if (window === window.top) {
      const apiUrls = [
        'https://apis.naver.com/cafe-home-web/cafe-home/v1/cafes/join?page=1&perPage=100',
        'https://apis.naver.com/cafe-home-web/cafe-home/v1/cafes/favorite',
      ];
      for (const apiUrl of apiUrls) {
        try {
          const resp = await fetch(apiUrl, { credentials: 'include' });
          if (resp.ok) {
            const json = await resp.json();
            const list =
              json?.message?.result?.cafes ||
              json?.message?.result?.favoriteCafes ||
              json?.result?.cafes ||
              json?.cafes ||
              [];
            if (Array.isArray(list)) {
              for (const c of list) {
                const cafeId = String(c.cafeId || c.clubid || c.id || '');
                const cafeUrl = String(c.cafeUrl || c.cluburl || '').replace(/^\/+|\/+$/g, '');
                const cafeName = cleanText(c.cafeName || c.clubname || cafeUrl);
                const key = cafeId || cafeUrl;
                if (key && !seenCafes.has(key)) {
                  seenCafes.add(key);
                  joinedCafes.push({
                    cafeId,
                    cafeUrl,
                    cafeName: cafeName || cafeUrl || cafeId,
                    url: cafeUrl
                      ? `https://cafe.naver.com/${cafeUrl}`
                      : `https://cafe.naver.com/MyCafeIntro.nhn?clubid=${cafeId}`,
                  });
                }
              }
            }
          }
        } catch (_) {}
      }
    }

    // 2. Also scrape joined cafes / current cafe from DOM links
    const cafeLinks = document.querySelectorAll(
      'a[href*="cafe.naver.com/"], .cafe_item a, .my_cafe_list a, [class*="cafe_name"], [class*="CafeItem"] a'
    );
    cafeLinks.forEach((a) => {
      const href = a.href || '';
      const m = href.match(/^https?:\/\/cafe\.naver\.com\/([A-Za-z0-9_-]{2,40})\/?(?:\?.*)?$/);
      if (!m) return;
      const slug = m[1];
      if (
        [
          'ca-fe',
          'ArticleRead.nhn',
          'ArticleList.nhn',
          'ArticleSearchList.nhn',
          'MyCafeIntro.nhn',
          'CafeProfileView.nhn',
          'f-e',
        ].includes(slug)
      ) {
        return;
      }
      const name = cleanText(a.innerText) || slug;
      if (name.length > 60) return;
      if (!seenCafes.has(slug)) {
        seenCafes.add(slug);
        joinedCafes.push({
          cafeId: '',
          cafeUrl: slug,
          cafeName: name,
          url: `https://cafe.naver.com/${slug}`,
        });
      }
    });

    // 3. Scrape visible article list / search results from current page or iframe
    const articleRows = document.querySelectorAll(
      'tr, li, div.article_item, div[class*="article_item"], div[class*="ArticleItem"], div.item_area'
    );
    articleRows.forEach((row) => {
      const linkEl = row.querySelector(
        'a.article, a.tit, a.item_title, a[href*="ArticleRead.nhn"], a[href*="/articles/"], a[class*="article_title"], a[class*="title_link"]'
      );
      if (!linkEl) return;
      const title = cleanText(linkEl.innerText);
      if (!title || title.length < 2) return;
      const href = linkEl.href || '';
      if (!href) return;

      const cafeNameEl = row.querySelector(
        '.cafe_name, [class*="cafe_name"], .sub_info a, .cafe_title'
      );
      const writerEl = row.querySelector(
        '.p-nick, .nick, .writer, [class*="nickname"], [class*="writer"]'
      );
      const dateEl = row.querySelector('.td_date, .date, .time, [class*="date"]');
      const previewEl = row.querySelector('.dsc, .content, [class*="summary"], [class*="preview"]');

      const key = `${href}:${title}`;
      if (!seenArticles.has(key)) {
        seenArticles.add(key);
        articles.push({
          title,
          url: href,
          cafeName: cleanText(cafeNameEl ? cafeNameEl.innerText : document.title.replace(/ : 네이버 카페$/, '')),
          author: cleanText(writerEl ? writerEl.innerText : ''),
          date: cleanText(dateEl ? dateEl.innerText : ''),
          snippet: cleanText(previewEl ? previewEl.innerText : ''),
        });
      }
    });

    // 4. Extract currently open article body if reading a post
    let openArticle = null;
    const bodyEl = document.querySelector(
      '.ArticleContentBox .se-main-container, .ArticleContentBox .ContentRenderer, #tbody, .article_viewer, .se-main-container'
    );
    if (bodyEl) {
      const titleEl = document.querySelector(
        '.ArticleTitle .title_text, h3.title_text, .tit-box .b, [class*="title_text"]'
      );
      const authorEl = document.querySelector(
        '.WriterInfo .nickname, .profile_info .nick, [class*="nickname"]'
      );
      const dateEl = document.querySelector('.article_info .date, [class*="article_info"] .date');
      const bodyText = (bodyEl.innerText || '').trim();
      if (bodyText) {
        openArticle = {
          title: cleanText(titleEl ? titleEl.innerText : document.title),
          author: cleanText(authorEl ? authorEl.innerText : ''),
          date: cleanText(dateEl ? dateEl.innerText : ''),
          body: bodyText.slice(0, 15000),
          url: window.location.href,
        };
      }
    }

    return {
      pageUrl: window.location.href,
      pageTitle: document.title,
      fetchedAt: new Date().toISOString(),
      joinedCafes,
      articles,
      openArticle,
    };
  }

  async function pushToServer() {
    try {
      const payload = await extractNaverCafeData();
      if (
        payload.joinedCafes.length === 0 &&
        payload.articles.length === 0 &&
        !payload.openArticle
      ) {
        return;
      }
      await fetch(SERVER_SYNC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (_) {}
  }

  setTimeout(pushToServer, 1200);
  setInterval(pushToServer, 5000);
})();
