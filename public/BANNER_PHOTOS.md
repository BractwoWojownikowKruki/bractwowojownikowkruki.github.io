# Banner Photos Guide

## Location
Place photos in `/public/banner-photos/` directory.

## Requirements
- **Format:** JPG, PNG, WebP
- **Dimensions:** Recommended 1920x600px or similar wide aspect ratio
- **Naming:** Any name works (carousel loads alphabetically, displays randomly)
- **Size:** Keep under 500KB each for good performance

## How It Works
- Photos are loaded dynamically from the folder (no hardcoding names)
- Carousel rotates every 5 seconds
- Order on screen is random each page load
- All JPG, PNG, WebP files are included automatically

## Example
```
banner-photos/
├── photo1.jpg
├── photo2.png
├── event-2024.jpg
└── gathering.webp
```
