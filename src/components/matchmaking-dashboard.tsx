"use client";

import { useEffect, useState } from "react";

import {
  type AttendeeProfile,
  type MatchmakingResponse,
  type RankedAttendee,
  type SeniorityBand,
  type SurfaceSignalBreakdown,
} from "@/lib/types";

const SURFACE_LABELS: Record<keyof SurfaceSignalBreakdown, string> = {
  careerSignal: "GPT signal",
  companySignal: "Company signal",
  educationSignal: "Education signal",
  publicPresence: "Public presence",
  profilePolish: "Profile polish",
  profileImage: "Photo visible",
  bio: "Bio polish",
  title: "Role visible",
  company: "Company visible",
  education: "Education visible",
  location: "Location visible",
  publicProfiles: "External profiles",
};

const SENIORITY_OPTIONS: Array<{ value: "all" | SeniorityBand; label: string }> = [
  { value: "all", label: "Any seniority" },
  { value: "student", label: "Student" },
  { value: "early-career", label: "Early career" },
  { value: "mid-career", label: "Mid career" },
  { value: "senior", label: "Senior" },
  { value: "founder-exec", label: "Founder / exec" },
  { value: "unknown", label: "Unknown" },
];

const SORT_OPTIONS = [
  { value: "overall", label: "Overall Fishing score" },
  { value: "gpt", label: "GPT signal" },
  { value: "company", label: "Company signal" },
  { value: "education", label: "Education signal" },
  { value: "presence", label: "Public presence" },
  { value: "polish", label: "Profile polish" },
] as const;

type SortMode = (typeof SORT_OPTIONS)[number]["value"];

export function MatchmakingDashboard() {
  const [eventUrl, setEventUrl] = useState("");
  const [showCount, setShowCount] = useState(8);
  const [minScore, setMinScore] = useState(50);
  const [sortMode, setSortMode] = useState<SortMode>("overall");
  const [seniorityFilter, setSeniorityFilter] = useState<"all" | SeniorityBand>("all");
  const [industryFilter, setIndustryFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [requireCompany, setRequireCompany] = useState(false);
  const [requireEducation, setRequireEducation] = useState(false);
  const [requirePhoto, setRequirePhoto] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [progressLabel, setProgressLabel] = useState("Ready to cast.");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MatchmakingResponse | null>(null);

  useEffect(() => {
    if (!isRunning) {
      return;
    }

    const startedAt = Date.now();
    const estimatedTotalMs = 45_000;

    const interval = window.setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const ratio = Math.min(0.92, elapsed / estimatedTotalMs);
      const nextProgress = Math.max(8, Math.round(ratio * 100));

      setProgress(nextProgress);
      setEtaSeconds(Math.max(3, Math.ceil((estimatedTotalMs - elapsed) / 1000)));

      if (ratio < 0.18) {
        setProgressLabel("Scanning the public Luma attendee list...");
      } else if (ratio < 0.56) {
        setProgressLabel("TinyFish is enriching linked public profiles...");
      } else if (ratio < 0.86) {
        setProgressLabel("GPT is analyzing public career signals...");
      } else {
        setProgressLabel("Finalizing the Fishing shortlist...");
      }
    }, 500);

    return () => window.clearInterval(interval);
  }, [isRunning]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!eventUrl.trim()) {
      setError("Add a public Luma event link before running Fishing.");
      return;
    }

    setIsRunning(true);
    setError(null);
    setProgress(6);
    setEtaSeconds(45);
    setProgressLabel("Casting the net across all publicly visible attendees...");

    try {
      const response = await fetch("/api/matchmaking", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          eventUrl,
        }),
      });

      const payload = (await response.json()) as MatchmakingResponse & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to run Fishing.");
      }

      setProgress(100);
      setEtaSeconds(0);
      setProgressLabel("Fishing shortlist ready.");
      setResult(payload);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to run Fishing.");
      setProgress(0);
      setEtaSeconds(null);
      setProgressLabel("Run failed.");
      setResult(null);
    } finally {
      setIsRunning(false);
    }
  }

  const matchingRankings = result
    ? applyFilters(result.rankedAttendees, result.attendees, {
        minScore,
        seniorityFilter,
        industryFilter,
        locationFilter,
        tagFilter,
        requireCompany,
        requireEducation,
        requirePhoto,
      })
    : [];

  const sortedAllRankings = result ? sortRankings(result.rankedAttendees, result.attendees, sortMode) : [];
  const filteredRankings = result ? sortRankings(matchingRankings, result.attendees, sortMode).slice(0, showCount) : [];
  const shortlistAverageScore =
    filteredRankings.length > 0
      ? Math.round(filteredRankings.reduce((sum, entry) => sum + entry.score, 0) / filteredRankings.length)
      : 0;
  const taggedProfiles =
    result?.attendees.filter((attendee) => (attendee.analysis?.archetypeTags.length || 0) > 0).length ?? 0;

  return (
    <main className="page-shell">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">Fishing</p>
          <h1>Find the most superficially impressive people in the room.</h1>
          <p className="hero-copy">
            Paste a public Luma event link and Fishing uses TinyFish plus GPT to rank attendees by visible public
            signals like role, company, education, location, photo, and profile polish.
          </p>
        </div>

        <div className="hero-stat-grid">
          <div className="stat-card">
            <span>Source</span>
            <strong>Luma + TinyFish</strong>
            <p>Public event cards and linked public profiles like LinkedIn, websites, and Luma bios.</p>
          </div>
          <div className="stat-card">
            <span>Scoring</span>
            <strong>GPT signal read</strong>
            <p>GPT summarizes public career/status signals and combines them with profile completeness.</p>
          </div>
          <div className="stat-card">
            <span>Output</span>
            <strong>Filtered shortlist</strong>
            <p>Ranked attendees with fast filters for how many you want to inspect.</p>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <form className="panel control-panel" onSubmit={handleSubmit}>
          <div className="panel-header">
            <div>
              <p className="eyebrow">Run Fishing</p>
              <h2>One link in, ranked shortlist out</h2>
            </div>
          </div>

          <label className="field-label" htmlFor="event-url">
            Luma event URL
          </label>
          <input
            className="url-input"
            id="event-url"
            inputMode="url"
            onChange={(event) => setEventUrl(event.target.value)}
            placeholder="https://luma.com/your-event"
            type="url"
            value={eventUrl}
          />

          <div className="field-grid">
            <label className="number-card" htmlFor="show-count">
              <span>How many profiles to show</span>
              <input
                id="show-count"
                max={30}
                min={1}
                onChange={(event) => setShowCount(Number(event.target.value))}
                type="number"
                value={showCount}
              />
            </label>

            <div className="number-card">
              <span>Profiles analyzed</span>
              <p className="meta-copy">Fishing analyzes all publicly visible attendees it can access from the event.</p>
            </div>
          </div>

          {error ? <p className="error-banner">{error}</p> : null}

          {isRunning ? (
            <div className="note-card">
              <h3>Analysis progress</h3>
              <div aria-hidden="true" className="progress-shell">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <p>
                {progressLabel}
                {etaSeconds !== null ? ` Estimated time remaining: about ${etaSeconds}s.` : ""}
              </p>
            </div>
          ) : null}

          <div className="note-card">
            <h3>What GPT does here</h3>
            <p>
              GPT summarizes each public profile, labels visible seniority, and assigns a current public-signal score. It
              does not infer gender, age, salary, net worth, or future earnings.
            </p>
          </div>

          <div className="note-card">
            <h3>Organizer mode</h3>
            <p>
              If <code>LUMA_API_KEY</code> is configured for a calendar you manage, Fishing will try the official Luma
              organizer API first before falling back to the public event page.
            </p>
          </div>

          <div className="footer-row">
            <p className="meta-copy">
              Public data only. Fishing stays on public profiles and does not sign in to hidden attendee views.
            </p>
            <button className="button-primary" disabled={isRunning} type="submit">
              {isRunning ? "Casting..." : "Cast the net"}
            </button>
          </div>
        </form>

        <aside className="panel info-panel">
          <div className="panel-header compact">
            <div>
              <p className="eyebrow">Filters</p>
              <h2>Trim the shortlist fast</h2>
            </div>
          </div>

          <div className="field-grid">
            <label className="number-card" htmlFor="min-score">
              <span>Minimum signal score</span>
              <input
                id="min-score"
                max={100}
                min={0}
                onChange={(event) => setMinScore(Number(event.target.value))}
                type="number"
                value={minScore}
              />
            </label>

            <label className="number-card" htmlFor="sort-mode">
              <span>Sort by</span>
              <select id="sort-mode" onChange={(event) => setSortMode(event.target.value as SortMode)} value={sortMode}>
                {SORT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="number-card" htmlFor="seniority-filter">
              <span>Seniority filter</span>
              <select id="seniority-filter" onChange={(event) => setSeniorityFilter(event.target.value as "all" | SeniorityBand)} value={seniorityFilter}>
                {SENIORITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="number-card" htmlFor="industry-filter">
              <span>Industry contains</span>
              <input
                id="industry-filter"
                onChange={(event) => setIndustryFilter(event.target.value)}
                type="text"
                value={industryFilter}
              />
            </label>

            <label className="number-card" htmlFor="location-filter">
              <span>Location contains</span>
              <input
                id="location-filter"
                onChange={(event) => setLocationFilter(event.target.value)}
                type="text"
                value={locationFilter}
              />
            </label>

            <label className="number-card" htmlFor="tag-filter">
              <span>Tag contains</span>
              <input id="tag-filter" onChange={(event) => setTagFilter(event.target.value)} type="text" value={tagFilter} />
            </label>
          </div>

          <div className="field-grid">
            <label className="toggle-card">
              <div>
                <h3>Must show company</h3>
                <p>Only keep profiles with a visible current company.</p>
              </div>
              <label className="switch">
                <input checked={requireCompany} onChange={(event) => setRequireCompany(event.target.checked)} type="checkbox" />
                <span />
              </label>
            </label>

            <label className="toggle-card">
              <div>
                <h3>Must show education</h3>
                <p>Only keep profiles with public education data.</p>
              </div>
              <label className="switch">
                <input checked={requireEducation} onChange={(event) => setRequireEducation(event.target.checked)} type="checkbox" />
                <span />
              </label>
            </label>

            <label className="toggle-card">
              <div>
                <h3>Must have photo</h3>
                <p>Only keep profiles with a public profile image.</p>
              </div>
              <label className="switch">
                <input checked={requirePhoto} onChange={(event) => setRequirePhoto(event.target.checked)} type="checkbox" />
                <span />
              </label>
            </label>
          </div>

          <div className="note-card">
            <h3>Useful extras</h3>
            <p>
              This version adds the filters that are safest and most useful from public data: score, seniority, industry,
              location, company visibility, education visibility, photo presence, and how many profiles to display.
            </p>
          </div>
        </aside>
      </section>

      {result ? (
        <section className="results-shell">
          <div className="panel summary-panel">
            <div className="panel-header compact">
              <div>
                <p className="eyebrow">Run Summary</p>
                <h2>{result.meta.eventTitle || "Fishing run"}</h2>
                <p className="meta-copy">{result.meta.sourceUrl}</p>
              </div>
              <span className="badge">{result.meta.analysisMode === "gpt-enhanced" ? "GPT enhanced" : "Heuristic only"}</span>
            </div>

            <div className="hero-stat-grid">
              <div className="stat-card">
                <span>Luma access</span>
                <strong>
                  {result.meta.lumaAccessMode === "managed-api"
                    ? "Organizer API"
                    : result.meta.lumaAccessMode === "tinyfish-browser"
                      ? "TinyFish fallback"
                      : "Public page"}
                </strong>
                <p>Shows whether the run came from your managed Luma API access or public scraping.</p>
              </div>
              <div className="stat-card">
                <span>Attendees</span>
                <strong>{result.meta.attendeeCount}</strong>
                <p>Public attendee profiles parsed from the event.</p>
              </div>
              <div className="stat-card">
                <span>TinyFish enriched</span>
                <strong>{result.meta.enrichedCount}</strong>
                <p>Profiles deepened with linked public-profile data.</p>
              </div>
              <div className="stat-card">
                <span>GPT analyzed</span>
                <strong>{result.meta.gptAnalyzedCount}</strong>
                <p>Attendees that received a GPT summary and signal score.</p>
              </div>
              <div className="stat-card">
                <span>Heuristic reads</span>
                <strong>{result.meta.heuristicAnalyzedCount}</strong>
                <p>Profiles that still got fallback analysis when GPT was unavailable.</p>
              </div>
              <div className="stat-card">
                <span>Filtered now</span>
                <strong>{matchingRankings.length}</strong>
                <p>Profiles matching your current filters before the visible cap.</p>
              </div>
              <div className="stat-card">
                <span>Avg shortlist</span>
                <strong>{shortlistAverageScore}%</strong>
                <p>The average Fishing score across the visible shortlist.</p>
              </div>
              <div className="stat-card">
                <span>Tagged profiles</span>
                <strong>{taggedProfiles}</strong>
                <p>Profiles with archetype tags like operator, researcher, or founder-exec.</p>
              </div>
            </div>

            {result.meta.warnings.length > 0 ? (
              <div className="warning-stack">
                {result.meta.warnings.map((warning) => (
                  <p className="warning-banner" key={warning}>
                    {warning}
                  </p>
                ))}
              </div>
            ) : null}
          </div>

          <div className="results-stack">
            <section className="panel">
              <div className="panel-header compact">
                <div>
                  <p className="eyebrow">Shortlist</p>
                  <h2>{filteredRankings.length} filtered profiles</h2>
                </div>
              </div>

              <div className="stack-list">
                {filteredRankings.length === 0 ? (
                  <p className="empty-state">No profiles matched those filters. Lower the score threshold or loosen the requirements.</p>
                ) : null}

                {filteredRankings.map((entry) => {
                  const attendee = findAttendeeProfile(result.attendees, entry.attendee.id);
                  if (!attendee) {
                    return null;
                  }

                  return (
                    <article className="pair-card" key={entry.attendee.id}>
                      <div className="pair-header">
                        <div className="pair-people">
                          <ProfileChip image={entry.attendee.profileImageUrl} name={entry.attendee.name} subtitle={formatParticipantSubtitle(attendee)} />
                        </div>
                        <ScoreBadge score={entry.score} />
                      </div>

                      {attendee.analysis ? (
                        <p className="detail-copy">
                          <strong>GPT summary:</strong> {attendee.analysis.summary}
                        </p>
                      ) : null}

                      <div className="reason-grid">
                        {entry.reasons.map((reason) => (
                          <span className="reason-pill" key={reason}>
                            {reason}
                          </span>
                        ))}
                      </div>

                      <div className="breakdown-grid">
                        {(Object.entries(entry.breakdown) as Array<[keyof SurfaceSignalBreakdown, number]>).map(([key, value]) => (
                          <div className="breakdown-row" key={key}>
                            <span>{SURFACE_LABELS[key]}</span>
                            <strong>{Math.round(value * 100)}%</strong>
                          </div>
                        ))}
                      </div>

                      <AttendeeDetails attendee={attendee} />
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="panel">
              <div className="panel-header compact">
                <div>
                  <p className="eyebrow">Full Stack</p>
                  <h2>All ranked attendee profiles</h2>
                </div>
              </div>

              <div className="recommendation-grid">
                {sortedAllRankings.map((entry) => {
                  const attendee = findAttendeeProfile(result.attendees, entry.attendee.id);
                  if (!attendee) {
                    return null;
                  }

                  return (
                    <article className="recommendation-card" key={attendee.id}>
                      <ProfileChip image={attendee.profileImageUrl} name={attendee.name} subtitle={formatParticipantSubtitle(attendee)} />
                      <p className="detail-copy">
                        <strong>Fishing score:</strong> {entry.score}%
                      </p>
                      {attendee.analysis ? (
                        <p className="detail-copy">
                          <strong>Seniority:</strong> {formatSeniority(attendee.analysis.seniorityBand)}
                        </p>
                      ) : null}
                      <p className="detail-copy">
                        <strong>Richness proxy:</strong> Current public career/status signal only. No future salary prediction.
                      </p>
                      <AttendeeDetails attendee={attendee} />
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        </section>
      ) : null}
    </main>
  );
}

function AttendeeDetails({ attendee }: { attendee: AttendeeProfile }) {
  return (
    <div className="detail-stack">
      {attendee.analysis?.summary ? (
        <p className="detail-copy">
          <strong>GPT read:</strong> {attendee.analysis.summary}
        </p>
      ) : null}
      {attendee.analysis ? <DetailLine label="Seniority" value={formatSeniority(attendee.analysis.seniorityBand)} /> : null}
      {attendee.analysis ? <DetailLine label="GPT signal score" value={`${attendee.analysis.careerSignalScore}%`} /> : null}
      {attendee.analysis ? <DetailLine label="Company signal" value={`${attendee.analysis.companySignalScore}%`} /> : null}
      {attendee.analysis ? <DetailLine label="Education signal" value={`${attendee.analysis.educationSignalScore}%`} /> : null}
      {attendee.analysis ? <DetailLine label="Public presence" value={`${attendee.analysis.publicPresenceScore}%`} /> : null}
      {attendee.analysis ? <DetailLine label="Profile polish" value={`${attendee.analysis.profilePolishScore}%`} /> : null}
      {attendee.bio ? <p className="detail-copy">{attendee.bio}</p> : null}
      <DetailLine label="Current company" value={attendee.company} />
      <DetailLine label="Current role" value={attendee.title || attendee.profession} />
      <DetailLine label="Industry" value={attendee.industry} />
      <DetailLine label="Location" value={attendee.location} />
      <TagList title="Education" values={attendee.education} />
      <TagList title="Interests" values={attendee.interests} />
      <TagList title="Archetype tags" values={attendee.analysis?.archetypeTags || []} />
      <TagList title="GPT notable signals" values={attendee.analysis?.notableSignals || []} />
      {attendee.sourceProfiles.length > 0 ? (
        <div>
          <p className="detail-label">Profile sources</p>
          <div className="source-links">
            {attendee.sourceProfiles.map((source) => (
              <a className="source-link" href={source.url} key={`${attendee.id}-${source.url}`} rel="noreferrer" target="_blank">
                {source.platform}
              </a>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DetailLine({ label, value }: { label: string; value?: string }) {
  if (!value) {
    return null;
  }

  return (
    <p className="detail-copy">
      <strong>{label}:</strong> {value}
    </p>
  );
}

function TagList({ title, values }: { title: string; values: string[] }) {
  if (values.length === 0) {
    return null;
  }

  return (
    <div>
      <p className="detail-label">{title}</p>
      <div className="tag-list">
        {values.slice(0, 8).map((value) => (
          <span className="tag-chip" key={`${title}-${value}`}>
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function ProfileChip({ name, subtitle, image }: { name: string; subtitle?: string; image?: string }) {
  return (
    <div className="profile-chip">
      {image ? (
        <img alt={name} className="avatar-image" src={image} />
      ) : (
        <div className="avatar-fallback">{name.slice(0, 1).toUpperCase()}</div>
      )}
      <div>
        <strong>{name}</strong>
        <p>{subtitle || "Public attendee profile"}</p>
      </div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  return <span className="score-badge">{score}%</span>;
}

function formatParticipantSubtitle(attendee: AttendeeProfile): string {
  return [attendee.title || attendee.profession, attendee.company, attendee.location].filter(Boolean).slice(0, 2).join(" · ");
}

function findAttendeeProfile(attendees: AttendeeProfile[], attendeeId: string): AttendeeProfile | undefined {
  return attendees.find((attendee) => attendee.id === attendeeId);
}

function formatSeniority(value: SeniorityBand): string {
  switch (value) {
    case "student":
      return "Student";
    case "early-career":
      return "Early career";
    case "mid-career":
      return "Mid career";
    case "senior":
      return "Senior";
    case "founder-exec":
      return "Founder / exec";
    default:
      return "Unknown";
  }
}

function applyFilters(
  entries: RankedAttendee[],
  attendees: AttendeeProfile[],
  filters: {
    minScore: number;
    seniorityFilter: "all" | SeniorityBand;
    industryFilter: string;
    locationFilter: string;
    tagFilter: string;
    requireCompany: boolean;
    requireEducation: boolean;
    requirePhoto: boolean;
  },
): RankedAttendee[] {
  return entries.filter((entry) => {
    const attendee = attendees.find((candidate) => candidate.id === entry.attendee.id);
    if (!attendee) {
      return false;
    }

    if (entry.score < filters.minScore) {
      return false;
    }

    if (filters.seniorityFilter !== "all" && attendee.analysis?.seniorityBand !== filters.seniorityFilter) {
      return false;
    }

    if (filters.industryFilter.trim()) {
      const haystack = `${attendee.industry || ""} ${attendee.title || ""} ${attendee.profession || ""}`.toLowerCase();
      if (!haystack.includes(filters.industryFilter.trim().toLowerCase())) {
        return false;
      }
    }

    if (filters.locationFilter.trim()) {
      const haystack = `${attendee.location || ""}`.toLowerCase();
      if (!haystack.includes(filters.locationFilter.trim().toLowerCase())) {
        return false;
      }
    }

    if (filters.tagFilter.trim()) {
      const haystack = (attendee.analysis?.archetypeTags || []).join(" ").toLowerCase();
      if (!haystack.includes(filters.tagFilter.trim().toLowerCase())) {
        return false;
      }
    }

    if (filters.requireCompany && !attendee.company) {
      return false;
    }

    if (filters.requireEducation && attendee.education.length === 0) {
      return false;
    }

    if (filters.requirePhoto && !attendee.profileImageUrl) {
      return false;
    }

    return true;
  });
}

function sortRankings(entries: RankedAttendee[], attendees: AttendeeProfile[], sortMode: SortMode): RankedAttendee[] {
  return [...entries].sort((left, right) => {
    const leftAttendee = attendees.find((candidate) => candidate.id === left.attendee.id);
    const rightAttendee = attendees.find((candidate) => candidate.id === right.attendee.id);

    const leftMetric = resolveSortMetric(left, leftAttendee, sortMode);
    const rightMetric = resolveSortMetric(right, rightAttendee, sortMode);

    if (rightMetric !== leftMetric) {
      return rightMetric - leftMetric;
    }

    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.attendee.name.localeCompare(right.attendee.name);
  });
}

function resolveSortMetric(entry: RankedAttendee, attendee: AttendeeProfile | undefined, sortMode: SortMode): number {
  if (!attendee?.analysis) {
    return entry.score;
  }

  switch (sortMode) {
    case "gpt":
      return attendee.analysis.careerSignalScore;
    case "company":
      return attendee.analysis.companySignalScore;
    case "education":
      return attendee.analysis.educationSignalScore;
    case "presence":
      return attendee.analysis.publicPresenceScore;
    case "polish":
      return attendee.analysis.profilePolishScore;
    default:
      return entry.score;
  }
}
