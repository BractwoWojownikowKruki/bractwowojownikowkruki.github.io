/**
 * Social media integration - Instagram, Facebook, and YouTube API clients with caching
 */

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

interface Post {
  id: string;
  caption: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL';
  media_url: string;
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

interface SocialMediaPosts {
  posts: Post[];
  source: 'instagram' | 'facebook';
  lastUpdated: string;
}

// In-memory cache (6 hours TTL), shared across every fetch* function below regardless of
// what shape they cache - keyed by a per-source string (e.g. "facebook:me", "youtube:channel")
// so clearSocialMediaCache() can drop everything in one call.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCached<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Fetch posts from the Instagram Business account linked to the club's Facebook Page.
 * Requires: FACEBOOK_PAGE_ACCESS_TOKEN env var - the same Page Access Token fetchFacebookPosts
 * uses, not a separate Instagram credential. Deliberately not the "Instagram API with
 * Instagram Login" flow (graph.instagram.com + its own Instagram User Access Token) - that
 * needs its own app product, its own OAuth popup, and its own long-lived-token exchange/renewal,
 * none of which is worth it when the classic Instagram Graph API already gets there through
 * infrastructure this app has working: the Page token can read whatever Instagram professional
 * account is linked to the Page (Meta Business Suite confirmed @kruki.brotherhood is linked to
 * "Bractwo Wojowników KRUKI"), via graph.facebook.com like every other Page-scoped call here.
 */
async function fetchInstagramPosts(): Promise<SocialMediaPosts> {
  const cacheKey = 'instagram:page-linked';
  const cached = getCached<SocialMediaPosts>(cacheKey);
  if (cached) return cached;

  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error('FACEBOOK_PAGE_ACCESS_TOKEN not configured');
  }

  try {
    // 'me' resolves to the page the token was issued for (same reasoning as
    // fetchFacebookPosts) - instagram_business_account is that page's linked IG account, absent
    // entirely from the response if nothing is linked.
    const pageResponse = await fetch(
      `https://graph.facebook.com/v18.0/me?fields=instagram_business_account&access_token=${token}`
    );

    if (!pageResponse.ok) {
      const errorBody = await pageResponse.text();
      throw new Error(`Facebook page lookup error: ${pageResponse.status} - ${errorBody}`);
    }

    const pageData = await pageResponse.json();
    const igUserId = pageData.instagram_business_account?.id;
    if (!igUserId) {
      throw new Error('No Instagram Business Account linked to this Facebook Page');
    }

    // thumbnail_url is only populated for VIDEO items - media_url for a video is the raw video
    // file, not something an <img> tag can render, so the frontend needs the thumbnail instead.
    const mediaResponse = await fetch(
      `https://graph.facebook.com/v18.0/${igUserId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&access_token=${token}`
    );

    if (!mediaResponse.ok) {
      const errorBody = await mediaResponse.text();
      throw new Error(`Instagram media fetch failed: ${mediaResponse.status} - ${errorBody}`);
    }

    const mediaData = await mediaResponse.json();
    const posts: Post[] = (mediaData.data || []).map((item: any) => ({
      id: item.id,
      caption: item.caption || '',
      media_type: item.media_type === 'CAROUSEL_ALBUM' ? 'CAROUSEL' : item.media_type || 'IMAGE',
      media_url: (item.media_type === 'VIDEO' ? item.thumbnail_url : item.media_url) || '',
      permalink: item.permalink || `https://instagram.com/p/${item.id}`,
      timestamp: item.timestamp || new Date().toISOString(),
      like_count: item.like_count,
      comments_count: item.comments_count,
    }));

    const result: SocialMediaPosts = {
      posts,
      source: 'instagram',
      lastUpdated: new Date().toISOString(),
    };

    setCached(cacheKey, result);
    return result;
  } catch (error) {
    console.error('Instagram fetch error:', error);
    throw error;
  }
}

/**
 * Fetch posts from Facebook Graph API (from page)
 * Requires: FACEBOOK_PAGE_ACCESS_TOKEN env var - a Page Access Token, not a user token.
 * Uses the 'me' alias rather than a hardcoded page id/username: for a Page Access Token,
 * Facebook resolves 'me' to the page the token was issued for, so this needs no
 * configuration and can't drift out of sync with the actual page (an earlier version
 * hardcoded 'kruki.brotherhood', which is this club's Instagram handle, not its Facebook
 * page - https://www.facebook.com/bractwo.kruki/ - and so would have 404'd).
 */
async function fetchFacebookPosts(): Promise<SocialMediaPosts> {
  const cacheKey = 'facebook:me';
  const cached = getCached<SocialMediaPosts>(cacheKey);
  if (cached) return cached;

  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error('FACEBOOK_PAGE_ACCESS_TOKEN not configured');
  }

  try {
    // full_picture/permalink_url replace the older aggregated picture/link/type fields, which
    // Facebook deprecated in v3.3 (error #12, deprecate_post_aggregated_fields_for_attachement) -
    // this API is on v18.0. permalink_url is also the semantically correct field for "link to
    // this post on Facebook" (the spec's requirement) - the old 'link' field returned an
    // external URL the post happened to share, not a link back to the post itself.
    //
    // likes/comments use .limit(0) alongside .summary(true): without it, Facebook also fetches
    // the actual like/comment objects (just to discard them, since only the summary is read
    // below), which counts against a per-request complexity budget - observed in practice to
    // silently shrink /me/posts from its normal ~10-25 items down to just 1. .limit(0) asks for
    // the count only, which is cheap regardless of how many likes/comments a post has.
    const feedResponse = await fetch(
      `https://graph.facebook.com/v18.0/me/posts?fields=id,message,created_time,full_picture,permalink_url,likes.limit(0).summary(true),comments.limit(0).summary(true)&limit=25&access_token=${token}`
    );

    if (!feedResponse.ok) {
      const errorBody = await feedResponse.text();
      throw new Error(`Facebook API error: ${feedResponse.status} - ${errorBody}`);
    }

    const feedData = await feedResponse.json();
    const posts: Post[] = (feedData.data || [])
      .filter((item: any) => Boolean(item.message))
      .map((item: any) => ({
        id: item.id,
        caption: item.message || '',
        media_type: 'IMAGE' as const,
        media_url: item.full_picture || '',
        permalink: item.permalink_url || `https://facebook.com/${item.id}`,
        timestamp: item.created_time || new Date().toISOString(),
        like_count: item.likes?.summary?.total_count ?? 0,
        comments_count: item.comments?.summary?.total_count ?? 0,
      }));

    const result: SocialMediaPosts = {
      posts,
      source: 'facebook',
      lastUpdated: new Date().toISOString(),
    };

    setCached(cacheKey, result);
    return result;
  } catch (error) {
    console.error('Facebook fetch error:', error);
    throw error;
  }
}

interface YouTubeVideo {
  id: string;
  title: string;
  thumbnail: string;
  publishedAt: string;
  duration: string;
  url: string;
}

interface YouTubeChannelData {
  channelTitle: string;
  channelThumbnail: string;
  channelUrl: string;
  videos: YouTubeVideo[];
  lastUpdated: string;
}

// This club's channel handle - public, stable branding info (same as the Facebook page URL
// already hardcoded in the footer links), not a secret, so no env var needed for it.
const YOUTUBE_CHANNEL_HANDLE = '@bractwowojownikowkruki4188';

// "PT1H2M3S" -> "1:02:03"; "PT4M13S" -> "4:13"; "PT45S" -> "0:45".
export function parseIso8601Duration(iso: string): string {
  const match = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return '0:00';
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * Fetch the channel's latest uploads from the YouTube Data API v3.
 * Requires: YOUTUBE_API_KEY env var - a plain API key (Google Cloud Console > Credentials),
 * not OAuth - the channel's public data doesn't need a user/page token like Facebook does.
 *
 * Three calls, all cheap and cached together as one unit:
 *  1. channels.list(forHandle=...) - resolves the handle to channel id + display name/thumbnail
 *     + its "uploads" playlist id, in one request (avoids hardcoding a raw channel id anywhere)
 *  2. playlistItems.list(playlistId=uploads) - the actual latest videos, cheapest way to list a
 *     channel's uploads (vs. search.list, which costs far more quota for the same result)
 *  3. videos.list(id=...) - playlistItems doesn't include duration, so a second call fetches
 *     contentDetails.duration for exactly the video ids just listed
 */
async function fetchYouTubeVideos(): Promise<YouTubeChannelData> {
  const cacheKey = 'youtube:channel';
  const cached = getCached<YouTubeChannelData>(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error('YOUTUBE_API_KEY not configured');
  }

  try {
    const channelResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&forHandle=${encodeURIComponent(YOUTUBE_CHANNEL_HANDLE)}&key=${apiKey}`
    );
    if (!channelResponse.ok) {
      const errorBody = await channelResponse.text();
      throw new Error(`YouTube channel lookup error: ${channelResponse.status} - ${errorBody}`);
    }
    const channelData = await channelResponse.json();
    const channel = channelData.items?.[0];
    if (!channel) {
      throw new Error(`YouTube channel not found for handle ${YOUTUBE_CHANNEL_HANDLE}`);
    }
    const uploadsPlaylistId = channel.contentDetails.relatedPlaylists.uploads;

    const playlistResponse = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=4&key=${apiKey}`
    );
    if (!playlistResponse.ok) {
      const errorBody = await playlistResponse.text();
      throw new Error(`YouTube playlist items error: ${playlistResponse.status} - ${errorBody}`);
    }
    const playlistData = await playlistResponse.json();
    const items = (playlistData.items || []) as any[];
    const videoIds = items.map(item => item.snippet.resourceId.videoId).filter(Boolean);

    let durations: Record<string, string> = {};
    if (videoIds.length > 0) {
      const videosResponse = await fetch(
        `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoIds.join(',')}&key=${apiKey}`
      );
      if (videosResponse.ok) {
        const videosData = await videosResponse.json();
        durations = Object.fromEntries(
          (videosData.items || []).map((v: any) => [v.id, parseIso8601Duration(v.contentDetails.duration)]),
        );
      }
      // A failed durations lookup isn't fatal - videos just render without a duration badge.
    }

    const videos: YouTubeVideo[] = items.map(item => {
      const videoId = item.snippet.resourceId.videoId;
      return {
        id: videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
        publishedAt: item.snippet.publishedAt,
        duration: durations[videoId] || '',
        url: `https://www.youtube.com/watch?v=${videoId}`,
      };
    });

    const result: YouTubeChannelData = {
      channelTitle: channel.snippet.title,
      channelThumbnail: channel.snippet.thumbnails?.default?.url || '',
      channelUrl: `https://www.youtube.com/${YOUTUBE_CHANNEL_HANDLE}`,
      videos,
      lastUpdated: new Date().toISOString(),
    };

    setCached(cacheKey, result);
    return result;
  } catch (error) {
    console.error('YouTube fetch error:', error);
    throw error;
  }
}

// Drops every cached Instagram/Facebook/YouTube response so the next request for any of them
// refetches live from the source API, instead of waiting out the 6h TTL.
function clearSocialMediaCache(): void {
  cache.clear();
}

export {
  fetchInstagramPosts,
  fetchFacebookPosts,
  fetchYouTubeVideos,
  clearSocialMediaCache,
  SocialMediaPosts,
  YouTubeChannelData,
};
