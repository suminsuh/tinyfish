import type {
  AttendeeProfile,
  AttendeeRecommendations,
  MatchGroup,
  MatchWeights,
  MatchmakingOptions,
  PairMatch,
  ParticipantSummary,
  RankedAttendee,
  SurfaceSignalBreakdown,
} from "@/lib/types";

const STOP_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "from",
  "into",
  "your",
  "their",
  "that",
  "this",
  "about",
  "over",
  "team",
  "lead",
  "work",
  "data",
]);

export function buildMatchmaking(
  attendees: AttendeeProfile[],
  options: MatchmakingOptions,
): {
  topPairs: PairMatch[];
  groups: MatchGroup[];
  recommendations: AttendeeRecommendations[];
} {
  const pairMatches = buildPairMatches(attendees, options)
    .filter((pair) => pair.score >= options.minPairScore)
    .sort((left, right) => right.score - left.score);

  const topPairs = pairMatches.slice(0, options.maxTopPairs);
  const groups = buildGroups(attendees, pairMatches, options);
  const recommendations = buildRecommendations(attendees, pairMatches, options.maxRecommendationsPerPerson);

  return { topPairs, groups, recommendations };
}

export function buildPotentialPartnerMatches(
  seeker: AttendeeProfile,
  attendees: AttendeeProfile[],
  options: MatchmakingOptions,
): PairMatch[] {
  const rankedMatches = attendees
    .filter((attendee) => attendee.id !== seeker.id)
    .map((attendee) => buildPairMatch(seeker, attendee, options))
    .sort((left, right) => right.score - left.score);

  const strongMatches = rankedMatches.filter((match) => match.score >= options.minPairScore);
  const fallbackMatches = rankedMatches.filter((match) => !strongMatches.some((entry) => entry.id === match.id));

  return [...strongMatches, ...fallbackMatches].slice(0, Math.max(1, options.maxRecommendationsPerPerson));
}

export function buildSurfaceRankings(attendees: AttendeeProfile[]): RankedAttendee[] {
  return attendees
    .map((attendee) => {
      const breakdown = buildSurfaceBreakdown(attendee);
      const score = scoreSurfaceBreakdown(breakdown);
      const reasons = buildSurfaceReasons(attendee, breakdown);

      return {
        attendee: participantSummary(attendee),
        score,
        reasons,
        breakdown,
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.attendee.name.localeCompare(right.attendee.name);
    });
}

function buildPairMatches(attendees: AttendeeProfile[], options: MatchmakingOptions): PairMatch[] {
  const pairs: PairMatch[] = [];

  for (let leftIndex = 0; leftIndex < attendees.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < attendees.length; rightIndex += 1) {
      pairs.push(buildPairMatch(attendees[leftIndex], attendees[rightIndex], options));
    }
  }

  return pairs;
}

function buildPairMatch(left: AttendeeProfile, right: AttendeeProfile, options: MatchmakingOptions): PairMatch {
  const scoreBreakdown = scoreBreakdownForPair(left, right);
  const score = weightedScore(scoreBreakdown, options.weights, left, right);
  const sharedKeywords = collectSharedKeywords(left, right);
  const reasons = buildReasons(left, right, scoreBreakdown, sharedKeywords);
  const confidence = Number(
    (
      Math.min(1, (left.profileRichness + right.profileRichness) / 2) * 0.6 +
      activeSignalCoverage(left, right) * 0.4
    ).toFixed(2),
  );

  return {
    id: pairId(left.id, right.id),
    score,
    confidence,
    participants: [participantSummary(left), participantSummary(right)],
    scoreBreakdown,
    reasons,
    sharedKeywords,
  };
}

function scoreBreakdownForPair(
  left: AttendeeProfile,
  right: AttendeeProfile,
): Record<keyof MatchWeights, number> {
  return {
    interests: scoreKeywordLists(left.interests, right.interests),
    location: scoreTextCollections(
      [left.location, ...left.sourceProfiles.map((profile) => profile.location)],
      [right.location, ...right.sourceProfiles.map((profile) => profile.location)],
    ),
    industry: scoreTextCollections(
      [left.industry, left.company, ...left.sourceProfiles.flatMap((profile) => [profile.company, profile.industry])],
      [right.industry, right.company, ...right.sourceProfiles.flatMap((profile) => [profile.company, profile.industry])],
    ),
    goals: scoreKeywordLists(left.goals, right.goals),
    profession: scoreTextCollections(
      [left.title, left.profession, ...left.sourceProfiles.flatMap((profile) => [profile.headline, profile.profession])],
      [right.title, right.profession, ...right.sourceProfiles.flatMap((profile) => [profile.headline, profile.profession])],
    ),
    education: scoreKeywordLists(left.education, right.education),
    personality: scoreKeywordLists(left.personalityTraits, right.personalityTraits),
  };
}

function weightedScore(
  breakdown: Record<keyof MatchWeights, number>,
  weights: MatchWeights,
  left: AttendeeProfile,
  right: AttendeeProfile,
): number {
  let weightedTotal = 0;
  let totalWeight = 0;

  (Object.keys(weights) as Array<keyof MatchWeights>).forEach((key) => {
    const hasComparableData = hasSignalData(key, left, right);
    if (!hasComparableData || weights[key] <= 0) {
      return;
    }

    weightedTotal += breakdown[key] * weights[key];
    totalWeight += weights[key];
  });

  if (totalWeight === 0) {
    return 0;
  }

  const baseScore = weightedTotal / totalWeight;
  const goalBoost = breakdown.goals > 0.45 ? 0.05 : 0;
  const localBoost = breakdown.location > 0.35 ? 0.04 : 0;
  const trajectoryBoost =
    breakdown.profession > 0.2 && (breakdown.industry > 0.2 || breakdown.education > 0.18) ? 0.04 : 0;
  const richnessBoost = Math.min(left.profileRichness, right.profileRichness) * 0.05;

  return Math.round(Math.min(1, baseScore + goalBoost + localBoost + trajectoryBoost + richnessBoost) * 100);
}

function hasSignalData(key: keyof MatchWeights, left: AttendeeProfile, right: AttendeeProfile): boolean {
  switch (key) {
    case "interests":
      return left.interests.length > 0 && right.interests.length > 0;
    case "location":
      return Boolean(left.location) && Boolean(right.location);
    case "industry":
      return Boolean(left.industry || left.company) && Boolean(right.industry || right.company);
    case "goals":
      return left.goals.length > 0 && right.goals.length > 0;
    case "profession":
      return Boolean(left.title || left.profession) && Boolean(right.title || right.profession);
    case "education":
      return left.education.length > 0 && right.education.length > 0;
    case "personality":
      return left.personalityTraits.length > 0 && right.personalityTraits.length > 0;
    default:
      return false;
  }
}

function buildReasons(
  left: AttendeeProfile,
  right: AttendeeProfile,
  breakdown: Record<keyof MatchWeights, number>,
  sharedKeywords: string[],
): string[] {
  const reasons: string[] = [];

  if (breakdown.location >= 0.35) {
    reasons.push("They appear to be based in a similar place, which makes follow-through easier.");
  }

  if (breakdown.interests >= 0.3) {
    reasons.push(reasonFromSharedItems("Shared interests", sharedListItems(left.interests, right.interests)));
  }

  if (breakdown.goals >= 0.3) {
    reasons.push(reasonFromSharedItems("Similar life or relationship goals", sharedListItems(left.goals, right.goals)));
  }

  if (breakdown.industry >= 0.35) {
    reasons.push("Their current worlds overlap enough to create easy conversation and lifestyle fit.");
  }

  if (breakdown.profession >= 0.28) {
    reasons.push("Their current roles suggest a similar level of ambition or stage of life.");
  }

  if (breakdown.profession > 0.2 && (breakdown.industry > 0.2 || breakdown.education > 0.18)) {
    reasons.push("Their education and career path point to a compatible trajectory without guessing income.");
  }

  if (breakdown.education >= 0.25) {
    reasons.push(reasonFromSharedItems("Education overlap", sharedListItems(left.education, right.education)));
  }

  if (breakdown.personality >= 0.25) {
    reasons.push(
      reasonFromSharedItems("Shared self-described traits", sharedListItems(left.personalityTraits, right.personalityTraits)),
    );
  }

  if (reasons.length === 0 && sharedKeywords.length > 0) {
    reasons.push(`They share themes around ${sharedKeywords.slice(0, 3).join(", ")}.`);
  }

  if (reasons.length === 0) {
    reasons.push("Their profiles are light, but there is still enough overlap for a promising first conversation.");
  }

  return reasons.slice(0, 3);
}

function buildGroups(
  attendees: AttendeeProfile[],
  pairMatches: PairMatch[],
  options: MatchmakingOptions,
): MatchGroup[] {
  const lookup = new Map<string, AttendeeProfile>(attendees.map((attendee) => [attendee.id, attendee]));
  const pairLookup = new Map(pairMatches.map((pair) => [pair.id, pair]));
  const groups: MatchGroup[] = [];
  const assigned = new Set<string>();

  for (const pair of pairMatches) {
    const seedIds = pair.participants.map((participant) => participant.id);
    if (seedIds.some((id) => assigned.has(id))) {
      continue;
    }

    const members = [...seedIds];

    while (members.length < Math.max(3, options.groupSize)) {
      const candidate = bestGroupCandidate(attendees, members, assigned, pairLookup);
      if (!candidate || candidate.averageScore < Math.max(options.minPairScore - 4, 30)) {
        break;
      }

      members.push(candidate.attendee.id);
    }

    if (members.length < 3) {
      continue;
    }

    members.forEach((memberId) => assigned.add(memberId));
    const memberProfiles = members
      .map((memberId) => lookup.get(memberId))
      .filter((member): member is AttendeeProfile => Boolean(member));

    const internalPairs = collectInternalPairs(memberProfiles, pairLookup);
    const averageScore =
      internalPairs.length > 0
        ? Math.round(internalPairs.reduce((sum, entry) => sum + entry.score, 0) / internalPairs.length)
        : pair.score;

    groups.push({
      id: `group-${groups.length + 1}`,
      theme: buildGroupTheme(memberProfiles),
      averageScore,
      members: memberProfiles.map(participantSummary),
      reasons: internalPairs[0]?.reasons ?? pair.reasons,
    });
  }

  return groups.slice(0, 6);
}

function bestGroupCandidate(
  attendees: AttendeeProfile[],
  currentMemberIds: string[],
  assigned: Set<string>,
  pairLookup: Map<string, PairMatch>,
): { attendee: AttendeeProfile; averageScore: number } | null {
  let bestCandidate: { attendee: AttendeeProfile; averageScore: number } | null = null;

  attendees.forEach((candidate) => {
    if (assigned.has(candidate.id) || currentMemberIds.includes(candidate.id)) {
      return;
    }

    const scores = currentMemberIds
      .map((memberId) => pairLookup.get(pairId(memberId, candidate.id))?.score ?? 0)
      .filter((score) => score > 0);

    if (scores.length !== currentMemberIds.length) {
      return;
    }

    const averageScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;

    if (!bestCandidate || averageScore > bestCandidate.averageScore) {
      bestCandidate = { attendee: candidate, averageScore };
    }
  });

  return bestCandidate;
}

function collectInternalPairs(memberProfiles: AttendeeProfile[], pairLookup: Map<string, PairMatch>): PairMatch[] {
  const internalPairs: PairMatch[] = [];

  for (let leftIndex = 0; leftIndex < memberProfiles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < memberProfiles.length; rightIndex += 1) {
      const pair = pairLookup.get(pairId(memberProfiles[leftIndex].id, memberProfiles[rightIndex].id));
      if (pair) {
        internalPairs.push(pair);
      }
    }
  }

  return internalPairs.sort((left, right) => right.score - left.score);
}

function buildRecommendations(
  attendees: AttendeeProfile[],
  pairMatches: PairMatch[],
  maxRecommendationsPerPerson: number,
): AttendeeRecommendations[] {
  return attendees.map((attendee) => {
    const matches = pairMatches
      .filter((pair) => pair.participants.some((participant) => participant.id === attendee.id))
      .sort((left, right) => right.score - left.score)
      .slice(0, maxRecommendationsPerPerson);

    return {
      attendee: participantSummary(attendee),
      matches,
    };
  });
}

function participantSummary(attendee: AttendeeProfile): ParticipantSummary {
  return {
    id: attendee.id,
    name: attendee.name,
    email: attendee.email,
    company: attendee.company,
    title: attendee.title || attendee.profession,
    industry: attendee.industry,
    profileImageUrl: attendee.profileImageUrl,
  };
}

function buildSurfaceBreakdown(attendee: AttendeeProfile): SurfaceSignalBreakdown {
  const nonLumaProfiles = attendee.publicProfileUrls.filter((url) => !url.includes("luma.com") && !url.includes("lu.ma")).length;
  const imageSignals = [
    attendee.profileImageUrl,
    ...attendee.sourceProfiles.map((profile) => profile.profileImageUrl).filter(Boolean),
  ].filter(Boolean).length;

  return {
    careerSignal: attendee.analysis ? attendee.analysis.careerSignalScore / 100 : 0,
    companySignal: attendee.analysis ? attendee.analysis.companySignalScore / 100 : attendee.company ? 0.65 : 0,
    educationSignal: attendee.analysis ? attendee.analysis.educationSignalScore / 100 : attendee.education.length > 0 ? 0.65 : 0,
    publicPresence: attendee.analysis ? attendee.analysis.publicPresenceScore / 100 : Math.min(1, nonLumaProfiles * 0.4),
    profilePolish: attendee.analysis ? attendee.analysis.profilePolishScore / 100 : attendee.profileRichness,
    profileImage: imageSignals > 0 ? 1 : 0,
    bio: attendee.bio ? (attendee.bio.length >= 80 ? 1 : 0.6) : 0,
    title: attendee.title || attendee.profession ? 1 : 0,
    company: attendee.company ? 1 : 0,
    education: attendee.education.length > 0 ? Math.min(1, 0.5 + attendee.education.length * 0.25) : 0,
    location: attendee.location ? 1 : 0,
    publicProfiles: nonLumaProfiles >= 2 ? 1 : nonLumaProfiles === 1 ? 0.65 : 0,
  };
}

function scoreSurfaceBreakdown(breakdown: SurfaceSignalBreakdown): number {
  const weights = {
    careerSignal: 2.5,
    companySignal: 1.4,
    educationSignal: 1.1,
    publicPresence: 1.3,
    profilePolish: 1.4,
    profileImage: 1,
    bio: 2,
    title: 2,
    company: 2,
    education: 1.5,
    location: 1,
    publicProfiles: 1.5,
  } satisfies Record<keyof SurfaceSignalBreakdown, number>;

  const weightedTotal = (Object.keys(weights) as Array<keyof SurfaceSignalBreakdown>).reduce(
    (sum, key) => sum + breakdown[key] * weights[key],
    0,
  );
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0);

  return Math.round((weightedTotal / totalWeight) * 100);
}

function buildSurfaceReasons(attendee: AttendeeProfile, breakdown: SurfaceSignalBreakdown): string[] {
  const reasons: string[] = [];

  if (attendee.analysis?.summary) {
    reasons.push(attendee.analysis.summary);
  }

  if (attendee.analysis?.archetypeTags.length) {
    reasons.push(`Tags: ${attendee.analysis.archetypeTags.slice(0, 3).join(", ")}.`);
  }

  if (attendee.analysis?.notableSignals.length) {
    reasons.push(...attendee.analysis.notableSignals.map((signal) => `${signal}.`));
  }

  if (breakdown.company > 0 && breakdown.title > 0) {
    reasons.push(`Current role is visible${attendee.company ? ` at ${attendee.company}` : ""}.`);
  }

  if (breakdown.education > 0) {
    reasons.push(`Education is public: ${attendee.education.slice(0, 2).join(", ")}.`);
  }

  if (breakdown.bio >= 1) {
    reasons.push("Detailed public bio gives a stronger first impression.");
  } else if (breakdown.bio > 0) {
    reasons.push("Has a short public bio.");
  }

  if (breakdown.location > 0) {
    reasons.push(`Location is visible${attendee.location ? `: ${attendee.location}` : ""}.`);
  }

  if (breakdown.publicProfiles >= 1) {
    reasons.push("Multiple public profile signals are available.");
  } else if (breakdown.publicProfiles > 0) {
    reasons.push("At least one external public profile is linked.");
  }

  if (breakdown.profileImage > 0) {
    reasons.push("Public profile image is available.");
  }

  if (reasons.length === 0) {
    reasons.push("Limited public detail is available, so this profile ranks lower.");
  }

  return unique(reasons).slice(0, 3);
}

function collectSharedKeywords(left: AttendeeProfile, right: AttendeeProfile): string[] {
  const leftKeywords = new Set([
    ...sharedListItems(left.interests, right.interests),
    ...sharedListItems(left.goals, right.goals),
    ...sharedListItems(left.education, right.education),
  ]);

  return Array.from(leftKeywords).slice(0, 5);
}

function activeSignalCoverage(left: AttendeeProfile, right: AttendeeProfile): number {
  const keys: Array<keyof MatchWeights> = [
    "interests",
    "location",
    "industry",
    "goals",
    "profession",
    "education",
    "personality",
  ];
  const activeSignals = keys.filter((key) => hasSignalData(key, left, right));
  return activeSignals.length / keys.length;
}

function buildGroupTheme(members: AttendeeProfile[]): string {
  const frequency = new Map<string, number>();

  members.forEach((member) => {
    const uniqueMemberKeywords = new Set([
      ...member.interests,
      ...member.goals,
      ...(member.industry ? [member.industry] : []),
    ]);

    uniqueMemberKeywords.forEach((keyword) => {
      const key = keyword.trim();
      if (!key) {
        return;
      }
      frequency.set(key, (frequency.get(key) ?? 0) + 1);
    });
  });

  const commonKeywords = Array.from(frequency.entries())
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])
    .map(([keyword]) => keyword);

  if (commonKeywords.length > 0) {
    return commonKeywords.slice(0, 2).join(" + ");
  }

  return "High-potential compatibility circle";
}

function sharedListItems(left: string[], right: string[]): string[] {
  const rightLookup = new Map(right.map((entry) => [normalizePhrase(entry), entry.trim()]));

  return unique(
    left
      .map((entry) => rightLookup.get(normalizePhrase(entry)))
      .filter((value): value is string => Boolean(value)),
  );
}

function scoreKeywordLists(left: string[], right: string[]): number {
  return jaccardSimilarity(toKeywordSet(left), toKeywordSet(right));
}

function scoreTextCollections(left: Array<string | undefined>, right: Array<string | undefined>): number {
  return jaccardSimilarity(toKeywordSet(left), toKeywordSet(right));
}

function toKeywordSet(values: Array<string | undefined>): Set<string> {
  const keywords = new Set<string>();

  values.forEach((value) => {
    if (!value) {
      return;
    }

    const normalized = value.toLowerCase().replace(/[^a-z0-9+#/ ]+/g, " ");
    normalized
      .split(/\s+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
      .forEach((token) => keywords.add(token));
  });

  return keywords;
}

function jaccardSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  left.forEach((value) => {
    if (right.has(value)) {
      intersection += 1;
    }
  });

  const union = new Set([...left, ...right]).size;
  return Number((intersection / union).toFixed(2));
}

function normalizePhrase(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function reasonFromSharedItems(prefix: string, items: string[]): string {
  if (items.length === 0) {
    return `${prefix} are present, even if the profile data is sparse.`;
  }

  return `${prefix}: ${items.slice(0, 3).join(", ")}.`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function pairId(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join("::");
}
