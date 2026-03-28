# Fishing

AI-powered superficial romantic ranking for Luma events, built with official Luma organizer access, TinyFish, and GPT.

Fishing takes a `lu.ma` or `luma.com` event link and tries the best available access path in this order:

1. Official Luma organizer API, when `LUMA_API_KEY` is configured for a calendar you manage
2. Public Luma page parsing
3. TinyFish public-page browser fallback

It then uses TinyFish to deepen public profile details and GPT to summarize and score visible public signals before producing a sorted shortlist.

## What it does

- Accepts a public Luma event URL instead of a CSV upload.
- Removes the user intake form entirely.
- Uses the official Luma organizer API first when `LUMA_API_KEY` is available and the event belongs to a calendar you manage.
- Parses the public Luma event HTML for visible attendee cards, bios, handles, and photos.
- Uses TinyFish to follow linked public profiles and search for likely public matches by name and visible context.
- Builds structured attendee profiles with public current company, role, education, location, bio, and profile images when available.
- Analyzes all publicly visible attendees it can reach from the event by default.
- Uses GPT to assign a public-signal score, summary, seniority band, archetype tags, and notable public signals from the scraped profile data.
- Falls back to heuristic analysis for every attendee when GPT is unavailable or out of quota, so the ranking still works.
- Adds filters for how many profiles to show, minimum signal score, seniority, industry, location, archetype tags, company visibility, education visibility, and photo presence.
- Adds sorting modes for overall score, GPT signal, company signal, education signal, public presence, and profile polish.

## Privacy boundaries

This implementation is intentionally limited to public information:

- Organizer-mode Luma API access is only for calendars/events you manage with your own API key.
- It only uses attendee information visible on the public Luma page.
- It only follows public links already exposed by the attendee card or linked public profile.
- It does not sign in or use hidden attendee views.
- It does not search for people by email.
- It does not collect private emails, phone numbers, or sensitive attributes.
- It does not infer gender or age.
- It does not predict salary, future income, or net worth.

If a Luma event hides the attendee list behind auth, the app will not be able to build matches from it.

## Environment

Create a local env file from `.env.example`.

```bash
cp .env.example .env.local
```

Set your TinyFish and OpenAI API keys:

```bash
TINYFISH_API_KEY=your_key_here
TINYFISH_BASE_URL=https://agent.tinyfish.ai
LUMA_API_KEY=your_key_here
LUMA_API_BASE_URL=https://public-api.luma.com
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-5-mini
```

TinyFish powers public-profile enrichment, Luma API powers managed guest-list access when available, and OpenAI powers the public-signal summary/scoring layer.

## Run locally

```bash
pnpm install
pnpm dev
```

Then open [http://localhost:3000](http://localhost:3000), paste a public `lu.ma/...` or `luma.com/...` event link, and run Fishing.

## How the pipeline works

1. The server tries the official Luma organizer API when `LUMA_API_KEY` is configured.
2. If organizer access is unavailable, it fetches the public Luma event page and parses the embedded page data.
3. If that still does not expose enough attendees, TinyFish performs a public-page browser fallback.
4. The app normalizes attendee names, bios, links, and tags.
5. TinyFish optionally follows public profile URLs or searches the web for likely public profile matches.
6. TinyFish extracts public signals like current company, role, education, industry, location, bio, and profile image.
7. GPT summarizes each attendee, estimates visible seniority, and assigns public-only signal subscores using the scraped profile data.
8. If GPT is unavailable, Fishing computes heuristic signal reads so every attendee still gets ranked.
9. The UI renders the top picks first and lets you filter the ranked attendee stack.

## Matching signals

The score combines:

- GPT current public-signal score
- company signal score
- education signal score
- public presence score
- profile polish score
- visible current role
- visible current company
- visible education
- visible location
- public bio quality
- public profile image presence
- external profile coverage

Every ranked card includes a short explanation, a GPT or heuristic summary, archetype tags when available, and a per-signal breakdown.

## TinyFish references

- [TinyFish docs home](https://docs.tinyfish.ai/)
- [Common patterns](https://docs.tinyfish.ai/common-patterns)
- [Async automation endpoint](https://docs.tinyfish.ai/api-reference/automation/start-automation-asynchronously)
- [Batch runs endpoint](https://docs.tinyfish.ai/api-reference/runs/get-multiple-runs-by-ids)
