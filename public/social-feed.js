/**
 * Social Media Feed Widget
 * Displays Instagram and Facebook posts
 */

class SocialMediaFeed {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.source = options.source || 'instagram'; // 'instagram' or 'facebook'
    this.backendUrl = options.backendUrl || 'https://upload.kruki.org'; // Set based on deployment
    this.maxPosts = options.maxPosts || 6;
    this.loadingClass = options.loadingClass || 'loading';
  }

  async load() {
    if (!this.container) {
      console.warn(`Social feed container not found: ${this.containerId}`);
      return;
    }

    this.container.classList.add(this.loadingClass);
    try {
      const endpoint = this.source === 'instagram' ? '/instagram-posts' : '/facebook-posts';
      const response = await fetch(`${this.backendUrl}${endpoint}`);

      if (!response.ok) {
        throw new Error(`Failed to fetch posts: ${response.status}`);
      }

      const data = await response.json();
      this.render(data);
    } catch (error) {
      console.error('Social feed error:', error);
      this.renderError(error.message);
    } finally {
      this.container.classList.remove(this.loadingClass);
    }
  }

  render(data) {
    const posts = (data.posts || []).slice(0, this.maxPosts);

    if (!posts.length) {
      this.renderEmpty();
      return;
    }

    const html = posts
      .map(post => this.renderPost(post))
      .join('');

    this.container.innerHTML = `
      <div class="social-feed" data-source="${this.source}">
        ${html}
      </div>
    `;
  }

  renderPost(post) {
    const {caption, media_url, permalink, timestamp} = post;
    const date = new Date(timestamp).toLocaleDateString('pl-PL');

    return `
      <article class="social-post">
        <a href="${permalink}" target="_blank" rel="noopener noreferrer" class="social-post-link">
          ${media_url ? `<img src="${media_url}" alt="${caption || 'Post'}" loading="lazy" />` : ''}
          <div class="social-post-caption">
            <p>${this.truncate(caption, 100)}</p>
            <time>${date}</time>
          </div>
        </a>
      </article>
    `;
  }

  renderEmpty() {
    this.container.innerHTML = `
      <div class="social-feed-empty">
        <p>Brak postów do wyświetlenia.</p>
      </div>
    `;
  }

  renderError(message) {
    this.container.innerHTML = `
      <div class="social-feed-error">
        <p>Nie udało się załadować postów.</p>
      </div>
    `;
  }

  truncate(text, length) {
    if (!text) return '';
    return text.length > length ? text.substring(0, length) + '...' : text;
  }
}

// Auto-initialize feeds with data-attributes
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-social-feed]').forEach(el => {
    const source = el.dataset.socialFeed;
    const backendUrl = el.dataset.backendUrl || 'https://upload.kruki.org';
    const maxPosts = parseInt(el.dataset.maxPosts || '6');

    const feed = new SocialMediaFeed(el.id, {
      source,
      backendUrl,
      maxPosts
    });
    feed.load();
  });
});

// Export for manual use
window.SocialMediaFeed = SocialMediaFeed;
