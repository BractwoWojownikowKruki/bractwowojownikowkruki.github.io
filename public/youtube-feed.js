/**
 * YouTube Feed Widget
 * Displays the channel's latest uploads (thumbnail, title, duration, relative date)
 */

class YouTubeFeed {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.backendUrl = options.backendUrl || 'https://krucze-galery-upload-x6mr6ilyha-ew.a.run.app';
    // Compact mode: a single scrollable row of small thumbnails, no title/date/"see more"
    // chrome - used when this widget is inlined between Facebook posts on mobile instead of
    // shown in the (now hidden-on-mobile) sidebar.
    this.compact = options.compact || false;
  }

  async load() {
    if (!this.container) {
      console.warn(`YouTube feed container not found: ${containerId}`);
      return;
    }

    try {
      const response = await fetch(`${this.backendUrl}/youtube-videos`);
      if (!response.ok) throw new Error(`Failed to fetch videos: ${response.status}`);

      const data = await response.json();
      this.render(data);
    } catch (error) {
      console.error('YouTube feed error:', error);
      this.renderError();
    }
  }

  render(data) {
    const { channelTitle, channelUrl, videos } = data;

    if (!videos || !videos.length) {
      this.renderEmpty();
      return;
    }

    if (this.compact) {
      this.renderCompact(channelUrl, videos);
      return;
    }

    const videosHtml = videos.map(video => this.renderVideo(video)).join('');
    const safeChannelUrl = this.escapeHtml(channelUrl);

    this.container.innerHTML = `
      <a href="${safeChannelUrl}" target="_blank" rel="noopener noreferrer" class="yt-header">
        ${this.youtubeIconSvg()}
        <span>${this.escapeHtml(channelTitle || 'YouTube')}</span>
      </a>
      <div class="yt-videos-grid">${videosHtml}</div>
      <a href="${safeChannelUrl}" target="_blank" rel="noopener noreferrer" class="yt-more-link">
        Zobacz więcej na YouTube
      </a>
    `;
  }

  renderCompact(channelUrl, videos) {
    const safeChannelUrl = this.escapeHtml(channelUrl);
    const videosHtml = videos.slice(0, 3).map(video => this.renderCompactVideo(video)).join('');

    this.container.innerHTML = `
      <a href="${safeChannelUrl}" target="_blank" rel="noopener noreferrer" class="yt-compact-header">
        ${this.youtubeIconSvg()}
        <span>YouTube</span>
      </a>
      <div class="yt-compact-row">${videosHtml}</div>
    `;
  }

  renderCompactVideo(video) {
    const { thumbnail, url, duration, title } = video;
    return `
      <a class="yt-compact-post" href="${this.escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${this.escapeHtml(title)}">
        <div class="yt-compact-thumb">
          <img src="${this.escapeHtml(thumbnail)}" alt="" loading="lazy" />
          ${duration ? `<span class="yt-video-duration">${this.escapeHtml(duration)}</span>` : ''}
        </div>
      </a>
    `;
  }

  renderVideo(video) {
    const { title, thumbnail, url, duration, publishedAt } = video;
    const safeUrl = this.escapeHtml(url);

    return `
      <a class="yt-video" href="${safeUrl}" target="_blank" rel="noopener noreferrer">
        <div class="yt-video-thumb">
          <img src="${this.escapeHtml(thumbnail)}" alt="" loading="lazy" />
          ${duration ? `<span class="yt-video-duration">${this.escapeHtml(duration)}</span>` : ''}
        </div>
        <div class="yt-video-info">
          <p class="yt-video-title">${this.escapeHtml(title)}</p>
          <p class="yt-video-date">${this.escapeHtml(this.relativeDate(publishedAt))}</p>
        </div>
      </a>
    `;
  }

  relativeDate(iso) {
    const diffDays = Math.floor((Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays <= 0) return 'dzisiaj';
    if (diffDays === 1) return 'wczoraj';
    if (diffDays < 30) return `${diffDays} dni temu`;
    const diffMonths = Math.floor(diffDays / 30);
    if (diffMonths < 12) return `${diffMonths} mies. temu`;
    return `${Math.floor(diffMonths / 12)} lat temu`;
  }

  renderEmpty() {
    this.container.innerHTML = `
      <div class="yt-feed-empty">
        <p>Brak filmów do wyświetlenia.</p>
      </div>
    `;
  }

  renderError() {
    this.container.innerHTML = `
      <div class="yt-feed-error">
        <p>Nie udało się załadować filmów z YouTube.</p>
      </div>
    `;
  }

  youtubeIconSvg() {
    return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.5 12 3.5 12 3.5s-7.5 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.6 9.4.6 9.4.6s7.5 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4L15.8 12Z"/></svg>';
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text ?? '';
    return div.innerHTML;
  }
}

// Auto-initialize the sidebar YouTube feed - skipped on mobile, where the sidebar itself is
// hidden (see .content-right in style.css) and facebook-feed.js instead mounts a compact
// instance of this same class inline between Facebook posts.
document.addEventListener('DOMContentLoaded', () => {
  const feedContainer = document.getElementById('youtube-feed');
  if (feedContainer && !window.matchMedia('(max-width: 768px)').matches) {
    const backendUrl = feedContainer.dataset.backendUrl;
    const feed = new YouTubeFeed('youtube-feed', backendUrl ? { backendUrl } : {});
    feed.load();
  }
});

// Export for manual use
window.YouTubeFeed = YouTubeFeed;
