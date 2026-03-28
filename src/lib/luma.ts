import { calculateProfileRichness, normalizePublicUrl, uniqueStrings } from "@/lib/attendee-utils";
import { scrapeManagedLumaEventAttendees } from "@/lib/luma-api";
import { extractTinyFishObject, runTinyFishAutomation } from "@/lib/tinyfish";
import type { AttendeeProfile } from "@/lib/types";

export type LumaScrapeResult = {
  eventTitle?: string;
  attendees: AttendeeProfile[];
  warnings: string[];
  accessMode: "managed-api" | "public-html" | "tinyfish-browser";
};

type LumaInitialData = {
  event?: {
    name?: string;
    show_guest_list?: boolean;
    url?: string;
  };
  guest_count?: number;
  featured_guests?: LumaPublicGuest[];
};

type LumaPublicGuest = {
  api_id?: string;
  avatar_url?: string | null;
  bio_short?: string | null;
  first_name?: string | null;
  instagram_handle?: string | null;
  is_verified?: boolean;
  last_name?: string | null;
  linkedin_handle?: string | null;
  name?: string | null;
  tiktok_handle?: string | null;
  timezone?: string | null;
  twitter_handle?: string | null;
  username?: string | null;
  website?: string | null;
  youtube_handle?: string | null;
};

export async function scrapeLumaEventAttendees(eventUrl: string, attendeeLimit: number): Promise<LumaScrapeResult> {
  const warnings: string[] = [];

  const managedResult = await scrapeManagedLumaEventAttendees(eventUrl, attendeeLimit);
  if (managedResult?.attendees.length) {
    return managedResult;
  }
  if (managedResult?.warnings.length) {
    warnings.push(...managedResult.warnings);
  }

  try {
    const parsedResult = await scrapeLumaHtml(eventUrl, attendeeLimit);
    if (parsedResult.attendees.length > 0) {
      return {
        ...parsedResult,
        warnings: [...warnings, ...parsedResult.warnings].slice(0, 10),
      };
    }
    warnings.push("The public Luma HTML did not expose attendee profiles, so TinyFish browser fallback was used.");
  } catch (error) {
    warnings.push(`Direct Luma parsing fell back to TinyFish: ${formatError(error)}`);
  }

  const fallbackResult = await scrapeVisibleGuestsWithTinyFish(eventUrl, attendeeLimit);

  return {
    eventTitle: fallbackResult.eventTitle,
    attendees: fallbackResult.attendees,
    warnings: [...warnings, ...fallbackResult.warnings].slice(0, 10),
    accessMode: fallbackResult.accessMode,
  };
}

async function scrapeLumaHtml(eventUrl: string, attendeeLimit: number): Promise<LumaScrapeResult> {
  const response = await fetch(eventUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`Luma page request failed (${response.status}).`);
  }

  const html = await response.text();
  const nextData = extractNextData(html);
  const initialData = readInitialData(nextData);
  const eventTitle = initialData.event?.name?.trim();
  const featuredGuests = Array.isArray(initialData.featured_guests) ? initialData.featured_guests : [];
  const attendees = featuredGuests
    .map((guest, index) => normalizeLumaGuest(guest, index))
    .filter((attendee): attendee is AttendeeProfile => Boolean(attendee))
    .slice(0, attendeeLimit);

  const warnings: string[] = [];
  if (featuredGuests.length > 0 && initialData.guest_count && initialData.guest_count > featuredGuests.length) {
    warnings.push(
      `Luma exposed ${featuredGuests.length} featured public guests in the page HTML out of ${initialData.guest_count} total guests.`,
    );
  }

  if (featuredGuests.length === 0 && initialData.event?.show_guest_list === false) {
    warnings.push("This Luma event does not expose a public guest list in the page HTML.");
  }

  return {
    eventTitle,
    attendees,
    warnings,
    accessMode: "public-html",
  };
}

async function scrapeVisibleGuestsWithTinyFish(eventUrl: string, attendeeLimit: number): Promise<LumaScrapeResult> {
  const result = await runTinyFishAutomation({
    url: eventUrl,
    goal: buildVisibleGuestGoal(attendeeLimit),
    browserProfile: "stealth",
  });

  const objectResult = extractTinyFishObject(result);
  const eventTitle = readString(objectResult, ["eventTitle", "title", "name"]);
  const attendees = readObjectList(objectResult, ["attendees", "guests", "participants", "featuredGuests"])
    .map((guest, index) => normalizeTinyFishGuest(guest, index))
    .filter((attendee): attendee is AttendeeProfile => Boolean(attendee))
    .slice(0, attendeeLimit);
  const warnings = readStringList(objectResult, ["warnings"]).slice(0, 5);

  return {
    eventTitle,
    attendees,
    warnings,
    accessMode: "tinyfish-browser",
  };
}

function buildVisibleGuestGoal(attendeeLimit: number): string {
  return [
    "Visit this public Luma event page and return JSON only.",
    "Extract only the public attendee or guest cards that are already visible on the page.",
    "Do not sign in, do not open hidden attendee flows, and do not wait for long-running interactions.",
    "Return data in this exact shape:",
    "{",
    '  "eventTitle": string | null,',
    '  "attendees": [',
    "    {",
    '      "name": string,',
    '      "headline": string | null,',
    '      "bio": string | null,',
    '      "profileImageUrl": string | null,',
    '      "publicProfileUrls": string[]',
    "    }",
    "  ],",
    '  "warnings": string[]',
    "}",
    `- Return at most ${attendeeLimit} attendees.`,
    "- Only include people whose information is publicly visible.",
    "- Do not include private emails or phone numbers.",
  ].join("\n");
}

function extractNextData(html: string): Record<string, unknown> {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);

  if (!match) {
    throw new Error("Luma page did not include __NEXT_DATA__.");
  }

  return JSON.parse(match[1]) as Record<string, unknown>;
}

function readInitialData(nextData: Record<string, unknown>): LumaInitialData {
  const props = toObject(nextData.props);
  const pageProps = toObject(props.pageProps);
  const initialData = toObject(pageProps.initialData);
  const data = toObject(initialData.data);

  return {
    event: toObject(data.event) as LumaInitialData["event"],
    guest_count: typeof data.guest_count === "number" ? data.guest_count : undefined,
    featured_guests: Array.isArray(data.featured_guests)
      ? data.featured_guests.filter((item): item is LumaPublicGuest => typeof item === "object" && item !== null)
      : [],
  };
}

function normalizeLumaGuest(source: LumaPublicGuest, index: number): AttendeeProfile | null {
  const name = source.name?.trim() || [source.first_name, source.last_name].filter(Boolean).join(" ").trim();

  if (!name) {
    return null;
  }

  const bioShort = source.bio_short?.trim();
  const publicProfileUrls = uniqueStrings([
    buildLumaUserUrl(source),
    buildLinkedInUrl(source.linkedin_handle),
    buildInstagramUrl(source.instagram_handle),
    buildXUrl(source.twitter_handle),
    buildTikTokUrl(source.tiktok_handle),
    buildYouTubeUrl(source.youtube_handle),
    normalizePublicUrl(source.website || ""),
  ]);

  const attendee: AttendeeProfile = {
    id: `attendee-${index + 1}`,
    name,
    title: bioShort || undefined,
    bio: bioShort || undefined,
    interests: extractKeywordHints(bioShort),
    goals: [],
    education: [],
    personalityTraits: source.is_verified ? ["verified"] : [],
    publicProfileUrls,
    consentToEnrich: true,
    profileImageUrl: source.avatar_url || undefined,
    sourceProfiles: [],
    profileRichness: 0,
  };

  attendee.profileRichness = calculateProfileRichness(attendee);
  return attendee;
}

function normalizeTinyFishGuest(source: Record<string, unknown>, index: number): AttendeeProfile | null {
  const name = readString(source, ["name", "fullName"]);

  if (!name) {
    return null;
  }

  const attendee: AttendeeProfile = {
    id: `attendee-${index + 1}`,
    name,
    title: readString(source, ["headline", "title"]),
    bio: readString(source, ["bio", "summary", "about"]),
    interests: readStringList(source, ["interests", "topics"]),
    goals: readStringList(source, ["goals", "networkingGoals"]),
    education: readStringList(source, ["education", "schools"]),
    personalityTraits: readStringList(source, ["personalityTraits", "traits"]),
    publicProfileUrls: uniqueStrings(readStringList(source, ["publicProfileUrls", "links"]).map((url) => normalizePublicUrl(url))),
    consentToEnrich: true,
    profileImageUrl: readString(source, ["profileImageUrl", "image"]),
    sourceProfiles: [],
    profileRichness: 0,
  };

  attendee.profileRichness = calculateProfileRichness(attendee);
  return attendee;
}

function buildLumaUserUrl(source: LumaPublicGuest): string | undefined {
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

function extractKeywordHints(bioShort?: string | null): string[] {
  if (!bioShort) {
    return [];
  }

  const chunks = bioShort
    .split(/[|,;/]+/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 1 && entry.length <= 40);

  return uniqueStrings(chunks);
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function readObjectList(source: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
    }
  }

  return [];
}

function readString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function readStringList(source: Record<string, unknown>, keys: string[]): string[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
    }

    if (typeof value === "string" && value.trim()) {
      return uniqueStrings(value.split(/[;,|\n]+/g));
    }
  }

  return [];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
