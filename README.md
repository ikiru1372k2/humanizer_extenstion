# HumanizeAI Chrome Extension

HumanizeAI is a Chrome extension that sends long text to `humanizeai.pro` in manageable chunks, collects the rewritten output, and lets you copy or download the final text.

## Features

- Full-page extension UI for pasting and processing long text.
- Basic, Standard, and Deep mode buttons.
- Automatic chunking for large inputs.
- Progress tracking while chunks are processed.
- Resume support for interrupted jobs through Chrome local storage.
- CAPTCHA/verification pause handling with a button to reopen the site tab.
- Copy all output or download it as a `.txt` file.

## Project Structure

```text
.
├── app/
│   ├── app.js          # Extension UI logic, chunking, progress, resume state
│   ├── index.html      # Full-page extension UI
│   └── style.css       # UI styling
├── background.js       # Manifest V3 service worker and site automation bridge
├── content.js          # Content-script helpers for page interaction
├── manifest.json       # Chrome extension manifest
├── package.json        # Node scripts and Playwright dependency
└── scripts/
    └── test-humanizeai.js
```

## Requirements

- Google Chrome or another Chromium-based browser.
- Node.js 18 or newer, only needed for the optional Playwright test.
- A working connection to `https://www.humanizeai.pro/`.

## Install Dependencies

Run this only if you want to use the test script:

```bash
npm install
```

## Load the Extension in Chrome

1. Open Chrome.
2. Go to `chrome://extensions/`.
3. Turn on `Developer mode`.
4. Click `Load unpacked`.
5. Select this project folder.
6. Click the HumanizeAI extension icon.
7. The extension opens the full-page app from `app/index.html`.

## How to Use

1. Paste your AI-generated text into the left text area.
2. Use at least 30 words, because `humanizeai.pro` requires a minimum input size.
3. Choose a mode: `Basic`, `Standard`, or `Deep`.
4. Click `Humanize`.
5. Keep the `humanizeai.pro` tab available while the extension works.
6. If verification or CAPTCHA appears, complete it in the site tab, then return to the extension and click `Humanize` again to resume.
7. When processing finishes, click `Copy All` or `Download .txt`.

## Testing

The repository includes a manual Playwright helper that opens `humanizeai.pro`, fills a sample input, waits for you to handle any verification, and checks for output.

```bash
npm run test:site
```

To test custom text:

```bash
$env:HUMANIZE_TEXT="Paste your test paragraph here"
npm run test:site
```

The browser is intentionally left open after the script runs so you can inspect the result.

## Push This Project to GitHub

Use these commands from the project folder:

```bash
git init
git add .
git commit -m "Initial HumanizeAI extension"
git branch -M main
git remote add origin https://github.com/ikiru1372k2/humanizer_extenstion.git
git push -u origin main
```

If `origin` already exists, use this instead:

```bash
git remote set-url origin https://github.com/ikiru1372k2/humanizer_extenstion.git
git push -u origin main
```

## GitHub Authentication Notes

GitHub no longer accepts account passwords for HTTPS git pushes. If Git asks for a password, use a GitHub personal access token instead.

Basic token steps:

1. Go to GitHub `Settings`.
2. Open `Developer settings`.
3. Open `Personal access tokens`.
4. Create a token with repository access.
5. Use that token as the password when `git push` asks for credentials.

## Development Notes

- Do not commit `node_modules`; it is ignored by `.gitignore`.
- After changing `manifest.json`, `background.js`, or app files, reload the extension from `chrome://extensions/`.
- The extension depends on the current structure of `humanizeai.pro`, so selector changes on that site may require updates in `background.js` or `content.js`.
