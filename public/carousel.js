/**
 * Banner Carousel
 * Dynamically loads images from banner-photos.json, randomizes order, auto-rotates.
 */
class BannerCarousel {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.images = [];
    this.currentIndex = 0;
    this.autoRotateInterval = null;
    this.ROTATE_INTERVAL_MS = 5000;
  }

  /**
   * Fetch list of images from banner-photos.json
   */
  async loadImages() {
    try {
      const response = await fetch('/banner-photos.json');
      if (!response.ok) throw new Error('Failed to fetch photo list');
      const data = await response.json();
      this.images = data.files || [];
      this.randomizeOrder();
      if (this.images.length > 0) {
        this.render();
        this.startAutoRotate();
      }
    } catch (error) {
      console.error('Error loading carousel images:', error);
      console.info('To add banner photos: 1) place images in /banner-photos/ 2) update /banner-photos.json');
    }
  }

  /**
   * Randomize image order using Fisher-Yates shuffle
   */
  randomizeOrder() {
    for (let i = this.images.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.images[i], this.images[j]] = [this.images[j], this.images[i]];
    }
  }

  /**
   * Render current image in carousel
   */
  render() {
    if (this.images.length === 0) return;

    const currentImage = this.images[this.currentIndex];
    this.container.innerHTML = '';

    const img = document.createElement('img');
    img.src = `/banner-photos/${currentImage}`;
    img.alt = 'Banner photo';
    img.className = 'carousel-image';

    this.container.appendChild(img);

    // Add navigation if multiple images
    if (this.images.length > 1) {
      this.addNavigation();
    }
  }

  /**
   * Add prev/next navigation buttons
   */
  addNavigation() {
    const nav = document.createElement('div');
    nav.className = 'carousel-nav';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'carousel-btn carousel-btn--prev';
    prevBtn.setAttribute('aria-label', 'Poprzednie zdjęcie');
    prevBtn.innerHTML = '❮';
    prevBtn.addEventListener('click', () => this.prev());

    const nextBtn = document.createElement('button');
    nextBtn.className = 'carousel-btn carousel-btn--next';
    nextBtn.setAttribute('aria-label', 'Następne zdjęcie');
    nextBtn.innerHTML = '❯';
    nextBtn.addEventListener('click', () => this.next());

    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    this.container.appendChild(nav);
  }

  /**
   * Show next image
   */
  next() {
    this.currentIndex = (this.currentIndex + 1) % this.images.length;
    this.resetAutoRotate();
    this.render();
  }

  /**
   * Show previous image
   */
  prev() {
    this.currentIndex = (this.currentIndex - 1 + this.images.length) % this.images.length;
    this.resetAutoRotate();
    this.render();
  }

  /**
   * Auto-rotate carousel every 5 seconds
   */
  startAutoRotate() {
    this.autoRotateInterval = setInterval(() => {
      this.next();
    }, this.ROTATE_INTERVAL_MS);
  }

  /**
   * Reset auto-rotate timer (when user manually navigates)
   */
  resetAutoRotate() {
    clearInterval(this.autoRotateInterval);
    this.startAutoRotate();
  }

  /**
   * Stop carousel
   */
  stop() {
    clearInterval(this.autoRotateInterval);
  }
}

// Initialize carousel when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const carousel = new BannerCarousel('banner-carousel');
  carousel.loadImages();
});
