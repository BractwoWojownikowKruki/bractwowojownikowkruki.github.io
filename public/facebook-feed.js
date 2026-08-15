/**
 * Facebook Feed Widget
 * Displays latest Facebook posts with images and text
 */

class FacebookFeed {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.backendUrl = options.backendUrl || 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';
    this.postsLimit = options.postsLimit || 10;
  }

  async load() {
    if (!this.container) {
      console.warn(`Facebook feed container not found: ${containerId}`);
      return;
    }

    try {
      const response = await fetch(`${this.backendUrl}/facebook-posts`);
      if (!response.ok) throw new Error(`Failed to fetch posts: ${response.status}`);

      const data = await response.json();
      this.render(data.posts || []);
    } catch (error) {
      console.error('Facebook feed error:', error);
      this.renderError();
    }
  }

  render(posts) {
    if (!posts.length) {
      this.renderEmpty();
      return;
    }

    const limited = posts.slice(0, this.postsLimit);
    // Mobile only: the Instagram/YouTube sidebar is hidden on small screens (see .content-right
    // in style.css) so those channels stay discoverable without scrolling through every
    // Facebook post first - compact, single-row versions of each are inlined after the 1st and
    // 2nd post instead. Desktop is unaffected: the sidebar there already shows both in full.
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    let html = '';
    limited.forEach((post, index) => {
      html += this.renderPost(post);
      if (isMobile && index === 0) html += '<div id="inline-ig-feed" class="inline-widget-slot"></div>';
      if (isMobile && index === 1) html += '<div id="inline-yt-feed" class="inline-widget-slot"></div>';
    });
    // Fewer than 2 posts would otherwise silently drop the YouTube slot (its usual position,
    // after the 2nd post, never comes up) - append it at the end instead of losing it.
    if (isMobile && limited.length < 2) {
      html += '<div id="inline-yt-feed" class="inline-widget-slot"></div>';
    }

    this.container.innerHTML = `<div class="fb-posts-grid">${html}</div>`;

    if (isMobile) {
      if (window.InstagramFeed) {
        new window.InstagramFeed('inline-ig-feed', { backendUrl: this.backendUrl, compact: true }).load();
      }
      if (window.YouTubeFeed) {
        new window.YouTubeFeed('inline-yt-feed', { backendUrl: this.backendUrl, compact: true }).load();
      }
    }

    this.setupExpandButtons();
  }

  // The 16-line clamp (see .fb-post-text in style.css) only needs a button when it's actually
  // truncating - scrollHeight > clientHeight is the standard way to detect that after the
  // clamped box has been laid out. No re-fetch on click: the full caption is already in the
  // DOM, clamping is pure CSS, so expanding is just a class toggle.
  setupExpandButtons() {
    this.container.querySelectorAll('.fb-post-text').forEach(p => {
      const btn = p.nextElementSibling;
      if (p.scrollHeight <= p.clientHeight + 1) {
        btn.remove();
        return;
      }
      btn.addEventListener('click', () => {
        p.classList.add('fb-post-text--expanded');
        btn.remove();
      });
    });
  }

  renderPost(post) {
    const { caption, media_url, permalink, timestamp, like_count, comments_count } = post;
    const date = new Date(timestamp);
    const dateStr = date.toLocaleDateString('pl-PL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
    const safePermalink = this.escapeHtml(permalink);

    return `
      <article class="fb-post">
        <a href="${safePermalink}" target="_blank" rel="noopener noreferrer" class="fb-post-date">
          ${this.escapeHtml(dateStr)}
        </a>
        ${media_url ? `
          <div class="fb-post-media">
            <img src="${this.escapeHtml(media_url)}" alt="Post" loading="lazy" />
          </div>
        ` : ''}
        <a href="${safePermalink}" target="_blank" rel="noopener noreferrer" class="fb-post-engagement" aria-label="Zobacz post na Facebooku">
          <span class="fb-post-stat">${this.likeIconSvg()}${like_count ?? 0}</span>
          <span class="fb-post-stat">${this.commentIconSvg()}${comments_count ?? 0}</span>
          <span class="fb-post-fb-icon">${this.facebookIconSvg()}</span>
        </a>
        <div class="fb-post-content">
          <p class="fb-post-text">${this.escapeHtml(caption)}</p>
          <button type="button" class="fb-post-expand">Rozwiń</button>
        </div>
      </article>
    `;
  }

  likeIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2h0a3.13 3.13 0 0 1 3 3.88Z"/></svg>';
  }

  commentIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
  }

  facebookIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg>';
  }

  renderEmpty() {
    this.container.innerHTML = `
      <div class="fb-feed-empty">
        <p>Brak postów do wyświetlenia.</p>
      </div>
    `;
  }

  renderError() {
    this.container.innerHTML = `
      <div class="fb-feed-error">
        <p>Nie udało się załadować postów z Facebooka.</p>
      </div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Auto-initialize Facebook feed
document.addEventListener('DOMContentLoaded', () => {
  const feedContainer = document.getElementById('facebook-feed');
  if (feedContainer) {
    const backendUrl = feedContainer.dataset.backendUrl || 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';
    const postsLimit = parseInt(feedContainer.dataset.postsLimit || '10');

    const feed = new FacebookFeed('facebook-feed', {
      backendUrl,
      postsLimit
    });
    feed.load();
  }
});

// Export for manual use
window.FacebookFeed = FacebookFeed;
