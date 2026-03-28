import { calculateProfileRichness, normalizePublicUrl, uniqueStrings } from "@/lib/attendee-utils";
import type { AttendeeProfile, InvalidRow } from "@/lib/types";

const HEADER_ALIASES = {
  name: ["name", "full_name", "participant_name"],
  email: ["email", "email_address", "e-mail"],
  company: ["company", "organization", "employer"],
  title: ["title", "headline", "role", "job_title"],
  profession: ["profession", "job_function"],
  industry: ["industry", "sector"],
  bio: ["bio", "about", "summary"],
  interests: ["interests", "topics", "focus_areas"],
  goals: ["goals", "networking_goals", "looking_for", "seeking"],
  education: ["education", "school", "alma_mater"],
  personality: ["personality_traits", "traits"],
  linkedinUrl: ["linkedin_url", "linkedin"],
  instagramUrl: ["instagram_url", "instagram"],
  websiteUrl: ["website_url", "website", "portfolio", "personal_site"],
  publicProfileUrls: ["public_profile_urls", "profile_urls", "public_urls"],
  consentToEnrich: ["consent_to_enrich", "public_data_consent", "enrichment_opt_in", "consent"],
} as const;

export function parseAttendeesCsv(csvText: string): {
  attendees: AttendeeProfile[];
  invalidRows: InvalidRow[];
} {
  const rows = parseCsv(csvText);

  if (rows.length === 0) {
    return { attendees: [], invalidRows: [] };
  }

  const [headerRow, ...dataRows] = rows;
  const normalizedHeaders = headerRow.map(normalizeHeader);
  const attendees: AttendeeProfile[] = [];
  const invalidRows: InvalidRow[] = [];

  dataRows.forEach((cells, index) => {
    const rowNumber = index + 2;
    const record = toRecord(normalizedHeaders, cells);
    const name = readField(record, HEADER_ALIASES.name);
    const email = readField(record, HEADER_ALIASES.email).toLowerCase();

    if (!name || !email) {
      invalidRows.push({
        rowNumber,
        reason: "Missing required `name` or `email` field.",
        row: record,
      });
      return;
    }

    const publicProfileUrls = uniqueStrings([
      ...splitUrlField(readField(record, HEADER_ALIASES.publicProfileUrls)),
      ...splitUrlField(readField(record, HEADER_ALIASES.linkedinUrl)),
      ...splitUrlField(readField(record, HEADER_ALIASES.instagramUrl)),
      ...splitUrlField(readField(record, HEADER_ALIASES.websiteUrl)),
    ]);

    const attendee: AttendeeProfile = {
      id: `attendee-${index + 1}`,
      name,
      email,
      company: optionalField(readField(record, HEADER_ALIASES.company)),
      title: optionalField(readField(record, HEADER_ALIASES.title)),
      profession: optionalField(readField(record, HEADER_ALIASES.profession)),
      industry: optionalField(readField(record, HEADER_ALIASES.industry)),
      bio: optionalField(readField(record, HEADER_ALIASES.bio)),
      interests: uniqueStrings(splitListField(readField(record, HEADER_ALIASES.interests))),
      goals: uniqueStrings(splitListField(readField(record, HEADER_ALIASES.goals))),
      education: uniqueStrings(splitListField(readField(record, HEADER_ALIASES.education))),
      personalityTraits: uniqueStrings(splitListField(readField(record, HEADER_ALIASES.personality))),
      publicProfileUrls,
      consentToEnrich: parseBoolean(readField(record, HEADER_ALIASES.consentToEnrich)),
      sourceProfiles: [],
      profileRichness: 0,
    };

    attendee.profileRichness = calculateProfileRichness(attendee);
    attendees.push(attendee);
  });

  return { attendees, invalidRows };
}

function parseCsv(csvText: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const character = csvText[index];
    const nextCharacter = csvText[index + 1];

    if (inQuotes) {
      if (character === '"' && nextCharacter === '"') {
        currentCell += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
      } else {
        currentCell += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      continue;
    }

    if (character === ",") {
      currentRow.push(currentCell.trim());
      currentCell = "";
      continue;
    }

    if (character === "\n") {
      currentRow.push(currentCell.trim());
      if (currentRow.some((cell) => cell.length > 0)) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = "";
      continue;
    }

    if (character !== "\r") {
      currentCell += character;
    }
  }

  if (currentCell.length > 0 || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some((cell) => cell.length > 0)) {
      rows.push(currentRow);
    }
  }

  return rows;
}

function toRecord(headers: string[], cells: string[]): Record<string, string> {
  const record: Record<string, string> = {};

  headers.forEach((header, index) => {
    record[header] = cells[index]?.trim() ?? "";
  });

  return record;
}

function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function readField(record: Record<string, string>, aliases: readonly string[]): string {
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const value = record[normalizedAlias];
    if (value) {
      return value.trim();
    }
  }

  return "";
}

function splitListField(value: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[;\n|,]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function splitUrlField(value: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[,\n;|]+/g)
    .map((entry) => normalizePublicUrl(entry))
    .filter(Boolean) as string[];
}

function parseBoolean(value: string): boolean {
  return ["true", "yes", "1", "y"].includes(value.trim().toLowerCase());
}

function optionalField(value: string): string | undefined {
  return value.trim() ? value.trim() : undefined;
}
