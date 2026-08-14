/**
 * Social media integration - Instagram and Facebook API clients with caching
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

// In-memory cache for posts (6 hours TTL)
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, CacheEntry<SocialMediaPosts>>();

function getCachedPosts(key: string): SocialMediaPosts | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedPosts(key: string, data: SocialMediaPosts): void {
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Fetch posts from Instagram Graph API
 * Requires: INSTAGRAM_ACCESS_TOKEN env var
 */
async function fetchInstagramPosts(userId: string = 'kruki.brotherhood'): Promise<SocialMediaPosts> {
  const cacheKey = `instagram:${userId}`;
  const cached = getCachedPosts(cacheKey);
  if (cached) return cached;

  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    throw new Error('INSTAGRAM_ACCESS_TOKEN not configured');
  }

  try {
    // Get Instagram Business Account ID from username
    const userResponse = await fetch(
      `https://graph.instagram.com/ig_hashtag_search?user_id=${userId}&fields=id&access_token=${token}`
    );

    if (!userResponse.ok) {
      throw new Error(`Instagram API error: ${userResponse.status}`);
    }

    // Get media from account
    const mediaResponse = await fetch(
      `https://graph.instagram.com/${userId}/media?fields=id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count&access_token=${token}`
    );

    if (!mediaResponse.ok) {
      throw new Error(`Instagram media fetch failed: ${mediaResponse.status}`);
    }

    const mediaData = await mediaResponse.json();
    const posts: Post[] = (mediaData.data || []).map((item: any) => ({
      id: item.id,
      caption: item.caption || '',
      media_type: item.media_type || 'IMAGE',
      media_url: item.media_url || '',
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

    setCachedPosts(cacheKey, result);
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
  const cached = getCachedPosts(cacheKey);
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
    const feedResponse = await fetch(
      `https://graph.facebook.com/v18.0/me/posts?fields=id,message,created_time,full_picture,permalink_url&access_token=${token}`
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
      }));

    const result: SocialMediaPosts = {
      posts,
      source: 'facebook',
      lastUpdated: new Date().toISOString(),
    };

    setCachedPosts(cacheKey, result);
    return result;
  } catch (error) {
    console.error('Facebook fetch error:', error);
    throw error;
  }
}

// Drops every cached Instagram/Facebook response so the next request for either refetches
// live from the source API, instead of waiting out the 6h TTL.
function clearSocialMediaCache(): void {
  cache.clear();
}

export { fetchInstagramPosts, fetchFacebookPosts, clearSocialMediaCache, SocialMediaPosts };
