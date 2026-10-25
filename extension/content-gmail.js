(() => {
  const SERVER_URL = 'http://127.0.0.1:3080/api/gmail/sync';

  async function extractGmail() {
    const mails = [];
    const seen = new Set();

    // 1. Try Gmail Atom feed using current browser session cookies
    try {
      const resp = await fetch('https://mail.google.com/mail/feed/atom', {
        credentials: 'include',
      });
      if (resp.ok) {
        const text = await resp.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, 'text/xml');
        const entries = xmlDoc.querySelectorAll('entry');
        entries.forEach((entry, idx) => {
          const title = entry.querySelector('title')?.textContent?.trim() || '(제목 없음)';
          const summary = entry.querySelector('summary')?.textContent?.trim() || '';
          const authorName = entry.querySelector('author name')?.textContent?.trim() || '';
          const authorEmail = entry.querySelector('author email')?.textContent?.trim() || '';
          const sender = authorName ? `${authorName} <${authorEmail}>` : (authorEmail || '알 수 없음');
          const issued = entry.querySelector('issued, modified')?.textContent?.trim() || '';
          const link = entry.querySelector('link')?.getAttribute('href') || 'https://mail.google.com';
          const id = entry.querySelector('id')?.textContent?.trim() || `atom-${idx}`;

          const key = id || `${title}:${sender}`;
          if (!seen.has(key)) {
            seen.add(key);
            mails.push({
              mailId: id,
              subject: title,
              sender,
              date: issued ? new Date(issued).toLocaleString('ko-KR') : '',
              snippet: summary,
              unread: true,
              url: link,
            });
          }
        });
      }
    } catch (_) {}

    // 2. Extract mail items from rendered Gmail DOM
    // Gmail list rows have class "zA" (zE = unread, yO = read) or role="row"
    const rows = document.querySelectorAll('tr.zA, div[role="row"].zA, tr[role="row"]');
    rows.forEach((row, idx) => {
      const subjectEl = row.querySelector('.bog, .y6 span, [data-thread-id], span[role="gridcell"]');
      const snippetEl = row.querySelector('.y2');
      const senderEl = row.querySelector('.yW span[email], .bA4 span, .yP, .zF, [email]') || row.querySelector('.yX');
      const dateEl = row.querySelector('.xW span, .xY span, td.xW, [title*="202"], [title*="오전"], [title*="오후"]');
      const linkEl = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#search/"]') || row.querySelector('a');

      let subject = subjectEl ? subjectEl.innerText.replace(/\s+/g, ' ').trim() : '';
      if (!subject && linkEl) {
        subject = linkEl.innerText.replace(/\s+/g, ' ').trim();
      }
      if (!subject) return;

      let snippet = snippetEl ? snippetEl.innerText.replace(/\s+/g, ' ').trim() : '';
      let sender = senderEl ? (senderEl.getAttribute('email') || senderEl.innerText.replace(/\s+/g, ' ').trim()) : '알 수 없음';
      let date = dateEl ? (dateEl.getAttribute('title') || dateEl.innerText.replace(/\s+/g, ' ').trim()) : '';

      const isUnread = row.classList.contains('zE') || Boolean(row.querySelector('.zE, font[weight="bold"], strong'));
      const href = linkEl ? linkEl.href : window.location.href;
      const id = row.getAttribute('id') || row.getAttribute('data-legacy-thread-id') || `row-${idx}`;

      const key = `${id}:${subject}`;
      if (!seen.has(key)) {
        seen.add(key);
        mails.push({
          mailId: id,
          subject,
          sender,
          date,
          snippet,
          unread: isUnread,
          url: href,
        });
      }
    });

    // 3. Extract currently open email view if user is reading an email in Gmail
    let openMail = null;
    const mailBodyEl = document.querySelector('.a3s.aiL, div[role="listitem"] .a3s, .ii.gt');
    if (mailBodyEl) {
      const titleEl = document.querySelector('h2.hP, [data-thread-perm-id] h2, h2[data-legacy-thread-id]') || document.querySelector('h2');
      const senderEl = document.querySelector('span.gD, .gE .gD, [email]');
      const dateEl = document.querySelector('span.g3, .gH .g3, span[role="gridcell"]');

      const subject = titleEl ? titleEl.innerText.replace(/\s+/g, ' ').trim() : document.title;
      const sender = senderEl ? (senderEl.getAttribute('email') ? `${senderEl.innerText.trim()} <${senderEl.getAttribute('email')}>` : senderEl.innerText.trim()) : '';
      const date = dateEl ? (dateEl.getAttribute('title') || dateEl.innerText.trim()) : '';
      const body = mailBodyEl.innerText.trim().slice(0, 15000);

      openMail = {
        subject,
        sender,
        date,
        body,
        url: window.location.href,
      };
    }

    return {
      pageUrl: window.location.href,
      pageTitle: document.title,
      fetchedAt: new Date().toISOString(),
      mails,
      openMail,
    };
  }

  async function pushToAgyServer() {
    try {
      const payload = await extractGmail();
      if ((!payload.mails || payload.mails.length === 0) && !payload.openMail) return;
      await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (_) {}
  }

  setTimeout(pushToAgyServer, 1000);
  setInterval(pushToAgyServer, 4000);
})();
