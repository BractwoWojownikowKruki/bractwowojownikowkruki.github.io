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

    const postsHtml = posts
      .slice(0, this.postsLimit)
      .map(post => this.renderPost(post))
      .join('');

    this.container.innerHTML = `<div class="fb-posts-grid">${postsHtml}</div>`;
  }

  renderPost(post) {
    const { caption, media_url, permalink, timestamp } = post;
    const date = new Date(timestamp);
    const dateStr = date.toLocaleDateString('pl-PL', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    return `
      <article class="fb-post">
        <a href="${this.escapeHtml(permalink)}" target="_blank" rel="noopener noreferrer" class="fb-post-date">
          ${this.escapeHtml(dateStr)}
        </a>
        ${media_url ? `
          <div class="fb-post-media">
            <img src="${this.escapeHtml(media_url)}" alt="Post" loading="lazy" />
          </div>
        ` : ''}
        <div class="fb-post-content">
          <p>${this.escapeHtml(caption)}</p>
        </div>
      </article>
    `;
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
