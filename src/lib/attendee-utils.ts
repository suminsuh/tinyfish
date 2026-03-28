import type { AttendeeProfile } from "@/lib/types";

export function calculateProfileRichness(attendee: AttendeeProfile): number {
  const signals = [
    attendee.company ? 1 : 0,
    attendee.title || attendee.profession ? 1 : 0,
    attendee.industry ? 1 : 0,
    attendee.bio ? 1 : 0,
    attendee.interests.length > 0 ? 1 : 0,
    attendee.goals.length > 0 ? 1 : 0,
    attendee.education.length > 0 ? 1 : 0,
    attendee.personalityTraits.length > 0 ? 1 : 0,
    attendee.publicProfileUrls.length > 0 ? 1 : 0,
    attendee.sourceProfiles.length > 0 ? 1 : 0,
  ];

  const total = signals.reduce((sum, value) => sum + value, 0);
  return Number((total / signals.length).toFixed(2));
}

export function normalizePublicUrl(url: string): string | undefined {
  const trimmed = url.trim();

  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    return undefined;
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return undefined;
  }
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  values.forEach((value) => {
    const normalizedValue = value?.trim();
    const key = normalizedValue?.toLowerCase();

    if (!normalizedValue || !key || seen.has(key)) {
      return;
    }

    seen.add(key);
    results.push(normalizedValue);
  });

  return results;
}
