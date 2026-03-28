import { NextResponse } from "next/server";

import { scrapeLumaEventAttendees } from "@/lib/luma";
import { buildSurfaceRankings } from "@/lib/matching";
import { analyzeAttendeesWithOpenAI } from "@/lib/openai";
import { enrichAttendeesWithTinyFish } from "@/lib/tinyfish";
import { resolveMatchmakingOptions, type MatchmakingRequest, type MatchmakingResponse } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as MatchmakingRequest;
    const eventUrl = body.eventUrl?.trim();

    if (!eventUrl) {
      return NextResponse.json({ error: "Paste a public Luma event URL before running matchmaking." }, { status: 400 });
    }

    if (!/^https?:\/\/(www\.)?(lu\.ma|luma\.com)\//i.test(eventUrl)) {
      return NextResponse.json(
        { error: "Use a public `lu.ma` or `luma.com` event link as the input." },
        { status: 400 },
      );
    }

    const options = resolveMatchmakingOptions(body.options);

    const lumaEvent = await scrapeLumaEventAttendees(eventUrl, options.attendeeLimit);

    if (lumaEvent.attendees.length < 1) {
      return NextResponse.json(
        {
          error:
            "TinyFish could not find enough public attendees on that Luma page. Make sure the event is public and the attendee list is visible without signing in.",
        },
        { status: 400 },
      );
    }

    const enrichment = await enrichAttendeesWithTinyFish(lumaEvent.attendees, options);
    const analysis = await analyzeAttendeesWithOpenAI(enrichment.attendees);
    const rankedAttendees = buildSurfaceRankings(analysis.attendees);

    const response: MatchmakingResponse = {
      meta: {
        sourceType: "luma",
        sourceUrl: eventUrl,
        lumaAccessMode: lumaEvent.accessMode,
        eventTitle: lumaEvent.eventTitle,
        attendeeCount: analysis.attendees.length,
        enrichableCount: enrichment.stats.enrichableCount,
        enrichedCount: enrichment.stats.enrichedCount,
        profileEnrichment:
          options.allowPublicEnrichment && enrichment.stats.enrichedCount > 0
            ? "event-plus-linked-profiles"
            : "event-only",
        rankingMode: "surface-signals",
        analysisMode: analysis.stats.analysisMode,
        gptAnalyzedCount: analysis.stats.analyzedCount,
        heuristicAnalyzedCount: analysis.stats.heuristicAnalyzedCount,
        warnings: [...lumaEvent.warnings, ...enrichment.stats.warnings, ...analysis.stats.warnings].slice(0, 10),
      },
      rankedAttendees,
      attendees: analysis.attendees,
    };

    return NextResponse.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
