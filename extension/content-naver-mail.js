(() => {
  const SERVER_URL = 'http://127.0.0.1:3080/api/naver-mail/sync';

  function extractNaverMailFromDom() {
    const mails = [];
    const seen = new Set();

    // 1. Extract mail list items (supports Naver Mail v2 & classic DOM structures)
    const itemEls = document.querySelectorAll(
      'li.mail_item, div.mail_item, ul.mail_list > li, [class*="mail_item"], tr[mailsn]'
    );

    itemEls.forEach((el, idx) => {
      const titleEl =
        el.querySelector('.mail_title_link, .mail_title, strong.mail_title, a[href*="/read/"], .subject') ||
        el.querySelector('a');
      const senderEl = el.querySelector(
        '.mail_sender, .button_sender, [class*="sender"], .name, .from'
      );
      const dateEl = el.querySelector('.mail_date, [class*="date"], .time, .i_date');
      const linkEl = el.querySelector('a[href*="/read/"], a.mail_title_link');

      let subject = (titleEl ? titleEl.innerText : '').replace(/\s+/g, ' ').trim();
      subject = subject.replace(/^메일 제목\s*/, '').trim();
      if (!subject) return;

      let sender = (senderEl ? senderEl.innerText : '').replace(/\s+/g, ' ').trim();
      sender = sender.replace(/^보낸 사람\s*/, '').trim();

      let date = (dateEl ? dateEl.innerText : '').replace(/\s+/g, ' ').trim();
      const href = linkEl ? linkEl.href : '';
      const mailSnMatch =
        (href && href.match(/\/read\/(\d+)/)) ||
        (el.getAttribute('data-mailsn') ? [null, el.getAttribute('data-mailsn')] : null);
      const mailSn = mailSnMatch ? mailSnMatch[1] : `dom-${idx}`;

      const isUnread =
        el.classList.contains('unreads') ||
        el.classList.contains('unread') ||
        Boolean(el.querySelector('.unread, [class*="unread"]'));

      const key = `${mailSn}:${subject}`;
      if (seen.has(key)) return;
      seen.add(key);

      mails.push({
        mailSn,
        subject,
        sender: sender || '알 수 없음',
        date: date || '',
        unread: isUnread,
        url: href || window.location.href,
      });
    });

    // 2. Extract currently open email body if viewing an email
    let openMail = null;
    const viewBodyEl = document.querySelector(
      '.mail_view_contents, .mail_view_body, #readFrame, [class*="mail_view_contents"]'
    );
    if (viewBodyEl) {
      const viewTitleEl = document.querySelector(
        '.mail_view_title, h4.view_title, [class*="mail_view_title"]'
      );
      const viewSenderEl = document.querySelector(
        '.mail_view_header .button_user, .mail_view_header [class*="sender"], .option_area'
      );
      const viewDateEl = document.querySelector(
        '.mail_view_header .mail_view_date, [class*="mail_view_date"]'
      );
      openMail = {
        subject: viewTitleEl ? viewTitleEl.innerText.replace(/\s+/g, ' ').trim() : document.title,
        sender: viewSenderEl ? viewSenderEl.innerText.replace(/\s+/g, ' ').trim() : '',
        date: viewDateEl ? viewDateEl.innerText.replace(/\s+/g, ' ').trim() : '',
        body: viewBodyEl.innerText.trim().slice(0, 15000),
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

  function pushToAgyServer() {
    try {
      const payload = extractNaverMailFromDom();
      if (payload.mails.length === 0 && !payload.openMail) return;
      fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch (_) {}
  }

  // Initial sync & periodic sync on DOM changes
  setTimeout(pushToAgyServer, 1200);
  setInterval(pushToAgyServer, 4000);
})();
