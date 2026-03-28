import { calculateProfileRichness, normalizePublicUrl, uniqueStrings } from "@/lib/attendee-utils";
import type { AttendeeProfile, SeekerProfileInput } from "@/lib/types";

export function buildSeekerProfile(input: SeekerProfileInput): AttendeeProfile {
  const attendee: AttendeeProfile = {
    id: "seeker",
    name: normalizeText(input.name) || "You",
    company: normalizeText(input.company),
    title: normalizeText(input.title),
    profession: normalizeText(input.profession),
    industry: normalizeText(input.industry),
    bio: normalizeText(input.bio),
    location: normalizeText(input.location),
    interests: normalizeStringList(input.interests),
    goals: normalizeStringList(input.goals),
    education: normalizeStringList(input.education),
    personalityTraits: normalizeStringList(input.personalityTraits),
    publicProfileUrls: normalizeUrlList(input.publicProfileUrls),
    consentToEnrich: false,
    sourceProfiles: [],
    profileRichness: 0,
  };

  attendee.profileRichness = calculateProfileRichness(attendee);
  return attendee;
}

function normalizeText(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeStringList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return uniqueStrings(values);
}

function normalizeUrlList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return uniqueStrings(values.map((value) => normalizePublicUrl(value || "")));
}
