/**
 * Instagram Feed Widget
 * Displays the latest posts as a compact thumbnail grid (mirrors Instagram's own profile grid).
 * Replaces the previous raw <iframe src="instagram.com/.../embed"> embed, whose fixed internal
 * layout couldn't be shrunk to fit mobile without clipping its own content.
 */

const INSTAGRAM_PROFILE_URL = 'https://www.instagram.com/kruki.brotherhood/';

class InstagramFeed {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.backendUrl = options.backendUrl || 'https://krucze-galery-upload-x6mr6ilyha-lm.a.run.app';
    // Compact mode: a single scrollable row of thumbnails, no header/"see more" chrome - used
    // when this widget is inlined between Facebook posts on mobile instead of shown in the
    // (now hidden-on-mobile) sidebar.
    this.compact = options.compact || false;
    this.postsLimit = options.postsLimit || (this.compact ? 4 : 6);
  }

  async load() {
    if (!this.container) {
      console.warn(`Instagram feed container not found: ${containerId}`);
      return;
    }

    try {
      const response = await fetch(`${this.backendUrl}/instagram-posts`);
      if (!response.ok) throw new Error(`Failed to fetch posts: ${response.status}`);

      const data = await response.json();
      this.render(data.posts || []);
    } catch (error) {
      console.error('Instagram feed error:', error);
      this.renderError();
    }
  }

  render(posts) {
    if (!posts.length) {
      this.renderEmpty();
      return;
    }

    if (this.compact) {
      this.renderCompact(posts);
      return;
    }

    const postsHtml = posts
      .slice(0, this.postsLimit)
      .map(post => this.renderPost(post))
      .join('');

    this.container.innerHTML = `
      <a href="${INSTAGRAM_PROFILE_URL}" target="_blank" rel="noopener noreferrer" class="ig-header">
        ${this.instagramIconSvg()}
        <span>kruki.brotherhood</span>
      </a>
      <div class="ig-posts-grid">${postsHtml}</div>
      <a href="${INSTAGRAM_PROFILE_URL}" target="_blank" rel="noopener noreferrer" class="ig-more-link">
        Zobacz więcej na Instagramie
      </a>
    `;
  }

  renderCompact(posts) {
    const postsHtml = posts
      .slice(0, this.postsLimit)
      .map(
        post => `
      <a class="ig-compact-post" href="${this.escapeHtml(post.permalink)}" target="_blank" rel="noopener noreferrer" title="${this.escapeHtml(post.caption || '')}">
        <img src="${this.escapeHtml(post.media_url)}" alt="" loading="lazy" />
      </a>`,
      )
      .join('');

    this.container.innerHTML = `
      <a href="${INSTAGRAM_PROFILE_URL}" target="_blank" rel="noopener noreferrer" class="ig-compact-header">
        ${this.instagramIconSvg()}
        <span>Instagram</span>
      </a>
      <div class="ig-compact-row">${postsHtml}</div>
    `;
  }

  renderPost(post) {
    const { media_url, permalink, caption } = post;
    return `
      <a class="ig-post" href="${this.escapeHtml(permalink)}" target="_blank" rel="noopener noreferrer" title="${this.escapeHtml(caption || '')}">
        <img src="${this.escapeHtml(media_url)}" alt="" loading="lazy" />
      </a>
    `;
  }

  renderEmpty() {
    this.container.innerHTML = `
      <div class="ig-feed-empty">
        <p>Brak postów do wyświetlenia.</p>
      </div>
    `;
  }

  renderError() {
    this.container.innerHTML = `
      <div class="ig-feed-error">
        <p>Nie udało się załadować postów z Instagrama.</p>
      </div>
    `;
  }

  instagramIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37Z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>';
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }
}

// Auto-initialize the sidebar Instagram feed - skipped on mobile, where the sidebar itself is
// hidden (see .content-right in style.css) and facebook-feed.js instead mounts a compact
// instance of this same class inline between Facebook posts.
document.addEventListener('DOMContentLoaded', () => {
  const feedContainer = document.getElementById('instagram-feed');
  if (feedContainer && !window.matchMedia('(max-width: 768px)').matches) {
    const backendUrl = feedContainer.dataset.backendUrl;
    const feed = new InstagramFeed('instagram-feed', backendUrl ? { backendUrl } : {});
    feed.load();
  }
});

// Export for manual use
window.InstagramFeed = InstagramFeed;
