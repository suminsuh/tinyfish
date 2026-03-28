import { calculateProfileRichness, normalizePublicUrl, uniqueStrings } from "@/lib/attendee-utils";
import type { AttendeeProfile } from "@/lib/types";

type ManagedEvent = {
  apiId: string;
  name?: string;
  url?: string;
};

type ManagedGuestPage = {
  attendees: AttendeeProfile[];
  nextCursor?: string;
  nextPage?: number;
  hasMore: boolean;
};

const LUMA_API_BASE_URL = (process.env.LUMA_API_BASE_URL || "https://public-api.luma.com").replace(/\/$/, "");

export async function scrapeManagedLumaEventAttendees(
  eventUrl: string,
  attendeeLimit: number,
): Promise<{
  eventTitle?: string;
  attendees: AttendeeProfile[];
  warnings: string[];
  accessMode: "managed-api";
} | null> {
  const apiKey = process.env.LUMA_API_KEY?.trim();

  if (!apiKey) {
    return null;
  }

  const warnings: string[] = [];
  const managedEvent = await lookupManagedEvent(apiKey, eventUrl, warnings);

  if (!managedEvent) {
    warnings.push("`LUMA_API_KEY` was set, but the event could not be resolved through the official Luma API.");
    return {
      eventTitle: undefined,
      attendees: [],
      warnings: uniqueStrings(warnings).slice(0, 10),
      accessMode: "managed-api",
    };
  }

  const attendees = await loadManagedGuests(apiKey, managedEvent, attendeeLimit, warnings);

  if (attendees.length === 0) {
    warnings.push("The official Luma API did not return guests for this event with the current API key.");
  }

  return {
    eventTitle: managedEvent.name,
    attendees,
    warnings: uniqueStrings(warnings).slice(0, 10),
    accessMode: "managed-api",
  };
}

async function lookupManagedEvent(apiKey: string, eventUrl: string, warnings: string[]): Promise<ManagedEvent | null> {
  const canonicalUrl = normalizeLumaEventUrl(eventUrl);
  const slug = extractEventSlug(eventUrl);
  const lookupQueries = [
    { url: canonicalUrl },
    { event_url: canonicalUrl },
    { eventUrl: canonicalUrl },
    slug ? { slug } : null,
    slug ? { event_slug: slug } : null,
  ].filter((value): value is Record<string, string> => Boolean(value));

  for (const query of lookupQueries) {
    try {
      const response = await getLumaJson(apiKey, "/v1/event/lookup-event", query);
      const event = extractManagedEvent(response);
      if (event) {
        return event;
      }
    } catch (error) {
      warnings.push(`Official Luma event lookup failed for ${Object.keys(query)[0]}: ${formatError(error)}`);
    }
  }

  try {
    const response = await getLumaJson(apiKey, "/v1/calendar/list-events", {
      limit: "200",
      page_size: "200",
    });
    const matchedEvent = extractManagedEventList(response).find((event) => eventMatchesUrl(event, eventUrl));
    if (matchedEvent) {
      return matchedEvent;
    }
  } catch (error) {
    warnings.push(`Official Luma list-events fallback failed: ${formatError(error)}`);
  }

  return null;
}

async function loadManagedGuests(
  apiKey: string,
  event: ManagedEvent,
  attendeeLimit: number,
  warnings: string[],
): Promise<AttendeeProfile[]> {
  const attendees: AttendeeProfile[] = [];
  const seenKeys = new Set<string>();
  let cursor: string | undefined;
  let page = 1;

  for (let requestCount = 0; requestCount < 10 && attendees.length < attendeeLimit; requestCount += 1) {
    let guestPage: ManagedGuestPage | null = null;

    try {
      guestPage = await getManagedGuestPage(apiKey, event.apiId, attendees.length, attendeeLimit, cursor, page);
    } catch (error) {
      warnings.push(`Official Luma guest retrieval failed: ${formatError(error)}`);
      break;
    }

    if (!guestPage || guestPage.attendees.length === 0) {
      break;
    }

    guestPage.attendees.forEach((attendee) => {
      const key = attendee.publicProfileUrls[0]?.toLowerCase() || attendee.name.toLowerCase();
      if (seenKeys.has(key) || attendees.length >= attendeeLimit) {
        return;
      }

      seenKeys.add(key);
      attendees.push(attendee);
    });

    if (guestPage.nextCursor && guestPage.nextCursor !== cursor) {
      cursor = guestPage.nextCursor;
      continue;
    }

    if (guestPage.nextPage && guestPage.nextPage > page) {
      page = guestPage.nextPage;
      continue;
    }

    if (guestPage.hasMore) {
      page += 1;
      continue;
    }

    break;
  }

  return attendees;
}

async function getManagedGuestPage(
  apiKey: string,
  eventApiId: string,
  loadedCount: number,
  attendeeLimit: number,
  cursor?: string,
  page = 1,
): Promise<ManagedGuestPage | null> {
  const pageSize = Math.max(1, Math.min(100, attendeeLimit - loadedCount));
  const eventQueries = [
    { event_api_id: eventApiId },
    { eventApiId: eventApiId },
    { api_id: eventApiId },
    { event_id: eventApiId },
    { eventId: eventApiId },
  ];

  for (const query of eventQueries) {
    try {
      const response = await getLumaJson(apiKey, "/v1/event/get-guests", {
        ...query,
        limit: String(pageSize),
        page_size: String(pageSize),
        page: String(page),
        ...(cursor ? { cursor, after: cursor } : {}),
      });

      const attendees = extractManagedGuests(response, loadedCount);
      const nextCursor = readStringDeep(response, ["next_cursor", "nextCursor", "cursor"]);
      const nextPage = readNumberDeep(response, ["next_page", "nextPage"]);
      const hasMore =
        Boolean(nextCursor) ||
        Boolean(nextPage) ||
        readBooleanDeep(response, ["has_more", "hasMore", "more"]) ||
        attendees.length >= pageSize;

      if (attendees.length > 0) {
        return {
          attendees,
          nextCursor,
          nextPage,
          hasMore,
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function getLumaJson(
  apiKey: string,
  path: string,
  query: Record<string, string>,
): Promise<Record<string, unknown>> {
  const params = new URLSearchParams();
  Object.entries(query).forEach(([key, value]) => {
    if (value.trim()) {
      params.set(key, value);
    }
  });

  const response = await fetch(`${LUMA_API_BASE_URL}${path}?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "x-luma-api-key": apiKey,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Luma API request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

function extractManagedEvent(response: Record<string, unknown>): ManagedEvent | null {
  const directEvent = toObject(response.event);
  const nestedEvent = toObject(toObject(response.data).event);
  const candidate = Object.keys(directEvent).length > 0 ? directEvent : nestedEvent;

  if (Object.keys(candidate).length > 0) {
    return normalizeManagedEvent(candidate);
  }

  const events = extractManagedEventList(response);
  return events[0] || null;
}

function extractManagedEventList(response: Record<string, unknown>): ManagedEvent[] {
  const records = [
    ...readRecordList(response, ["events", "entries", "results"]),
    ...readRecordList(toObject(response.data), ["events", "entries", "results"]),
  ];

  return records
    .map((record) => normalizeManagedEvent(record))
    .filter((event): event is ManagedEvent => Boolean(event));
}

function normalizeManagedEvent(record: Record<string, unknown>): ManagedEvent | null {
  const apiId = readString(record, ["api_id", "event_api_id", "id"]);

  if (!apiId) {
    return null;
  }

  return {
    apiId,
    name: readString(record, ["name", "title"]),
    url: readString(record, ["url", "event_url", "share_url"]),
  };
}

function extractManagedGuests(response: Record<string, unknown>, loadedCount: number): AttendeeProfile[] {
  const records = [
    ...readRecordList(response, ["guests", "entries", "participants", "registrations"]),
    ...readRecordList(toObject(response.data), ["guests", "entries", "participants", "registrations"]),
  ];

  return records
    .map((record, index) => normalizeManagedGuest(record, loadedCount + index))
    .filter((attendee): attendee is AttendeeProfile => Boolean(attendee));
}

function normalizeManagedGuest(source: Record<string, unknown>, index: number): AttendeeProfile | null {
  const profile = mergeCandidateObjects(source, [
    toObject(source.guest),
    toObject(source.profile),
    toObject(source.person),
    toObject(source.user),
  ]);
  const name = readString(profile, ["name", "full_name", "display_name", "first_name"]);
  const fallbackLastName = readString(profile, ["last_name"]);
  const resolvedName = name || [readString(profile, ["first_name"]), fallbackLastName].filter(Boolean).join(" ").trim();

  if (!resolvedName) {
    return null;
  }

  const bio = readString(profile, ["bio_short", "bio", "about"]);
  const title = readString(profile, ["headline", "title", "job_title", "role"]);
  const company = readString(profile, ["company", "organization", "current_company"]);
  const profession = readString(profile, ["profession", "job_title", "role"]);
  const location = readString(profile, ["location", "city", "region"]);

  const attendee: AttendeeProfile = {
    id: `attendee-${index + 1}`,
    name: resolvedName,
    company,
    title,
    profession,
    bio,
    location,
    industry: readString(profile, ["industry", "sector"]),
    interests: readStringList(profile, ["interests", "topics"]),
    goals: readStringList(profile, ["goals", "networking_goals", "networkingGoals"]),
    education: readStringList(profile, ["education", "schools", "school"]),
    personalityTraits: readBoolean(profile, ["is_verified", "verified"]) ? ["verified"] : [],
    publicProfileUrls: uniqueStrings([
      buildLumaUserUrl(profile),
      readString(profile, ["linkedin_url"]),
      buildLinkedInUrl(readString(profile, ["linkedin_handle", "linkedin"])),
      readString(profile, ["instagram_url"]),
      buildInstagramUrl(readString(profile, ["instagram_handle", "instagram"])),
      readString(profile, ["twitter_url", "x_url"]),
      buildXUrl(readString(profile, ["twitter_handle", "x_handle", "twitter", "x"])),
      readString(profile, ["tiktok_url"]),
      buildTikTokUrl(readString(profile, ["tiktok_handle", "tiktok"])),
      readString(profile, ["youtube_url"]),
      buildYouTubeUrl(readString(profile, ["youtube_handle", "youtube"])),
      normalizePublicUrl(readString(profile, ["website", "website_url", "personal_website"]) || ""),
    ]),
    consentToEnrich: true,
    profileImageUrl: readString(profile, ["avatar_url", "profile_image_url", "profileImageUrl", "image_url"]),
    sourceProfiles: [],
    profileRichness: 0,
  };

  attendee.profileRichness = calculateProfileRichness(attendee);
  return attendee;
}

function normalizeLumaEventUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return value.trim();
  }
}

function extractEventSlug(value: string): string | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return segments[segments.length - 1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

function eventMatchesUrl(event: ManagedEvent, eventUrl: string): boolean {
  const expectedSlug = extractEventSlug(eventUrl);
  const actualSlug = event.url ? extractEventSlug(event.url) : undefined;

  if (expectedSlug && actualSlug && expectedSlug === actualSlug) {
    return true;
  }

  if (event.url) {
    return normalizeLumaEventUrl(event.url) === normalizeLumaEventUrl(eventUrl);
  }

  return false;
}

function mergeCandidateObjects(source: Record<string, unknown>, candidates: Record<string, unknown>[]): Record<string, unknown> {
  return candidates.reduce<Record<string, unknown>>((merged, candidate) => ({ ...merged, ...candidate }), source);
}

function readRecordList(source: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
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
      return uniqueStrings(
        value.flatMap((item) => {
          if (typeof item === "string") {
            return item;
          }

          if (typeof item === "object" && item !== null) {
            return readString(item as Record<string, unknown>, ["name", "label", "title"]) || [];
          }

          return [];
        }),
      );
    }

    if (typeof value === "string" && value.trim()) {
      return uniqueStrings(value.split(/[;,|\n]+/g));
    }
  }

  return [];
}

function readBoolean(source: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (typeof source[key] === "boolean") {
      return source[key] as boolean;
    }
  }

  return false;
}

function readStringDeep(source: Record<string, unknown>, keys: string[]): string | undefined {
  const direct = readString(source, keys);
  if (direct) {
    return direct;
  }

  for (const value of Object.values(source)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = readStringDeep(value as Record<string, unknown>, keys);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function readNumberDeep(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") {
      return value;
    }
  }

  for (const value of Object.values(source)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = readNumberDeep(value as Record<string, unknown>, keys);
      if (typeof nested === "number") {
        return nested;
      }
    }
  }

  return undefined;
}

function readBooleanDeep(source: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  for (const value of Object.values(source)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = readBooleanDeep(value as Record<string, unknown>, keys);
      if (nested) {
        return true;
      }
    }
  }

  return false;
}

function toObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function buildLumaUserUrl(source: Record<string, unknown>): string | undefined {
  const handle = readString(source, ["username", "api_id", "user_api_id"]);
  return handle ? `https://luma.com/user/${handle}` : undefined;
}

function buildLinkedInUrl(handle?: string): string | undefined {
  if (!handle?.trim()) {
    return undefined;
  }

  if (/^https?:\/\//i.test(handle)) {
    return normalizePublicUrl(handle);
  }

  return normalizePublicUrl(`https://www.linkedin.com${handle.startsWith("/") ? handle : `/${handle}`}`);
}

function buildInstagramUrl(handle?: string): string | undefined {
  const normalizedHandle = stripHandlePrefix(handle);
  return normalizedHandle ? normalizePublicUrl(`https://www.instagram.com/${normalizedHandle}/`) : undefined;
}

function buildXUrl(handle?: string): string | undefined {
  const normalizedHandle = stripHandlePrefix(handle);
  return normalizedHandle ? normalizePublicUrl(`https://x.com/${normalizedHandle}`) : undefined;
}

function buildTikTokUrl(handle?: string): string | undefined {
  const normalizedHandle = stripHandlePrefix(handle);
  return normalizedHandle ? normalizePublicUrl(`https://www.tiktok.com/@${normalizedHandle}`) : undefined;
}

function buildYouTubeUrl(handle?: string): string | undefined {
  if (!handle?.trim()) {
    return undefined;
  }

  if (/^https?:\/\//i.test(handle)) {
    return normalizePublicUrl(handle);
  }

  const normalizedHandle = handle.startsWith("@") ? handle : `@${handle}`;
  return normalizePublicUrl(`https://www.youtube.com/${normalizedHandle}`);
}

function stripHandlePrefix(handle?: string): string | undefined {
  const trimmed = handle?.trim();

  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/^@/, "").replace(/^https?:\/\/(www\.)?[^/]+\//i, "").replace(/\/+$/, "");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
