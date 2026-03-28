const eventUrl = process.argv[2];

if (!eventUrl) {
  console.error("Usage: node --env-file=.env scripts/probe-tinyfish-luma.mjs <luma-url>");
  process.exit(1);
}

if (!process.env.TINYFISH_API_KEY) {
  console.error("Missing TINYFISH_API_KEY in environment.");
  process.exit(1);
}

const goal = [
  "Visit this public Luma event page and return JSON only.",
  "If a public attendee, guest, or participant list is visible without signing in, open it and scroll until you have collected enough profiles.",
  "Return data in this exact shape:",
  "{",
  '  "eventTitle": string | null,',
  '  "attendees": [',
  "    {",
  '      "name": string,',
  '      "headline": string | null,',
  '      "company": string | null,',
  '      "bio": string | null,',
  '      "interests": string[],',
  '      "goals": string[],',
  '      "industry": string | null,',
  '      "education": string[],',
  '      "personalityTraits": string[],',
  '      "location": string | null,',
  '      "profileImageUrl": string | null,',
  '      "publicProfileUrls": string[]',
  "    }",
  "  ]",
  "}",
  "Rules:",
  "- Return at most 10 attendees.",
  "- Only include attendees publicly visible on the event page or on directly linked public attendee/profile pages.",
  "- Do not sign in, do not use hidden attendee views, and do not invent missing data.",
  "- Do not include private email addresses, phone numbers, or any non-public contact information.",
  "- Prefer attendees with richer visible bios or linked profile information when the event has a large public list.",
].join("\n");

const response = await fetch("https://agent.tinyfish.ai/v1/automation/run-async", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.TINYFISH_API_KEY,
  },
  body: JSON.stringify({
    url: eventUrl,
    goal,
    browser_profile: "stealth",
    api_integration: "tinyfish-matchmaker",
  }),
});

console.log("status:", response.status);
console.log(await response.text());
