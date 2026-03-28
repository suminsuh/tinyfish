import { normalizePublicUrl, uniqueStrings } from "@/lib/attendee-utils";
import type { PublicProfileSource } from "@/lib/types";

type LumaPublicUser = {
  api_id?: string;
  avatar_url?: string | null;
  bio_short?: string | null;
  first_name?: string | null;
  instagram_handle?: string | null;
  last_name?: string | null;
  linkedin_handle?: string | null;
  name?: string | null;
  tiktok_handle?: string | null;
  twitter_handle?: string | null;
  username?: string | null;
  website?: string | null;
  youtube_handle?: string | null;
};

export type LumaProfileEnrichment = {
  publicProfileUrls: string[];
  source: PublicProfileSource;
};

export async function scrapeLumaPublicProfile(profileUrl: string): Promise<LumaProfileEnrichment | null> {
  const normalizedUrl = normalizePublicUrl(profileUrl);

  if (!normalizedUrl) {
    return null;
  }

  const response = await fetch(normalizedUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Luma profile request failed (${response.status}).`);
  }

  const html = await response.text();
  const nextData = extractNextData(html);
  const user = readPublicUser(nextData);

  if (!user) {
    return null;
  }

  const bio = user.bio_short?.trim() || undefined;

  return {
    publicProfileUrls: uniqueStrings([
      normalizedUrl,
      buildLumaUserUrl(user),
      buildLinkedInUrl(user.linkedin_handle),
      buildInstagramUrl(user.instagram_handle),
      buildXUrl(user.twitter_handle),
      buildTikTokUrl(user.tiktok_handle),
      buildYouTubeUrl(user.youtube_handle),
      normalizePublicUrl(user.website || ""),
    ]),
    source: {
      url: normalizedUrl,
      platform: "luma",
      headline: bio,
      bio,
      interests: extractKeywordHints(bio),
      goals: [],
      education: [],
      profileImageUrl: user.avatar_url || undefined,
    },
  };
}

function extractNextData(html: string): Record<string, unknown> {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error("Luma profile page did not include __NEXT_DATA__.");
  }

  return JSON.parse(match[1]) as Record<string, unknown>;
}

function readPublicUser(nextData: Record<string, unknown>): LumaPublicUser | null {
  const props = toObject(nextData.props);
  const pageProps = toObject(props.pageProps);
  const initialData = toObject(pageProps.initialData);
  const user = toObject(initialData.user);

  if (Object.keys(user).length === 0) {
    return null;
  }

  return user as LumaPublicUser;
}

function buildLumaUserUrl(source: LumaPublicUser): string | undefined {
  const handle = source.username?.trim() || source.api_id?.trim();
  return handle ? `https://luma.com/user/${handle}` : undefined;
}

function buildLinkedInUrl(handle?: string | null): string | undefined {
  if (!handle?.trim()) {
    return undefined;
  }

  if (/^https?:\/\//i.test(handle)) {
    return normalizePublicUrl(handle);
  }

  return normalizePublicUrl(`https://www.linkedin.com${handle.startsWith("/") ? handle : `/${handle}`}`);
}

function buildInstagramUrl(handle?: string | null): string | undefined {
  const normalizedHandle = stripHandlePrefix(handle);
  return normalizedHandle ? normalizePublicUrl(`https://www.instagram.com/${normalizedHandle}/`) : undefined;
}

function buildXUrl(handle?: string | null): string | undefined {
  const normalizedHandle = stripHandlePrefix(handle);
  return normalizedHandle ? normalizePublicUrl(`https://x.com/${normalizedHandle}`) : undefined;
}

function buildTikTokUrl(handle?: string | null): string | undefined {
  const normalizedHandle = stripHandlePrefix(handle);
  return normalizedHandle ? normalizePublicUrl(`https://www.tiktok.com/@${normalizedHandle}`) : undefined;
}

function buildYouTubeUrl(handle?: string | null): string | undefined {
  if (!handle?.trim()) {
    return undefined;
  }

  if (/^https?:\/\//i.test(handle)) {
    return normalizePublicUrl(handle);
  }

  const normalizedHandle = handle.startsWith("@") ? handle : `@${handle}`;
  return normalizePublicUrl(`https://www.youtube.com/${normalizedHandle}`);
}

function stripHandlePrefix(handle?: string | null): string | undefined {
  const trimmed = handle?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/^@/, "").replace(/^https?:\/\/(www\.)?[^/]+\//i, "").replace(/\/+$/, "");
}

function extractKeywordHints(bioShort?: string): string[] {
  if (!bioShort) {
    return [];
  }

  return uniqueStrings(
    bioShort
      .split(/[|,;/]+/g)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 1 && entry.length <= 40),
  );
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
