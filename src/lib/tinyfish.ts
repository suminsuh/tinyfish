import { calculateProfileRichness, normalizePublicUrl, uniqueStrings } from "@/lib/attendee-utils";
import { scrapeLumaPublicProfile, type LumaProfileEnrichment } from "@/lib/luma-profile";
import type { AttendeeProfile, MatchmakingOptions, PublicProfileSource, SourcePlatform } from "@/lib/types";

type TinyFishRunResponse = {
  run_id: string | null;
  error?: { message?: string } | null;
};

type TinyFishRunBatchResponse = {
  run_ids: string[] | null;
  error?: { message?: string } | null;
};

type TinyFishRun = {
  run_id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  goal?: string;
  result?: unknown;
  error?: { message?: string } | null;
};

type TinyFishRunsListResponse = {
  data: TinyFishRun[];
  pagination?: {
    total?: number;
  } | null;
};

type TinyFishAutomationTask = {
  url: string;
  goal: string;
  browserProfile?: "lite" | "stealth";
};

type EnrichmentStats = {
  attendeeCount: number;
  enrichableCount: number;
  enrichedCount: number;
  warnings: string[];
};

type EnrichmentTask = {
  attendeeId: string;
  url: string;
  platform: SourcePlatform;
};

type DiscoveryResult = {
  urls: string[];
  company?: string;
  headline?: string;
  bio?: string;
  profession?: string;
  industry?: string;
  profileImageUrl?: string;
};

type LocalEnrichmentResult = {
  attendees: AttendeeProfile[];
  enrichedAttendeeIds: Set<string>;
};

type DiscoveryTask = {
  attendeeId: string;
  searchUrl: string;
  goal: string;
};

type EnrichmentExecutionResult = {
  completedRuns: Map<string, TinyFishRun>;
  pendingRuns: number;
  failedRuns: number;
  missingRuns: number;
  queuedTaskCount: number;
  rateLimitWarning?: string;
  idleWarning?: string;
};

const TINYFISH_BASE_URL = (process.env.TINYFISH_BASE_URL || "https://agent.tinyfish.ai").replace(/\/$/, "");
const DEFAULT_PROXY_COUNTRY_CODE = process.env.TINYFISH_PROXY_COUNTRY_CODE?.trim().toUpperCase();

export async function runTinyFishAutomation(task: TinyFishAutomationTask): Promise<unknown> {
  return runTinyFishAutomationWithApiKey(getTinyFishApiKey(), task);
}

export function extractTinyFishObject(result: unknown): Record<string, unknown> {
  const extracted = extractStructuredValue(result);
  return isRecord(extracted) ? extracted : {};
}

export async function enrichAttendeesWithTinyFish(
  attendees: AttendeeProfile[],
  options: MatchmakingOptions,
): Promise<{ attendees: AttendeeProfile[]; stats: EnrichmentStats }> {
  const apiKey = process.env.TINYFISH_API_KEY;
  const warnings: string[] = [];
  let workingAttendees = attendees.map(cloneAttendee);
  const enrichedAttendeeIds = new Set<string>();

  const lumaHydration = await hydrateAttendeesFromLumaProfiles(workingAttendees, options, warnings);
  workingAttendees = lumaHydration.attendees;
  lumaHydration.enrichedAttendeeIds.forEach((attendeeId) => enrichedAttendeeIds.add(attendeeId));

  if (!apiKey) {
    warnings.push("`TINYFISH_API_KEY` is not set. External public profile discovery was skipped.");
    return {
      attendees: workingAttendees,
      stats: {
        attendeeCount: workingAttendees.length,
        enrichableCount: countEnrichableAttendees(workingAttendees, options),
        enrichedCount: enrichedAttendeeIds.size,
        warnings: uniqueStrings(warnings).slice(0, 12),
      },
    };
  }

  let remainingRunBudget = options.maxTotalEnrichmentRuns;
  const cachedLinkedRuns = await loadRecentCompletedRunsByUrl(
    apiKey,
    workingAttendees.flatMap((attendee) => selectEnrichmentUrls(attendee, options.maxProfileUrlsPerAttendee)),
  );

  const linkedTasks = buildPrimaryLinkedProfileTasks(workingAttendees, options, cachedLinkedRuns);
  const prioritizedLinkedTasks = linkedTasks.slice(0, remainingRunBudget);
  if (linkedTasks.length > prioritizedLinkedTasks.length) {
    warnings.push(
      `Only the top ${prioritizedLinkedTasks.length} linked public profile URLs were queued first to stay within TinyFish run limits.`,
    );
  }

  const linkedExecution = await executeEnrichmentTasksInBatches(apiKey, prioritizedLinkedTasks, options);
  remainingRunBudget -= linkedExecution.queuedTaskCount;
  applyEnrichmentWarnings(warnings, linkedExecution, "profile");
  workingAttendees = mergeCompletedProfileRuns(workingAttendees, prioritizedLinkedTasks, linkedExecution.completedRuns, enrichedAttendeeIds);

  const discovery = await discoverPublicProfiles(apiKey, workingAttendees, options, warnings, remainingRunBudget);
  workingAttendees = discovery.attendees;

  const finalAttendees = workingAttendees;

  return {
    attendees: finalAttendees,
    stats: {
      attendeeCount: finalAttendees.length,
      enrichableCount: countEnrichableAttendees(finalAttendees, options),
      enrichedCount: enrichedAttendeeIds.size,
      warnings: uniqueStrings(warnings).slice(0, 12),
    },
  };
}

async function discoverPublicProfiles(
  apiKey: string,
  attendees: AttendeeProfile[],
  options: MatchmakingOptions,
  warnings: string[],
  remainingRunBudget: number,
): Promise<{ attendees: AttendeeProfile[]; queuedTaskCount: number }> {
  if (!options.allowPublicEnrichment || options.maxProfileDiscoverySearches <= 0 || remainingRunBudget <= 0) {
    return { attendees, queuedTaskCount: 0 };
  }

  const discoveryTasks = attendees
    .filter((attendee) => needsProfileDiscovery(attendee))
    .slice(0, Math.min(options.maxProfileDiscoverySearches, remainingRunBudget))
    .map((attendee) => ({
      attendeeId: attendee.id,
      searchUrl: buildSearchUrl(buildDiscoveryQuery(attendee)),
      goal: buildDiscoveryGoal(attendee),
    }));

  if (discoveryTasks.length === 0) {
    return { attendees, queuedTaskCount: 0 };
  }

  const attendeeMap = new Map(attendees.map((attendee) => [attendee.id, cloneAttendee(attendee)]));
  const execution = await executeDiscoveryTasksInBatches(apiKey, discoveryTasks, options);
  applyEnrichmentWarnings(warnings, execution, "search");

  discoveryTasks.forEach((task) => {
    const run = execution.completedRuns.get(discoveryTaskKey(task));
    if (!run?.result) {
      return;
    }

    const attendee = attendeeMap.get(task.attendeeId);
    if (!attendee) {
      return;
    }

    const discovery = normalizeDiscoveryResult(run.result);
    const merged = cloneAttendee(attendee);
    merged.publicProfileUrls = uniqueStrings([...merged.publicProfileUrls, ...discovery.urls]);
    merged.company = choosePreferredText(merged.company, discovery.company);
    merged.title = choosePreferredText(merged.title, discovery.headline);
    merged.profession = choosePreferredText(merged.profession, discovery.profession);
    merged.industry = choosePreferredText(merged.industry, discovery.industry);
    merged.bio = choosePreferredText(merged.bio, discovery.bio);
    merged.profileImageUrl = choosePreferredText(merged.profileImageUrl, discovery.profileImageUrl);
    merged.profileRichness = calculateProfileRichness(merged);
    attendeeMap.set(task.attendeeId, merged);
  });

  return {
    attendees: Array.from(attendeeMap.values()),
    queuedTaskCount: execution.queuedTaskCount,
  };
}

async function hydrateAttendeesFromLumaProfiles(
  attendees: AttendeeProfile[],
  options: MatchmakingOptions,
  warnings: string[],
): Promise<LocalEnrichmentResult> {
  if (!options.allowPublicEnrichment) {
    return { attendees, enrichedAttendeeIds: new Set<string>() };
  }

  const candidates = attendees
    .map((attendee) => ({
      attendeeId: attendee.id,
      url: selectLumaProfileUrl(attendee.publicProfileUrls),
    }))
    .filter((candidate): candidate is { attendeeId: string; url: string } => Boolean(candidate.url));

  if (candidates.length === 0) {
    return { attendees, enrichedAttendeeIds: new Set<string>() };
  }

  const attendeeMap = new Map(attendees.map((attendee) => [attendee.id, cloneAttendee(attendee)]));
  const enrichedAttendeeIds = new Set<string>();
  const hydratedProfiles = await mapWithConcurrency(
    candidates,
    Math.min(Math.max(1, options.maxConcurrentEnrichments), candidates.length),
    async (candidate) => {
      try {
        const enrichment = await scrapeLumaPublicProfile(candidate.url);
        return { attendeeId: candidate.attendeeId, enrichment };
      } catch (error) {
        warnings.push(`Direct Luma profile read failed for ${candidate.url}: ${formatError(error)}`);
        return { attendeeId: candidate.attendeeId, enrichment: null };
      }
    },
  );

  hydratedProfiles.forEach(({ attendeeId, enrichment }) => {
    if (!enrichment) {
      return;
    }

    const attendee = attendeeMap.get(attendeeId);
    if (!attendee) {
      return;
    }

    const merged = mergeLumaProfileIntoAttendee(attendee, enrichment);
    attendeeMap.set(attendeeId, merged.attendee);

    if (merged.changed) {
      enrichedAttendeeIds.add(attendeeId);
    }
  });

  return {
    attendees: Array.from(attendeeMap.values()),
    enrichedAttendeeIds,
  };
}

function buildPrimaryLinkedProfileTasks(
  attendees: AttendeeProfile[],
  options: MatchmakingOptions,
  cachedRuns: Map<string, TinyFishRun>,
): EnrichmentTask[] {
  return attendees.flatMap((attendee) => {
    if (!isEnrichmentAllowed(attendee, options)) {
      return [];
    }

    const primaryUrl = selectPrimaryEnrichmentUrl(attendee, options, cachedRuns);
    if (!primaryUrl || isAlreadyEnriched(attendee, primaryUrl)) {
      return [];
    }

    return [
      {
        attendeeId: attendee.id,
        url: primaryUrl,
        platform: detectPlatform(primaryUrl),
      },
    ];
  });
}

function mergeCompletedProfileRuns(
  attendees: AttendeeProfile[],
  tasks: EnrichmentTask[],
  completedRuns: Map<string, TinyFishRun>,
  enrichedAttendeeIds: Set<string>,
): AttendeeProfile[] {
  const attendeeMap = new Map(attendees.map((attendee) => [attendee.id, cloneAttendee(attendee)]));

  tasks.forEach((task) => {
    const run = completedRuns.get(enrichmentTaskKey(task));
    if (!run?.result) {
      return;
    }

    const attendee = attendeeMap.get(task.attendeeId);
    if (!attendee) {
      return;
    }

    const extractedSource = normalizeSource(task.url, task.platform, run.result);
    if (!hasMeaningfulSourceData(extractedSource)) {
      return;
    }

    attendeeMap.set(task.attendeeId, mergeSourceIntoAttendee(attendee, extractedSource));
    enrichedAttendeeIds.add(task.attendeeId);
  });

  return Array.from(attendeeMap.values());
}

function applyEnrichmentWarnings(
  warnings: string[],
  execution: EnrichmentExecutionResult,
  taskLabel: "profile" | "search",
): void {
  if (execution.rateLimitWarning) {
    warnings.push(execution.rateLimitWarning);
  }

  if (execution.idleWarning) {
    warnings.push(execution.idleWarning);
  }

  if (execution.pendingRuns > 0) {
    warnings.push(
      `${execution.pendingRuns} TinyFish ${taskLabel} run${execution.pendingRuns === 1 ? " is" : "s are"} still pending, so this response used the available public data instead.`,
    );
  }

  if (execution.failedRuns > 0) {
    warnings.push(
      `${execution.failedRuns} TinyFish ${taskLabel} run${execution.failedRuns === 1 ? " failed" : "s failed"} and were skipped in this response.`,
    );
  }

  if (execution.missingRuns > 0) {
    warnings.push(
      `${execution.missingRuns} TinyFish ${taskLabel} run${execution.missingRuns === 1 ? " did" : "s did"} not return a result in time.`,
    );
  }
}

async function executeDiscoveryTasksInBatches(
  apiKey: string,
  tasks: DiscoveryTask[],
  options: MatchmakingOptions,
): Promise<EnrichmentExecutionResult> {
  return executeTinyFishBatches(
    apiKey,
    tasks.map((task) => ({
      key: discoveryTaskKey(task),
      automation: {
        url: task.searchUrl,
        goal: task.goal,
        browserProfile: "lite" as const,
      },
    })),
    options,
  );
}

async function executeEnrichmentTasksInBatches(
  apiKey: string,
  tasks: EnrichmentTask[],
  options: MatchmakingOptions,
): Promise<EnrichmentExecutionResult> {
  return executeTinyFishBatches(
    apiKey,
    tasks.map((task) => ({
      key: enrichmentTaskKey(task),
      automation: {
        url: task.url,
        goal: buildExtractionGoal(task.platform),
        browserProfile: task.platform === "linkedin" || task.platform === "instagram" ? "stealth" : "lite",
      },
    })),
    options,
  );
}

async function executeTinyFishBatches(
  apiKey: string,
  tasks: Array<{ key: string; automation: TinyFishAutomationTask }>,
  options: MatchmakingOptions,
): Promise<EnrichmentExecutionResult> {
  const completedRuns = new Map<string, TinyFishRun>();
  const cachedRuns = await loadRecentCompletedRunsByUrl(
    apiKey,
    tasks.map((task) => task.automation.url),
  );
  let pendingRuns = 0;
  let failedRuns = 0;
  let missingRuns = 0;
  let queuedTaskCount = 0;
  let rateLimitWarning: string | undefined;
  let idleWarning: string | undefined;
  let nextIndex = 0;
  let idleCycles = 0;
  const queueTasks = tasks.filter((task) => {
    const cachedRun = cachedRuns.get(task.automation.url.toLowerCase());
    if (cachedRun?.result) {
      completedRuns.set(task.key, cachedRun);
      return false;
    }

    return true;
  });

  while (nextIndex < queueTasks.length) {
    const availableSlots = await getAvailableTinyFishSlots(apiKey, options);

    if (availableSlots <= 0) {
      idleCycles += 1;
      if (idleCycles >= 4) {
        idleWarning =
          "TinyFish already has too many active runs on this account, so the remaining public profile jobs were left for a later retry.";
        break;
      }

      await wait(5_000);
      continue;
    }

    idleCycles = 0;
    const batchSize = Math.min(options.maxTinyFishBatchSize, availableSlots, queueTasks.length - nextIndex);
    const batch = queueTasks.slice(nextIndex, nextIndex + batchSize);

    try {
      const runIds = await queueAutomationBatch(
        apiKey,
        batch.map((task) => task.automation),
      );
      queuedTaskCount += runIds.length;
      nextIndex += batch.length;

      const runLookup = await waitForRuns(apiKey, runIds);
      runIds.forEach((runId, index) => {
        const run = runLookup.get(runId);
        if (!run) {
          missingRuns += 1;
          return;
        }

        if (run.status === "COMPLETED" && run.result) {
          completedRuns.set(batch[index].key, run);
          return;
        }

        if (run.status === "PENDING" || run.status === "RUNNING") {
          pendingRuns += 1;
          return;
        }

        failedRuns += 1;
      });
    } catch (error) {
      if (isTinyFishRateLimitError(error)) {
        rateLimitWarning =
          rateLimitWarning ||
          parseTinyFishErrorMessage(error) ||
          "TinyFish has too many active runs right now, so additional public profile jobs were skipped.";
        await wait(5_000);
        continue;
      }

      failedRuns += batch.length;
      nextIndex += batch.length;
    }
  }

  return {
    completedRuns,
    pendingRuns,
    failedRuns,
    missingRuns,
    queuedTaskCount,
    rateLimitWarning,
    idleWarning,
  };
}

function needsProfileDiscovery(attendee: AttendeeProfile): boolean {
  const externalUrls = attendee.publicProfileUrls.filter((url) => !isLumaUrl(url));
  return externalUrls.length === 0;
}

function isAlreadyEnriched(attendee: AttendeeProfile, url: string): boolean {
  return attendee.sourceProfiles.some((source) => source.url.toLowerCase() === url.toLowerCase());
}

function selectPrimaryEnrichmentUrl(
  attendee: AttendeeProfile,
  options: MatchmakingOptions,
  cachedRuns: Map<string, TinyFishRun>,
): string | undefined {
  return [...selectEnrichmentUrls(attendee, options.maxProfileUrlsPerAttendee)].sort((left, right) => {
    const leftCached = cachedRuns.has(left.toLowerCase()) ? 1 : 0;
    const rightCached = cachedRuns.has(right.toLowerCase()) ? 1 : 0;

    if (leftCached !== rightCached) {
      return rightCached - leftCached;
    }

    return scoreEnrichmentUrl(right) - scoreEnrichmentUrl(left);
  })[0];
}

function discoveryTaskKey(task: DiscoveryTask): string {
  return `${task.attendeeId}::${task.searchUrl}`;
}

function enrichmentTaskKey(task: EnrichmentTask): string {
  return `${task.attendeeId}::${task.url}`;
}

function selectEnrichmentUrls(attendee: AttendeeProfile, maxProfileUrlsPerAttendee: number): string[] {
  return [...attendee.publicProfileUrls]
    .filter((url) => !isLumaUrl(url))
    .sort((left, right) => scoreEnrichmentUrl(right) - scoreEnrichmentUrl(left))
    .slice(0, Math.max(1, maxProfileUrlsPerAttendee));
}

function scoreEnrichmentUrl(url: string): number {
  const hostname = safeHostname(url);

  if (hostname.includes("linkedin.")) {
    return 6;
  }

  if (hostname.includes("github.")) {
    return 5;
  }

  if (hostname.includes("about.") || hostname.includes("team.") || hostname.includes("company.")) {
    return 4;
  }

  if (hostname.includes("luma.com") || hostname.includes("lu.ma")) {
    return 3;
  }

  if (hostname.includes("instagram.") || hostname.includes("x.com") || hostname.includes("twitter.")) {
    return 2;
  }

  return 1;
}

function buildDiscoveryQuery(attendee: AttendeeProfile): string {
  return uniqueStrings([
    attendee.name,
    attendee.company,
    attendee.title,
    attendee.profession,
    attendee.industry,
    attendee.bio?.split(/[.!?]/g)[0],
  ]).join(" ");
}

function buildSearchUrl(query: string): string {
  return `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

function buildDiscoveryGoal(attendee: AttendeeProfile): string {
  return [
    "Read these public search results and return JSON only.",
    `Identify likely public profile links for this person: ${attendee.name}.`,
    attendee.company ? `Company or organization hint: ${attendee.company}.` : "",
    attendee.title ? `Role hint: ${attendee.title}.` : "",
    attendee.bio ? `Bio hint: ${attendee.bio}.` : "",
    "Return data in this exact shape:",
    "{",
    '  "urls": string[],',
    '  "company": string | null,',
    '  "headline": string | null,',
    '  "bio": string | null,',
    '  "profession": string | null,',
    '  "industry": string | null,',
    '  "profileImageUrl": string | null',
    "}",
    "Rules:",
    "- Only include URLs if the result title or snippet clearly matches the person's name and context.",
    "- Prefer LinkedIn, GitHub, X, Instagram, company bio pages, personal websites, and Luma public profile pages.",
    "- Return at most 3 URLs.",
    "- Only include public information shown in the search results page.",
    "- If the match is unclear, return an empty url list and null fields.",
  ]
    .filter(Boolean)
    .join("\n");
}

function normalizeDiscoveryResult(result: unknown): DiscoveryResult {
  const objectResult = extractTinyFishObject(result);
  const headline = readString(objectResult, ["headline", "title"]);
  const derivedCareer = deriveCareerSnapshot(headline);

  return {
    urls: uniqueStrings([
      ...readStringList(objectResult, ["urls", "publicProfileUrls", "profileUrls", "links"]),
      normalizePublicUrl(readString(objectResult, ["linkedinUrl"]) || ""),
      normalizePublicUrl(readString(objectResult, ["instagramUrl"]) || ""),
      normalizePublicUrl(readString(objectResult, ["websiteUrl"]) || ""),
      normalizePublicUrl(readString(objectResult, ["profileUrl"]) || ""),
    ]),
    company: readString(objectResult, ["company", "organization", "employer", "currentCompany"]) || derivedCareer.company,
    headline,
    bio: readString(objectResult, ["bio", "summary", "about"]),
    profession: readString(objectResult, ["profession", "role"]) || derivedCareer.profession,
    industry: readString(objectResult, ["industry", "sector"]),
    profileImageUrl: readString(objectResult, ["profileImageUrl", "image"]),
  };
}

function getTinyFishApiKey(): string {
  const apiKey = process.env.TINYFISH_API_KEY;

  if (!apiKey) {
    throw new Error("Set `TINYFISH_API_KEY` before using TinyFish enrichment.");
  }

  return apiKey;
}

async function runTinyFishAutomationWithApiKey(apiKey: string, task: TinyFishAutomationTask): Promise<unknown> {
  const runId = await queueAutomation(apiKey, task);
  const runLookup = await waitForRuns(apiKey, [runId]);
  const run = runLookup.get(runId);

  if (!run) {
    throw new Error("TinyFish did not return a run result.");
  }

  if (run.status !== "COMPLETED") {
    throw new Error(run.error?.message || `TinyFish run ended with status ${run.status.toLowerCase()}.`);
  }

  return run.result;
}

function countEnrichableAttendees(attendees: AttendeeProfile[], options: MatchmakingOptions): number {
  return attendees.filter((attendee) => isEnrichmentAllowed(attendee, options)).length;
}

function isEnrichmentAllowed(attendee: AttendeeProfile, options: MatchmakingOptions): boolean {
  return options.allowPublicEnrichment && selectEnrichmentUrls(attendee, options.maxProfileUrlsPerAttendee).length > 0;
}

async function queueAutomation(apiKey: string, task: TinyFishAutomationTask): Promise<string> {
  const body: Record<string, unknown> = {
    url: task.url,
    goal: task.goal,
    browser_profile: task.browserProfile ?? "lite",
    api_integration: "tinyfish-matchmaker",
  };

  const proxyConfig = buildProxyConfig();
  if (proxyConfig) {
    body.proxy_config = proxyConfig;
  }

  const response = await fetchJson<TinyFishRunResponse>(`${TINYFISH_BASE_URL}/v1/automation/run-async`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.run_id) {
    throw new Error(response.error?.message || "TinyFish did not return a run_id.");
  }

  return response.run_id;
}

async function queueAutomationBatch(apiKey: string, tasks: TinyFishAutomationTask[]): Promise<string[]> {
  if (tasks.length === 0) {
    return [];
  }

  const response = await fetchJson<TinyFishRunBatchResponse>(`${TINYFISH_BASE_URL}/v1/automation/run-batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      runs: tasks.map((task) => {
        const body: Record<string, unknown> = {
          url: task.url,
          goal: task.goal,
          browser_profile: task.browserProfile ?? "lite",
          api_integration: "tinyfish-matchmaker",
        };

        const proxyConfig = buildProxyConfig();
        if (proxyConfig) {
          body.proxy_config = proxyConfig;
        }

        return body;
      }),
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.run_ids || response.run_ids.length === 0) {
    throw new Error(response.error?.message || "TinyFish did not return run_ids for the batch.");
  }

  return response.run_ids;
}

function buildProxyConfig(): Record<string, unknown> | undefined {
  if (!DEFAULT_PROXY_COUNTRY_CODE && process.env.TINYFISH_PROXY_ENABLED !== "true") {
    return undefined;
  }

  return {
    enabled: true,
    country_code: DEFAULT_PROXY_COUNTRY_CODE || undefined,
  };
}

async function waitForRuns(apiKey: string, runIds: string[]): Promise<Map<string, TinyFishRun>> {
  const lookup = new Map<string, TinyFishRun>();
  if (runIds.length === 0) {
    return lookup;
  }

  const maxAttempts = 20;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const batches = chunk(runIds, 100);
    const runs = (
      await Promise.all(
        batches.map((batchIds) =>
          fetchJson<{ data: TinyFishRun[] }>(`${TINYFISH_BASE_URL}/v1/runs/batch`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-API-Key": apiKey,
            },
            body: JSON.stringify({ run_ids: batchIds }),
            signal: AbortSignal.timeout(20_000),
          }),
        ),
      )
    ).flatMap((batch) => batch.data);

    runs.forEach((run) => lookup.set(run.run_id, run));

    const allComplete = runIds.every((runId) => {
      const status = lookup.get(runId)?.status;
      return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
    });

    if (allComplete) {
      return lookup;
    }

    await wait(3_000);
  }

  return lookup;
}

async function getAvailableTinyFishSlots(apiKey: string, options: MatchmakingOptions): Promise<number> {
  const activeRuns = await countActiveTinyFishRuns(apiKey);
  return Math.max(0, options.maxTinyFishActiveRuns - activeRuns);
}

async function countActiveTinyFishRuns(apiKey: string): Promise<number> {
  const [pending, running] = await Promise.all([
    countRunsByStatus(apiKey, "PENDING"),
    countRunsByStatus(apiKey, "RUNNING"),
  ]);

  return pending + running;
}

async function countRunsByStatus(
  apiKey: string,
  status: TinyFishRun["status"],
): Promise<number> {
  const url = new URL(`${TINYFISH_BASE_URL}/v1/runs`);
  url.searchParams.set("status", status);
  url.searchParams.set("limit", "1");

  const response = await fetchJson<TinyFishRunsListResponse>(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (typeof response.pagination?.total === "number") {
    return response.pagination.total;
  }

  return response.data.length;
}

async function loadRecentCompletedRunsByUrl(
  apiKey: string,
  urls: string[],
): Promise<Map<string, TinyFishRun>> {
  const targets = new Set(urls.map((url) => url.toLowerCase()));
  const lookup = new Map<string, TinyFishRun>();

  if (targets.size === 0) {
    return lookup;
  }

  const url = new URL(`${TINYFISH_BASE_URL}/v1/runs`);
  url.searchParams.set("status", "COMPLETED");
  url.searchParams.set("limit", "100");

  const response = await fetchJson<TinyFishRunsListResponse>(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    signal: AbortSignal.timeout(20_000),
  });

  response.data.forEach((run) => {
    const runUrl = extractRunUrl(run.goal);
    if (!runUrl || !run.result) {
      return;
    }

    const normalizedUrl = runUrl.toLowerCase();
    if (!targets.has(normalizedUrl) || lookup.has(normalizedUrl)) {
      return;
    }

    lookup.set(normalizedUrl, run);
  });

  return lookup;
}

function extractRunUrl(goal: string | undefined): string | undefined {
  if (!goal) {
    return undefined;
  }

  const match = goal.match(/Navigate to (https?:\/\/\S+?) to complete the goal:/);
  return match?.[1];
}

function buildExtractionGoal(platform: SourcePlatform): string {
  return [
    `Read this public ${platform} profile page and return JSON only.`,
    "Extract a public profile snapshot in this exact shape:",
    "{",
    '  "fullName": string | null,',
    '  "company": string | null,',
    '  "headline": string | null,',
    '  "bio": string | null,',
    '  "interests": string[],',
    '  "goals": string[],',
    '  "profession": string | null,',
    '  "industry": string | null,',
    '  "education": string[],',
    '  "location": string | null,',
    '  "profileImageUrl": string | null',
    "}",
    "Rules:",
    "- Only include information explicitly visible on the public page.",
    "- Prioritize the person's current company, current role, education, location, public bio, and profile image when available.",
    "- Do not infer age, ethnicity, religion, politics, relationship status, phone number, or private contact information.",
    "- Do not infer future earnings, wealth, or future job titles.",
    "- If a field is missing, use null or an empty array.",
    "- Keep list values short and specific.",
  ].join("\n");
}

function normalizeSource(url: string, platform: SourcePlatform, result: unknown): PublicProfileSource {
  const objectResult = extractTinyFishObject(result);
  const headline = readString(objectResult, ["headline", "title", "currentTitle", "currentRole"]);
  const derivedCareer = deriveCareerSnapshot(headline);

  return {
    url,
    platform,
    company: readString(objectResult, [
      "company",
      "currentCompany",
      "organization",
      "employer",
      "workplace",
      "currentEmployer",
    ]) || derivedCareer.company,
    headline,
    bio: readString(objectResult, ["bio", "summary", "about"]),
    interests: readStringList(objectResult, ["interests", "topics"]),
    goals: readStringList(objectResult, ["goals", "networkingGoals"]),
    education: readStringList(objectResult, ["education", "schools", "universities"]),
    profession: readString(objectResult, ["profession", "role", "currentRole", "occupation"]) || derivedCareer.profession,
    industry: readString(objectResult, ["industry", "sector"]),
    location: readString(objectResult, ["location"]),
    profileImageUrl: readString(objectResult, ["profileImageUrl", "profile_image_url", "image"]),
  };
}

function mergeSourceIntoAttendee(attendee: AttendeeProfile, source: PublicProfileSource): AttendeeProfile {
  const merged = cloneAttendee(attendee);

  merged.company = choosePreferredText(merged.company, source.company);
  merged.title = choosePreferredText(merged.title, source.headline);
  merged.profession = choosePreferredText(merged.profession, source.profession);
  merged.industry = choosePreferredText(merged.industry, source.industry);
  merged.bio = choosePreferredText(merged.bio, source.bio);
  merged.location = choosePreferredText(merged.location, source.location);
  merged.profileImageUrl = choosePreferredText(merged.profileImageUrl, source.profileImageUrl);
  merged.interests = uniqueStrings([...merged.interests, ...source.interests]);
  merged.goals = uniqueStrings([...merged.goals, ...source.goals]);
  merged.education = uniqueStrings([...merged.education, ...source.education]);
  merged.sourceProfiles = [...merged.sourceProfiles, source];
  merged.profileRichness = calculateProfileRichness(merged);

  return merged;
}

function choosePreferredText(currentValue?: string, nextValue?: string): string | undefined {
  if (!nextValue) {
    return currentValue;
  }

  if (!currentValue || nextValue.length > currentValue.length) {
    return nextValue;
  }

  return currentValue;
}

function deriveCareerSnapshot(headline?: string): { profession?: string; company?: string } {
  const trimmed = headline?.trim();
  if (!trimmed) {
    return {};
  }

  const atMatch = trimmed.match(/^(.+?)\s+(?:at|@)\s+([^|,]+?)(?:\s*[|,].*)?$/i);
  if (atMatch) {
    const profession = atMatch[1]?.trim();
    const company = atMatch[2]?.trim();

    return {
      profession: profession || undefined,
      company: company || undefined,
    };
  }

  return {};
}

function hasMeaningfulSourceData(source: PublicProfileSource): boolean {
  return Boolean(
    source.company ||
      source.headline ||
      source.bio ||
      source.profession ||
      source.industry ||
      source.location ||
      source.profileImageUrl ||
      source.interests.length ||
      source.goals.length ||
      source.education.length,
  );
}

function detectPlatform(url: string): SourcePlatform {
  const hostname = new URL(url).hostname.toLowerCase();

  if (hostname.includes("linkedin.")) {
    return "linkedin";
  }

  if (hostname.includes("instagram.")) {
    return "instagram";
  }

  if (hostname.includes("lu.ma") || hostname.includes("luma.com")) {
    return "luma";
  }

  if (hostname) {
    return "website";
  }

  return "unknown";
}

function isLumaUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname.includes("lu.ma") || hostname.includes("luma.com");
  } catch {
    return false;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function cloneAttendee(attendee: AttendeeProfile): AttendeeProfile {
  return {
    ...attendee,
    interests: [...attendee.interests],
    goals: [...attendee.goals],
    education: [...attendee.education],
    personalityTraits: [...attendee.personalityTraits],
    publicProfileUrls: [...attendee.publicProfileUrls],
    sourceProfiles: attendee.sourceProfiles.map((source) => ({
      ...source,
      interests: [...source.interests],
      goals: [...source.goals],
      education: [...source.education],
    })),
  };
}

function mergeLumaProfileIntoAttendee(
  attendee: AttendeeProfile,
  enrichment: LumaProfileEnrichment,
): { attendee: AttendeeProfile; changed: boolean } {
  const beforeFingerprint = buildAttendeeFingerprint(attendee);
  const mergedAttendee = mergeSourceIntoAttendee(attendee, enrichment.source);

  mergedAttendee.publicProfileUrls = uniqueStrings([...mergedAttendee.publicProfileUrls, ...enrichment.publicProfileUrls]);
  mergedAttendee.profileRichness = calculateProfileRichness(mergedAttendee);

  return {
    attendee: mergedAttendee,
    changed: beforeFingerprint !== buildAttendeeFingerprint(mergedAttendee),
  };
}

function selectLumaProfileUrl(urls: string[]): string | undefined {
  return urls.find((url) => isLumaUserUrl(url));
}

function isLumaUserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.hostname.includes("lu.ma") || parsed.hostname.includes("luma.com")) && parsed.pathname.startsWith("/user/");
  } catch {
    return false;
  }
}

function buildAttendeeFingerprint(attendee: AttendeeProfile): string {
  return JSON.stringify({
    company: attendee.company,
    title: attendee.title,
    profession: attendee.profession,
    industry: attendee.industry,
    bio: attendee.bio,
    location: attendee.location,
    profileImageUrl: attendee.profileImageUrl,
    interests: attendee.interests,
    goals: attendee.goals,
    education: attendee.education,
    publicProfileUrls: attendee.publicProfileUrls,
    sourceProfileUrls: attendee.sourceProfiles.map((source) => source.url),
  });
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`TinyFish request failed (${response.status}): ${body}`);
  }

  return (await response.json()) as T;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  });

  await Promise.all(workers);
  return results;
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

function extractStructuredValue(value: unknown): unknown {
  if (typeof value === "string") {
    return parseJsonLikeString(value);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const extracted = extractStructuredValue(item);
      if (isRecord(extracted)) {
        return extracted;
      }
    }
    return value;
  }

  if (isRecord(value)) {
    const nestedKeys = ["result", "output", "data", "json", "content", "response", "final", "final_output", "text", "message"];

    for (const key of nestedKeys) {
      if (key in value) {
        const extracted = extractStructuredValue(value[key]);
        if (isRecord(extracted)) {
          return extracted;
        }
      }
    }

    return value;
  }

  return {};
}

function parseJsonLikeString(value: string): unknown {
  const trimmed = value.trim();
  const candidates = [trimmed];
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fenceMatch) {
    candidates.unshift(fenceMatch[1].trim());
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(trimmed.slice(objectStart, objectEnd + 1));
  }

  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    candidates.push(trimmed.slice(arrayStart, arrayEnd + 1));
  }

  for (const candidate of candidates) {
    try {
      return extractStructuredValue(JSON.parse(candidate));
    } catch {
      continue;
    }
  }

  return {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function isTinyFishRateLimitError(error: unknown): boolean {
  const message = formatError(error);
  return message.includes("RATE_LIMIT_EXCEEDED") || message.includes("Too many pending runs");
}

function parseTinyFishErrorMessage(error: unknown): string | undefined {
  const message = formatError(error);
  const jsonStart = message.indexOf("{");

  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(message.slice(jsonStart)) as { error?: { message?: string } };
      if (parsed.error?.message) {
        return `TinyFish is currently rate-limited: ${parsed.error.message}`;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function getTinyFishConcurrency(options: MatchmakingOptions): number {
  return Math.max(1, Math.min(options.maxConcurrentEnrichments, 2));
}
