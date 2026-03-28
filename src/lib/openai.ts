import { uniqueStrings } from "@/lib/attendee-utils";
import type { AttendeeAnalysis, AttendeeProfile, SeniorityBand } from "@/lib/types";

type OpenAIResponse = {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  } | null;
};

type AnalysisStats = {
  analyzedCount: number;
  heuristicAnalyzedCount: number;
  analysisMode: "heuristic-only" | "gpt-enhanced";
  warnings: string[];
};

type AnalysisBatchResult = {
  attendees: Array<{
    attendeeId: string;
    summary: string;
    seniorityBand: SeniorityBand;
    careerSignalScore: number;
    companySignalScore: number;
    educationSignalScore: number;
    publicPresenceScore: number;
    profilePolishScore: number;
    archetypeTags: string[];
    notableSignals: string[];
  }>;
};

const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-5-mini";
const OPENAI_BATCH_SIZE = 8;

export async function analyzeAttendeesWithOpenAI(
  attendees: AttendeeProfile[],
): Promise<{ attendees: AttendeeProfile[]; stats: AnalysisStats }> {
  const apiKey = process.env.OPENAI_API_KEY;
  const warnings: string[] = [];
  const heuristicAttendees = attendees.map((attendee) => ({
    ...attendee,
    analysis: buildHeuristicAnalysis(attendee),
  }));

  if (!apiKey) {
    warnings.push("`OPENAI_API_KEY` is not set. GPT profile analysis was skipped and heuristic analysis was used instead.");
    return {
      attendees: heuristicAttendees,
      stats: {
        analyzedCount: 0,
        heuristicAnalyzedCount: heuristicAttendees.length,
        analysisMode: "heuristic-only",
        warnings,
      },
    };
  }

  const attendeeMap = new Map(heuristicAttendees.map((attendee) => [attendee.id, attendee]));
  let analyzedCount = 0;

  for (const batch of chunk(attendees, OPENAI_BATCH_SIZE)) {
    try {
      const payload = batch.map((attendee) => ({
        attendeeId: attendee.id,
        name: attendee.name,
        company: attendee.company,
        title: attendee.title,
        profession: attendee.profession,
        industry: attendee.industry,
        bio: attendee.bio,
        location: attendee.location,
        education: attendee.education,
        interests: attendee.interests,
        publicProfileUrls: attendee.publicProfileUrls,
      }));

      const analysis = await createAnalysisBatch(apiKey, payload);
      analysis.attendees.forEach((entry) => {
        const attendee = attendeeMap.get(entry.attendeeId);
        if (!attendee) {
          return;
        }

        attendee.analysis = {
          summary: entry.summary.trim(),
          seniorityBand: normalizeSeniorityBand(entry.seniorityBand),
          careerSignalScore: clampScore(entry.careerSignalScore),
          companySignalScore: clampScore(entry.companySignalScore),
          educationSignalScore: clampScore(entry.educationSignalScore),
          publicPresenceScore: clampScore(entry.publicPresenceScore),
          profilePolishScore: clampScore(entry.profilePolishScore),
          archetypeTags: uniqueStrings(entry.archetypeTags).slice(0, 5),
          notableSignals: uniqueStrings(entry.notableSignals).slice(0, 4),
        };
        attendeeMap.set(attendee.id, attendee);
        analyzedCount += 1;
      });
    } catch (error) {
      warnings.push(`GPT analysis skipped for one batch: ${formatError(error)}`);
    }
  }

  return {
    attendees: heuristicAttendees.map((attendee) => attendeeMap.get(attendee.id) || attendee),
    stats: {
      analyzedCount,
      heuristicAnalyzedCount: heuristicAttendees.length,
      analysisMode: analyzedCount > 0 ? "gpt-enhanced" : "heuristic-only",
      warnings: uniqueStrings(warnings).slice(0, 8),
    },
  };
}

async function createAnalysisBatch(
  apiKey: string,
  attendees: Array<{
    attendeeId: string;
    name: string;
    company?: string;
    title?: string;
    profession?: string;
    industry?: string;
    bio?: string;
    location?: string;
    education: string[];
    interests: string[];
    publicProfileUrls: string[];
  }>,
): Promise<AnalysisBatchResult> {
  const response = await fetch(`${OPENAI_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: DEFAULT_OPENAI_MODEL,
      input: JSON.stringify({
        task: "Analyze these public attendee profiles for a superficial romantic-ranking app.",
        attendees,
      }),
      text: {
        format: {
          type: "json_schema",
          name: "attendee_surface_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              attendees: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    attendeeId: { type: "string" },
                    summary: { type: "string" },
                    seniorityBand: {
                      type: "string",
                      enum: ["student", "early-career", "mid-career", "senior", "founder-exec", "unknown"],
                    },
                    careerSignalScore: { type: "integer" },
                    companySignalScore: { type: "integer" },
                    educationSignalScore: { type: "integer" },
                    publicPresenceScore: { type: "integer" },
                    profilePolishScore: { type: "integer" },
                    archetypeTags: {
                      type: "array",
                      items: { type: "string" },
                    },
                    notableSignals: {
                      type: "array",
                      items: { type: "string" },
                    },
                  },
                  required: [
                    "attendeeId",
                    "summary",
                    "seniorityBand",
                    "careerSignalScore",
                    "companySignalScore",
                    "educationSignalScore",
                    "publicPresenceScore",
                    "profilePolishScore",
                    "archetypeTags",
                    "notableSignals",
                  ],
                },
              },
            },
            required: ["attendees"],
          },
        },
      },
      instructions: [
        "You analyze public attendee profiles for a superficial dating shortlist app called Fishing.",
        "Use only the provided public profile data.",
        "Focus on visible professional and status signals such as current role, company, education, profile clarity, and public presence.",
        "Do not infer gender, age, ethnicity, religion, politics, relationship status, salary, net worth, or future earnings.",
        "Do not invent missing facts.",
        "The careerSignalScore must be from 0 to 100 and represent current visible professional signal strength only, not future outcomes.",
        "companySignalScore should reflect how strong and legible the current company signal is in the public profile, not private compensation.",
        "educationSignalScore should reflect how strong and legible the education signal is in the public profile.",
        "publicPresenceScore should reflect how much external/public footprint is visible from the profile data.",
        "profilePolishScore should reflect public profile completeness and clarity.",
        "The summary must be one sentence, concise, and based only on the provided profile.",
        "archetypeTags should be short labels like founder, operator, builder, researcher, finance, consulting, student, creator, investor, executive.",
        "notableSignals should be short phrases.",
      ].join("\n"),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI request failed (${response.status}): ${body}`);
  }

  const payload = (await response.json()) as OpenAIResponse;
  const text = extractOutputText(payload);

  if (!text) {
    throw new Error(payload.error?.message || "OpenAI did not return structured output.");
  }

  return JSON.parse(text) as AnalysisBatchResult;
}

function extractOutputText(response: OpenAIResponse): string | undefined {
  for (const item of response.output || []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content || []) {
      if (content.type === "output_text" && typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }

  return undefined;
}

function normalizeSeniorityBand(value: SeniorityBand | string): SeniorityBand {
  switch (value) {
    case "student":
    case "early-career":
    case "mid-career":
    case "senior":
    case "founder-exec":
      return value;
    default:
      return "unknown";
  }
}

function buildHeuristicAnalysis(attendee: AttendeeProfile): AttendeeAnalysis {
  const seniorityBand = deriveSeniorityBand(attendee);
  const companySignalScore = scoreCompanySignal(attendee);
  const educationSignalScore = scoreEducationSignal(attendee);
  const publicPresenceScore = scorePublicPresence(attendee);
  const profilePolishScore = clampScore(Math.round(attendee.profileRichness * 100));
  const careerSignalScore = clampScore(
    Math.round(companySignalScore * 0.35 + educationSignalScore * 0.2 + publicPresenceScore * 0.2 + profilePolishScore * 0.25),
  );
  const archetypeTags = deriveArchetypeTags(attendee, seniorityBand);
  const notableSignals = deriveNotableSignals(attendee, seniorityBand);

  return {
    summary: buildHeuristicSummary(attendee, seniorityBand, archetypeTags),
    seniorityBand,
    careerSignalScore,
    companySignalScore,
    educationSignalScore,
    publicPresenceScore,
    profilePolishScore,
    archetypeTags,
    notableSignals,
  };
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(value)));
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function deriveSeniorityBand(attendee: AttendeeProfile): SeniorityBand {
  const haystack = `${attendee.title || ""} ${attendee.profession || ""} ${attendee.bio || ""}`.toLowerCase();

  if (/(founder|co-founder|ceo|cto|chief|partner|principal|vp|vice president|director|head of)/.test(haystack)) {
    return "founder-exec";
  }

  if (/(senior|staff|lead|manager|product lead|research lead|principal)/.test(haystack)) {
    return "senior";
  }

  if (/(phd|candidate|researcher|engineer|consultant|manager|specialist|product)/.test(haystack)) {
    return "mid-career";
  }

  if (/(student|graduate|intern|master|undergrad|ntu|nus)/.test(haystack)) {
    return "student";
  }

  if (attendee.company || attendee.title || attendee.profession) {
    return "early-career";
  }

  return "unknown";
}

function scoreCompanySignal(attendee: AttendeeProfile): number {
  const titleText = `${attendee.title || ""} ${attendee.profession || ""}`.toLowerCase();
  let score = attendee.company ? 70 : 10;

  if (/(founder|ceo|cto|chief|partner|principal|director|vp|head of)/.test(titleText)) {
    score += 20;
  } else if (/(senior|lead|manager)/.test(titleText)) {
    score += 12;
  } else if (titleText) {
    score += 6;
  }

  return clampScore(score);
}

function scoreEducationSignal(attendee: AttendeeProfile): number {
  if (attendee.education.length === 0) {
    return 10;
  }

  const joined = attendee.education.join(" ").toLowerCase();
  let score = 55 + Math.min(25, attendee.education.length * 12);

  if (/(phd|doctor)/.test(joined)) {
    score += 15;
  } else if (/(master|mba)/.test(joined)) {
    score += 10;
  }

  return clampScore(score);
}

function scorePublicPresence(attendee: AttendeeProfile): number {
  const externalProfiles = attendee.publicProfileUrls.filter((url) => !/luma\.com|lu\.ma/i.test(url)).length;
  const sourceProfiles = attendee.sourceProfiles.length;
  let score = 15;

  if (attendee.profileImageUrl) {
    score += 15;
  }

  if (attendee.bio) {
    score += attendee.bio.length >= 80 ? 20 : 12;
  }

  score += Math.min(30, externalProfiles * 10);
  score += Math.min(20, sourceProfiles * 5);

  return clampScore(score);
}

function deriveArchetypeTags(attendee: AttendeeProfile, seniorityBand: SeniorityBand): string[] {
  const haystack = `${attendee.title || ""} ${attendee.profession || ""} ${attendee.industry || ""} ${attendee.bio || ""}`.toLowerCase();
  const tags: string[] = [];

  if (/(founder|co-founder|chief|ceo|cto|executive|director|vp|head of)/.test(haystack) || seniorityBand === "founder-exec") {
    tags.push("founder-exec");
  }
  if (/(product|operator|operations|manager|lead)/.test(haystack)) {
    tags.push("operator");
  }
  if (/(research|scientist|phd|machine learning|ai research)/.test(haystack)) {
    tags.push("researcher");
  }
  if (/(engineer|developer|builder)/.test(haystack)) {
    tags.push("builder");
  }
  if (/(finance|equity|investment|quant|trading)/.test(haystack)) {
    tags.push("finance");
  }
  if (/(consulting|consultant)/.test(haystack)) {
    tags.push("consulting");
  }
  if (/(creator|tiktoker|youtube|instagram|social media)/.test(haystack)) {
    tags.push("creator");
  }
  if (seniorityBand === "student") {
    tags.push("student");
  }

  return uniqueStrings(tags).slice(0, 5);
}

function deriveNotableSignals(attendee: AttendeeProfile, seniorityBand: SeniorityBand): string[] {
  const signals = [
    attendee.company ? `Current company visible: ${attendee.company}` : undefined,
    attendee.education[0] ? `Education visible: ${attendee.education[0]}` : undefined,
    attendee.location ? `Location visible: ${attendee.location}` : undefined,
    seniorityBand !== "unknown" ? `Seniority reads as ${seniorityBand}` : undefined,
    attendee.publicProfileUrls.length > 1 ? "Multiple public profiles linked" : undefined,
  ];

  return uniqueStrings(signals).slice(0, 4);
}

function buildHeuristicSummary(attendee: AttendeeProfile, seniorityBand: SeniorityBand, tags: string[]): string {
  const parts = [
    attendee.title || attendee.profession || attendee.industry || "Public profile",
    attendee.company ? `at ${attendee.company}` : undefined,
    attendee.location ? `in ${attendee.location}` : undefined,
  ].filter(Boolean);

  const descriptor = tags.length > 0 ? `${tags.slice(0, 2).join(" / ")} profile` : `${seniorityBand} profile`;
  return `${parts.join(" ")} with a ${descriptor} and ${Math.round(attendee.profileRichness * 100)}% public-profile richness.`;
}
