if (!process.env.TINYFISH_API_KEY) {
  console.error("Missing TINYFISH_API_KEY in environment.");
  process.exit(1);
}

const statuses = ["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"];

for (const status of statuses) {
  const url = new URL("https://agent.tinyfish.ai/v1/runs");
  url.searchParams.set("status", status);
  url.searchParams.set("limit", "1");

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": process.env.TINYFISH_API_KEY,
    },
  });

  const text = await response.text();
  console.log(`status=${status} http=${response.status}`);
  console.log(text);
}
