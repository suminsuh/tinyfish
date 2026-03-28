export type MatchWeights = {
  interests: number;
  location: number;
  industry: number;
  goals: number;
  profession: number;
  education: number;
  personality: number;
};

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  interests: 5,
  location: 4,
  industry: 4,
  goals: 3,
  profession: 3,
  education: 2,
  personality: 2,
};

export type MatchmakingOptions = {
  weights: MatchWeights;
  allowPublicEnrichment: boolean;
  attendeeLimit: number;
  maxProfileDiscoverySearches: number;
  maxProfileUrlsPerAttendee: number;
  maxTotalEnrichmentRuns: number;
  maxTinyFishActiveRuns: number;
  maxTinyFishBatchSize: number;
  maxRecommendationsPerPerson: number;
  groupSize: number;
  maxConcurrentEnrichments: number;
  maxTopPairs: number;
  minPairScore: number;
};

export const DEFAULT_MATCH_OPTIONS: MatchmakingOptions = {
  weights: DEFAULT_MATCH_WEIGHTS,
  allowPublicEnrichment: true,
  attendeeLimit: 120,
  maxProfileDiscoverySearches: 8,
  maxProfileUrlsPerAttendee: 2,
  maxTotalEnrichmentRuns: 20,
  maxTinyFishActiveRuns: 20,
  maxTinyFishBatchSize: 20,
  maxRecommendationsPerPerson: 3,
  groupSize: 4,
  maxConcurrentEnrichments: 2,
  maxTopPairs: 10,
  minPairScore: 38,
};

export type MatchmakingRequestOptions = Partial<Omit<MatchmakingOptions, "weights">> & {
  weights?: Partial<MatchWeights>;
};

export type SeekerProfileInput = {
  name: string;
  company?: string;
  title?: string;
  profession?: string;
  industry?: string;
  bio?: string;
  location?: string;
  interests?: string[];
  goals?: string[];
  education?: string[];
  personalityTraits?: string[];
  publicProfileUrls?: string[];
};

export type MatchmakingRequest = {
  eventUrl: string;
  options?: MatchmakingRequestOptions;
};

export function resolveMatchmakingOptions(overrides?: MatchmakingRequestOptions): MatchmakingOptions {
  return {
    ...DEFAULT_MATCH_OPTIONS,
    ...overrides,
    weights: {
      ...DEFAULT_MATCH_WEIGHTS,
      ...overrides?.weights,
    },
  };
}

export type SourcePlatform = "linkedin" | "instagram" | "luma" | "website" | "unknown";

export type PublicProfileSource = {
  url: string;
  platform: SourcePlatform;
  company?: string;
  headline?: string;
  bio?: string;
  interests: string[];
  goals: string[];
  education: string[];
  profession?: string;
  industry?: string;
  location?: string;
  profileImageUrl?: string;
};

export type SeniorityBand = "student" | "early-career" | "mid-career" | "senior" | "founder-exec" | "unknown";

export type AttendeeAnalysis = {
  summary: string;
  seniorityBand: SeniorityBand;
  careerSignalScore: number;
  companySignalScore: number;
  educationSignalScore: number;
  publicPresenceScore: number;
  profilePolishScore: number;
  archetypeTags: string[];
  notableSignals: string[];
};

export type AttendeeProfile = {
  id: string;
  name: string;
  email?: string;
  company?: string;
  title?: string;
  profession?: string;
  industry?: string;
  bio?: string;
  location?: string;
  interests: string[];
  goals: string[];
  education: string[];
  personalityTraits: string[];
  publicProfileUrls: string[];
  consentToEnrich: boolean;
  profileImageUrl?: string;
  sourceProfiles: PublicProfileSource[];
  analysis?: AttendeeAnalysis;
  profileRichness: number;
};

export type ParticipantSummary = {
  id: string;
  name: string;
  email?: string;
  company?: string;
  title?: string;
  industry?: string;
  profileImageUrl?: string;
};

export type PairMatch = {
  id: string;
  score: number;
  confidence: number;
  participants: [ParticipantSummary, ParticipantSummary];
  scoreBreakdown: Record<keyof MatchWeights, number>;
  reasons: string[];
  sharedKeywords: string[];
};

export type MatchGroup = {
  id: string;
  theme: string;
  averageScore: number;
  members: ParticipantSummary[];
  reasons: string[];
};

export type AttendeeRecommendations = {
  attendee: ParticipantSummary;
  matches: PairMatch[];
};

export type SurfaceSignalBreakdown = {
  careerSignal: number;
  companySignal: number;
  educationSignal: number;
  publicPresence: number;
  profilePolish: number;
  profileImage: number;
  bio: number;
  title: number;
  company: number;
  education: number;
  location: number;
  publicProfiles: number;
};

export type RankedAttendee = {
  attendee: ParticipantSummary;
  score: number;
  reasons: string[];
  breakdown: SurfaceSignalBreakdown;
};

export type InvalidRow = {
  rowNumber: number;
  reason: string;
  row: Record<string, string>;
};

export type MatchmakingResponse = {
  meta: {
    sourceType: "luma";
    sourceUrl: string;
    lumaAccessMode: "managed-api" | "public-html" | "tinyfish-browser";
    eventTitle?: string;
    attendeeCount: number;
    enrichableCount: number;
    enrichedCount: number;
    profileEnrichment: "event-only" | "event-plus-linked-profiles";
    rankingMode: "surface-signals";
    analysisMode: "heuristic-only" | "gpt-enhanced";
    gptAnalyzedCount: number;
    heuristicAnalyzedCount: number;
    warnings: string[];
  };
  rankedAttendees: RankedAttendee[];
  attendees: AttendeeProfile[];
};
