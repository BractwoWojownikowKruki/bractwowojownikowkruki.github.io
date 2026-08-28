/**
 * Facebook Feed Widget
 *
 * Renders from the statically-synced archive (public/facebook/data/, written by
 * scripts/sync-facebook.ts - see KRKG-0035) rather than a live call on every page load, so the
 * landing page never has to wait on the Cloud Run backend to show posts. A background live
 * check against the backend's /facebook-posts then prepends anything newer than what's been
 * synced statically, admin-configurable via liveFetchPostCount - it never blocks or replaces
 * the static render, only adds to it.
 */

class FacebookFeed {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.backendUrl = options.backendUrl || 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';
    this.pageSize = options.pageSize || 5;
    this.index = [];
    this.offset = 0;
    this.renderedIds = new Set();
    this.grid = null;
  }

  async load() {
    if (!this.container) {
      console.warn('Facebook feed container not found');
      return;
    }

    try {
      this.index = await this.fetchIndex();
    } catch (error) {
      console.error('Facebook feed error (static archive):', error);
      this.index = [];
    }

    if (this.index.length > 0) {
      this.renderGridShell();
      await this.loadNextPage();
    } else {
      this.renderEmpty();
    }

    // Not awaited by design - the static render above must never wait on this network call.
    this.checkLive();
  }

  async fetchIndex() {
    const res = await fetch('facebook/data/index.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to fetch index: ${res.status}`);
    return res.json();
  }

  async fetchStaticPost(id) {
    try {
      const res = await fetch(`facebook/data/posts/${id}.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async loadNextPage() {
    const batch = this.index.slice(this.offset, this.offset + this.pageSize);
    const posts = await Promise.all(batch.map(entry => this.fetchStaticPost(entry.id)));
    posts.filter(Boolean).forEach(post => this.appendPost(this.normalizeStaticPost(post)));
    this.offset += batch.length;
    this.updateLoadMoreVisibility();
  }

  // Live posts and static posts use different field names (see server.ts's Post type vs
  // scripts/facebook-sync-utils.ts's StoredPost) - normalized to one shape renderPost expects.
  normalizeStaticPost(post) {
    return {
      id: post.id,
      caption: post.caption,
      mediaUrl: post.image,
      permalink: post.permalink,
      timestamp: post.timestamp,
      likeCount: post.likeCount,
      commentsCount: post.commentsCount,
    };
  }

  normalizeLivePost(post) {
    return {
      id: post.id,
      caption: post.caption,
      mediaUrl: post.media_url,
      permalink: post.permalink,
      timestamp: post.timestamp,
      likeCount: post.like_count ?? 0,
      commentsCount: post.comments_count ?? 0,
    };
  }

  async checkLive() {
    let data;
    try {
      const res = await fetch(`${this.backendUrl}/facebook-posts`);
      if (!res.ok) throw new Error(`Failed to fetch live posts: ${res.status}`);
      data = await res.json();
    } catch (error) {
      console.warn('Facebook live check failed (static content still shown):', error);
      return;
    }

    const liveFetchPostCount = data.liveFetchPostCount ?? 0;
    const knownIds = new Set(this.index.map(entry => entry.id));
    const newPosts = (data.posts || [])
      .slice(0, liveFetchPostCount)
      .filter(post => !knownIds.has(post.id));
    if (newPosts.length === 0) return;

    if (!this.grid) this.renderGridShell();
    // newPosts is newest-first (same order /facebook-posts returns); reverse so the final
    // prepend order keeps the newest post at the very top.
    newPosts.slice().reverse().forEach(post => this.appendPost(this.normalizeLivePost(post), true));
  }

  renderGridShell() {
    this.container.innerHTML = `
      <div class="fb-posts-grid" id="fb-posts-grid"></div>
      <div class="fb-load-more-wrap" id="fb-load-more-wrap" hidden>
        <button type="button" class="fb-load-more-btn" id="fb-load-more-btn">Pokaż więcej</button>
      </div>
    `;
    this.grid = document.getElementById('fb-posts-grid');
    document.getElementById('fb-load-more-btn').addEventListener('click', () => this.loadNextPage());
  }

  updateLoadMoreVisibility() {
    const wrap = document.getElementById('fb-load-more-wrap');
    if (wrap) wrap.hidden = this.offset >= this.index.length;
  }

  appendPost(post, prepend = false) {
    if (this.renderedIds.has(post.id)) return;
    this.renderedIds.add(post.id);
    this.grid.insertAdjacentHTML(prepend ? 'afterbegin' : 'beforeend', this.renderPost(post));
    this.setupExpandButtons();
    this.ensureMobileWidgetSlots();
  }

  // Mobile only: the Instagram/YouTube sidebar is hidden on small screens (see .content-right
  // in style.css) so those channels stay discoverable without scrolling through every Facebook
  // post first - compact, single-row versions of each are inlined after the 1st and 2nd post
  // instead. Idempotent (checks for existing slots before inserting) so it's safe to call after
  // every appendPost regardless of static/live/pagination order.
  ensureMobileWidgetSlots() {
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (!isMobile) return;
    const posts = this.grid.querySelectorAll('.fb-post');

    if (posts.length >= 1 && !document.getElementById('inline-ig-feed')) {
      posts[0].insertAdjacentHTML('afterend', '<div id="inline-ig-feed" class="inline-widget-slot"></div>');
      if (window.InstagramFeed) new window.InstagramFeed('inline-ig-feed', { backendUrl: this.backendUrl, compact: true }).load();
    }
    if (posts.length >= 2 && !document.getElementById('inline-yt-feed')) {
      posts[1].insertAdjacentHTML('afterend', '<div id="inline-yt-feed" class="inline-widget-slot"></div>');
      if (window.YouTubeFeed) new window.YouTubeFeed('inline-yt-feed', { backendUrl: this.backendUrl, compact: true }).load();
    }
  }

  // The 16-line clamp (see .fb-post-text in style.css) only needs a button when it's actually
  // truncating - scrollHeight > clientHeight is the standard way to detect that after the
  // clamped box has been laid out. No re-fetch on click: the full caption is already in the
  // DOM, clamping is pure CSS, so expanding is just a class toggle.
  setupExpandButtons() {
    this.grid.querySelectorAll('.fb-post-text').forEach(p => {
      const btn = p.nextElementSibling;
      if (!btn || !btn.classList.contains('fb-post-expand')) return;
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
    const { caption, mediaUrl, permalink, timestamp, likeCount, commentsCount } = post;
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
        ${mediaUrl ? `
          <div class="fb-post-media">
            <img src="${this.escapeHtml(mediaUrl)}" alt="Post" loading="lazy" />
          </div>
        ` : ''}
        <a href="${safePermalink}" target="_blank" rel="noopener noreferrer" class="fb-post-engagement" aria-label="Zobacz post na Facebooku">
          <span class="fb-post-stat">${this.likeIconSvg()}${likeCount ?? 0}</span>
          <span class="fb-post-stat">${this.commentIconSvg()}${commentsCount ?? 0}</span>
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
    const pageSize = parseInt(feedContainer.dataset.pageSize || '5');

    const feed = new FacebookFeed('facebook-feed', {
      backendUrl,
      pageSize
    });
    feed.load();
  }
});

// Export for manual use
window.FacebookFeed = FacebookFeed;
