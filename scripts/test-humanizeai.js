const { chromium } = require("playwright");

const TEST_TEXT =
  process.env.HUMANIZE_TEXT ||
  "This is a simple AI-generated paragraph. It explains an idea clearly, but it sounds stiff and repetitive. Please make it feel more natural and human.";

const SITE_URL = "https://www.humanizeai.pro/";
const POLL_INTERVAL_MS = 1500;
const RESULT_TIMEOUT_MS = 45000;

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 150 });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  page.on("console", (msg) => {
    console.log(`[browser:${msg.type()}] ${msg.text()}`);
  });

  try {
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log(`Opened ${SITE_URL}`);

    await dismissCookieBanner(page);

    const input = await findInput(page);
    await input.click();
    await input.fill(TEST_TEXT);
    console.log("Filled site input with sample text.");

    console.log("");
    console.log("If a CAPTCHA or other manual check appears, solve it in the browser window.");
    console.log("When the page is ready, press Enter here to continue.");
    await waitForEnter();

    const snapshotBefore = await readOutput(page);
    console.log(`Output before submit: ${snapshotBefore ? JSON.stringify(snapshotBefore.slice(0, 120)) : "[empty]"}`);

    const button = await findHumanizeButton(page);
    await button.click();
    console.log("Clicked Humanize button.");

    const result = await waitForResult(page, snapshotBefore);

    console.log("");
    console.log("Result detected:");
    console.log("=".repeat(60));
    console.log(result);
    console.log("=".repeat(60));
  } finally {
    console.log("");
    console.log("Browser left open for inspection. Press Ctrl+C when you are done.");
  }
}

async function dismissCookieBanner(page) {
  const okButton = page.getByRole("button", { name: /^ok$/i });

  if (await okButton.isVisible().catch(() => false)) {
    await okButton.click();
    console.log("Dismissed cookie banner.");
  }
}

async function findInput(page) {
  const candidates = [
    page.getByLabel(/input textarea/i),
    page.locator('textarea[aria-label*="Input" i]'),
    page.locator('textarea[class*="EditableInput_textArea"]'),
    page.getByPlaceholder(/paste your text here/i),
    page.locator('[contenteditable="true"]').first()
  ];

  for (const candidate of candidates) {
    if (await candidate.count().catch(() => 0)) {
      const isVisible = await candidate.first().isVisible().catch(() => false);
      if (isVisible) {
        return candidate.first();
      }
    }
  }

  throw new Error("Could not find the input field on humanizeai.pro");
}

async function findHumanizeButton(page) {
  const buttons = [
    page.getByRole("button", { name: /humanize ai/i }),
    page.getByRole("button", { name: /humanize/i }),
    page.getByText(/^Humanize AI$/i)
  ];

  for (const candidate of buttons) {
    const count = await candidate.count().catch(() => 0);
    if (count > 0) {
      const button = candidate.first();
      if (await button.isVisible().catch(() => false)) {
        return button;
      }
    }
  }

  const genericButtons = page.locator("button");
  const total = await genericButtons.count();

  for (let index = 0; index < total; index += 1) {
    const button = genericButtons.nth(index);
    const text = ((await button.textContent().catch(() => "")) || "").trim().toLowerCase();
    if (text.includes("humanize") || text.includes("run")) {
      return button;
    }
  }

  throw new Error("Could not find the Humanize button");
}

async function findOutput(page) {
  const candidates = [
    page.locator('textarea#rich-textarea'),
    page.getByLabel(/output textarea/i),
    page.locator('textarea[class*="EditableOutput_textArea"]')
  ];

  for (const candidate of candidates) {
    if ((await candidate.count().catch(() => 0)) > 0) {
      return candidate.first();
    }
  }

  throw new Error("Could not find the output textarea on humanizeai.pro");
}

async function readOutput(page) {
  const output = await findOutput(page);
  const value = await output.inputValue().catch(() => "");
  return (value || "").trim();
}

async function waitForResult(page, snapshotBefore) {
  const started = Date.now();

  while (Date.now() - started < RESULT_TIMEOUT_MS) {
    const current = await readOutput(page);
    if (current && current !== snapshotBefore && current.length > 20) {
      return current;
    }

    await page.waitForTimeout(POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for a changed output result");
}

function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });
}

main().catch((error) => {
  console.error("");
  console.error("Site test failed:");
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
