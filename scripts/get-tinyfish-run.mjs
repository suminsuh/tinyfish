const runId = process.argv[2];

if (!runId) {
  console.error("Usage: node --env-file=.env scripts/get-tinyfish-run.mjs <run-id>");
  process.exit(1);
}

if (!process.env.TINYFISH_API_KEY) {
  console.error("Missing TINYFISH_API_KEY in environment.");
  process.exit(1);
}

const response = await fetch("https://agent.tinyfish.ai/v1/runs/batch", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": process.env.TINYFISH_API_KEY,
  },
  body: JSON.stringify({
    run_ids: [runId],
  }),
});

console.log("status:", response.status);
console.log(await response.text());
