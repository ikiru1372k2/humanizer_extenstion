const JOB_STORAGE_KEY = "humanizeai.job";
const MAX_RETRIES_PER_CHUNK = 3;
const NORMAL_DELAY_MS = 1800;
const RETRY_DELAY_MS = 3000;
const SLOWDOWN_DELAY_MS = 4000;
const SLOWDOWN_CHUNK_COUNT = 3;
const PAUSE_ON_RATE_LIMIT_MS = 30000;

let chunks = [];
let currentChunkIndex = 0;
let outputText = "";
let isRunning = false;
let selectedMode = "standard";
let sourceText = "";
let jobSourceText = "";
let retryCounts = {};
let slowdownChunksRemaining = 0;
let status = "idle";
let processingTimer = null;
let currentJobId = null;

const inputArea = document.getElementById("input-area");
const outputArea = document.getElementById("output-area");
const inputWordCount = document.getElementById("input-word-count");
const outputWordCount = document.getElementById("output-word-count");
const humanizeBtn = document.getElementById("humanize-btn");
const clearBtn = document.getElementById("clear-btn");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");
const progressShell = document.getElementById("progress-shell");
const progressFill = document.getElementById("progress-fill");
const progressText = document.getElementById("progress-text");
const statusText = document.getElementById("status-text");
const warningBanner = document.getElementById("warning-banner");
const warningText = document.getElementById("warning-text");
const verifyBtn = document.getElementById("verify-btn");
const openFullPageBtn = document.getElementById("open-full-page-btn");
const modeButtons = Array.from(document.querySelectorAll(".mode-btn"));
const CHUNK_MIN_WORDS = 160;
const CHUNK_PREFERRED_MAX_WORDS = 180;
const CHUNK_HARD_MAX_WORDS = 195;
const SITE_MIN_WORDS = 30;

let failedChunks = [];

initialize();

async function initialize() {
  bindEvents();
  await restorePersistedJob();
  refreshUi();
}

function bindEvents() {
  inputArea.addEventListener("input", handleInputChange);
  humanizeBtn.addEventListener("click", handleHumanizeClick);
  clearBtn.addEventListener("click", handleClear);
  copyBtn.addEventListener("click", handleCopyAll);
  downloadBtn.addEventListener("click", handleDownload);
  openFullPageBtn.addEventListener("click", handleOpenFullPage);
  verifyBtn.addEventListener("click", handleOpenVerificationTab);

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectedMode = button.dataset.mode || "standard";
      updateModeButtons();
      persistJob();
    });
  });
}

function handleInputChange() {
  sourceText = inputArea.value;
  updateWordCount(inputWordCount, sourceText);

  if (!sourceText.trim() && !isRunning) {
    statusText.textContent = "Ready.";
    warningBanner.hidden = true;
    warningText.textContent = "";
    verifyBtn.hidden = true;
  } else if (!isRunning && countWords(sourceText) < SITE_MIN_WORDS) {
    statusText.textContent = `Enter at least ${SITE_MIN_WORDS} words.`;
  }

  refreshUi();
}

async function handleHumanizeClick() {
  if (isRunning) {
    return;
  }

  const nextSourceText = inputArea.value.trim();

  if (!nextSourceText) {
    refreshUi();
    return;
  }

  if (countWords(nextSourceText) < SITE_MIN_WORDS) {
    statusText.textContent = `Enter at least ${SITE_MIN_WORDS} words.`;
    showWarning(`humanizeai.pro requires at least ${SITE_MIN_WORDS} words before processing starts.`);
    refreshUi();
    return;
  }

  sourceText = nextSourceText;
  clearScheduledWork();

  if (!currentJobId || currentChunkIndex >= chunks.length || sourceText !== jobSourceText) {
    outputArea.textContent = "";
    outputText = "";
    chunks = chunkText(sourceText);
    currentChunkIndex = 0;
    retryCounts = {};
    slowdownChunksRemaining = 0;
    failedChunks = [];
    currentJobId = `job-${Date.now()}`;
    jobSourceText = sourceText;
  }

  isRunning = true;
  status = "running";
  progressShell.hidden = false;
  warningBanner.hidden = true;
  warningText.textContent = "";
  verifyBtn.hidden = true;
  updateWordCount(outputWordCount, outputText);
  updateProgressDisplay(
    currentChunkIndex === 0
      ? `0 / ${chunks.length} chunks completed`
      : `${currentChunkIndex} / ${chunks.length} chunks completed`,
    currentChunkIndex,
    chunks.length,
    countWords(outputText)
  );
  statusText.textContent = currentChunkIndex === 0 ? "Connecting to humanizeai.pro." : `Resuming from chunk ${currentChunkIndex + 1}.`;

  await persistJob();
  processNextChunk();
}

function processNextChunk() {
  if (!isRunning) {
    return;
  }

  if (currentChunkIndex >= chunks.length) {
    finishJob();
    return;
  }

  const currentChunk = chunks[currentChunkIndex];
  const requestId = `${currentJobId}-chunk-${currentChunkIndex}-${Date.now()}`;

  statusText.textContent = `Processing chunk ${currentChunkIndex + 1} of ${chunks.length}.`;
  updateProgressDisplay(
    `${currentChunkIndex} / ${chunks.length} chunks completed`,
    currentChunkIndex,
    chunks.length,
    countWords(outputText)
  );
  persistJob();

  try {
    chrome.runtime.sendMessage(
      {
        action: "HUMANIZE_CHUNK",
        requestId,
        chunk: currentChunk,
        chunkIndex: currentChunkIndex,
        totalChunks: chunks.length,
        mode: selectedMode
      },
      (response) => {
        if (chrome.runtime.lastError) {
          handleResponseError("message_channel_closed", true);
          return;
        }

        if (!response) {
          handleResponseError("empty_response", true);
          return;
        }

        if (response.success) {
          handleChunkSuccess(response.result);
          return;
        }

        if (response.error === "captcha_required") {
          handleCaptchaPause();
          return;
        }

        handleResponseError(response.error || "unknown_error", Boolean(response.retryable), response.details);
      }
    );
  } catch (error) {
    handleResponseError("message_channel_closed", true);
  }
}

function handleChunkSuccess(result) {
  const cleanResult = String(result || "").trim();

  if (!cleanResult) {
    handleResponseError("empty_result", true);
    return;
  }

  if (slowdownChunksRemaining > 0) {
    slowdownChunksRemaining -= 1;
  }

  outputText = outputText ? `${outputText} ${cleanResult}` : cleanResult;
  appendChunkToOutput(cleanResult);
  updateWordCount(outputWordCount, outputText);
  retryCounts[currentChunkIndex] = 0;
  currentChunkIndex += 1;
  status = "running";
  statusText.textContent = `Chunk ${currentChunkIndex} complete.`;
  updateProgressDisplay(
    `${Math.min(currentChunkIndex, chunks.length)} / ${chunks.length} chunks completed`,
    currentChunkIndex,
    chunks.length,
    countWords(outputText)
  );
  persistJob();
  scheduleNextChunk(getCurrentDelay());
}

function handleResponseError(error, retryable, details = null) {
  const normalizedError = String(error || "unknown_error");
  const attemptCount = (retryCounts[currentChunkIndex] || 0) + 1;
  retryCounts[currentChunkIndex] = attemptCount;
  const isPausedForRateLimit =
    (normalizedError === "timeout" || normalizedError === "empty_result") && applyRateLimitBackoff();

  if (normalizedError === "selector_not_found") {
    showWarning(`Selector not found on humanizeai.pro${details && details.target ? ` (${details.target})` : ""}.`);
  } else if (normalizedError === "message_channel_closed") {
    showWarning(`Connection interrupted. Resume is available from chunk ${currentChunkIndex + 1}.`);
  } else if (normalizedError === "captcha_tab_unavailable") {
    showWarning("Captcha tab was unavailable. A retry will be attempted.");
  }

  if (isPausedForRateLimit) {
    statusText.textContent = "Paused briefly after repeated slow responses.";
    persistJob();
    return;
  }

  if (retryable && attemptCount < MAX_RETRIES_PER_CHUNK) {
    status = "retrying";
    statusText.textContent = `Retrying chunk ${currentChunkIndex + 1} (${attemptCount}/${MAX_RETRIES_PER_CHUNK}).`;
    persistJob();
    scheduleNextChunk(RETRY_DELAY_MS);
    return;
  }

  markChunkFailed(currentChunkIndex, normalizedError);
  failedChunks.push(currentChunkIndex);
  retryCounts[currentChunkIndex] = 0;
  currentChunkIndex += 1;
  status = "running";
  statusText.textContent = `Skipped chunk ${currentChunkIndex}.`;
  persistJob();
  scheduleNextChunk(getCurrentDelay());
}

function handleCaptchaPause() {
  clearScheduledWork();
  isRunning = false;
  status = "waiting_for_captcha";
  statusText.textContent = "Verification needed. Open the site tab, complete it, then press Humanize to resume.";
  showWarning("Verification needed on humanizeai.pro before this chunk can continue.", true);
  persistJob();
  refreshUi();
}

function applyRateLimitBackoff() {
  if (slowdownChunksRemaining > 0) {
    showWarning("Slow down detected. Waiting 30 seconds before continuing.");
    status = "paused";
    persistJob();
    scheduleNextChunk(PAUSE_ON_RATE_LIMIT_MS);
    return true;
  }

  slowdownChunksRemaining = SLOWDOWN_CHUNK_COUNT;
  showWarning("Slow down detected. Using a slower pace for the next few chunks.");
  return false;
}

function getCurrentDelay() {
  return slowdownChunksRemaining > 0 ? SLOWDOWN_DELAY_MS : NORMAL_DELAY_MS;
}

function scheduleNextChunk(delayMs) {
  clearScheduledWork();
  processingTimer = window.setTimeout(() => {
    processingTimer = null;
    processNextChunk();
  }, delayMs);
}

function finishJob() {
  isRunning = false;
  status = "completed";
  statusText.textContent = "Done.";
  updateProgressDisplay(`Done - ${chunks.length} / ${chunks.length} chunks completed`, chunks.length, chunks.length, countWords(outputText));
  persistJob();
  clearScheduledWork();
}

function appendChunkToOutput(text) {
  const span = document.createElement("span");
  span.className = "chunk-new";
  span.textContent = `${text} `;
  outputArea.appendChild(span);
  outputArea.scrollTop = outputArea.scrollHeight;

  window.setTimeout(() => {
    span.classList.remove("chunk-new");
  }, 1500);
}

function markChunkFailed(index, reason = "failed") {
  const span = document.createElement("span");
  span.className = "chunk-failed";
  span.textContent = `[Chunk ${index + 1} failed - ${reason} - skipped] `;
  outputArea.appendChild(span);
  outputArea.scrollTop = outputArea.scrollHeight;
}

function updateProgressDisplay(label, completedChunks, totalChunks, wordsDone) {
  const safeTotal = totalChunks || 0;
  const progressRatio = safeTotal === 0 ? 0 : Math.min(completedChunks / safeTotal, 1);
  progressFill.style.width = `${progressRatio * 100}%`;
  progressText.textContent = label;
  progressShell.hidden = safeTotal === 0 && label === "Starting";
}

function updateModeButtons() {
  modeButtons.forEach((button) => {
    const isActive = button.dataset.mode === selectedMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function refreshUi() {
  updateWordCount(inputWordCount, inputArea.value);
  updateWordCount(outputWordCount, outputText);
  updateModeButtons();
  humanizeBtn.disabled = isRunning || countWords(inputArea.value) < SITE_MIN_WORDS;
  progressShell.hidden = chunks.length === 0 && !isRunning && status !== "completed";
}

function handleClear() {
  clearScheduledWork();
  isRunning = false;
  chunks = [];
  currentChunkIndex = 0;
  outputText = "";
  retryCounts = {};
  slowdownChunksRemaining = 0;
  failedChunks = [];
  status = "idle";
  sourceText = "";
  jobSourceText = "";
  currentJobId = null;
  inputArea.value = "";
  outputArea.textContent = "";
  progressFill.style.width = "0%";
  progressText.textContent = "Starting.";
  progressShell.hidden = true;
  warningBanner.hidden = true;
  warningText.textContent = "";
  verifyBtn.hidden = true;
  statusText.textContent = "Ready.";
  chrome.storage.local.remove(JOB_STORAGE_KEY);
  refreshUi();
}

async function handleCopyAll() {
  try {
    await navigator.clipboard.writeText(outputText);
    const originalText = copyBtn.textContent;
    copyBtn.textContent = "Copied!";
    window.setTimeout(() => {
      copyBtn.textContent = originalText;
    }, 2000);
  } catch (error) {
    showWarning("Clipboard access failed.");
  }
}

function handleDownload() {
  const blob = new Blob([outputText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "humanized-output.txt";
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleOpenFullPage() {
  try {
    chrome.runtime.sendMessage({ action: "OPEN_APP" });
  } catch (error) {
    showWarning("Could not open the full page view.");
  }
}

function handleOpenVerificationTab() {
  try {
    chrome.runtime.sendMessage({ action: "OPEN_HUMANIZER_TAB" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.success) {
        showWarning("Could not open the verification tab. Try the site tab manually.", true);
      }
    });
  } catch (error) {
    showWarning("Could not open the verification tab. Try the site tab manually.", true);
  }
}

async function restorePersistedJob() {
  const stored = await chrome.storage.local.get(JOB_STORAGE_KEY);
  const job = stored[JOB_STORAGE_KEY];

  if (!job) {
    return;
  }

  currentJobId = job.jobId || null;
  sourceText = job.sourceText || "";
  jobSourceText = sourceText;
  chunks = Array.isArray(job.chunks) ? job.chunks : [];
  currentChunkIndex = Number.isInteger(job.currentChunkIndex) ? job.currentChunkIndex : 0;
  outputText = job.outputText || "";
  selectedMode = job.selectedMode || "standard";
  retryCounts = job.retryCounts || {};
  failedChunks = Array.isArray(job.failedChunks) ? job.failedChunks : [];
  slowdownChunksRemaining = Number(job.slowdownChunksRemaining || 0);
  status = job.status || "idle";

  inputArea.value = sourceText;
  outputArea.textContent = "";

  if (outputText) {
    const span = document.createElement("span");
    span.textContent = outputText;
    outputArea.appendChild(span);
  }

  if (chunks.length > 0) {
    progressShell.hidden = false;
    updateProgressDisplay(
      status === "completed"
        ? `Done - ${chunks.length} / ${chunks.length} chunks completed`
        : `${Math.min(currentChunkIndex, chunks.length)} / ${chunks.length} chunks completed`,
      currentChunkIndex,
      chunks.length,
      countWords(outputText)
    );
  }

  if (status === "waiting_for_captcha" && currentChunkIndex < chunks.length) {
    showWarning(`Verification needed before resuming chunk ${currentChunkIndex + 1}.`, true);
    statusText.textContent = `Paused at chunk ${currentChunkIndex + 1}. Press Humanize to resume.`;
  } else if (status && status !== "completed" && currentChunkIndex < chunks.length) {
    showWarning(`Recovered an interrupted job. Click Humanize to resume from chunk ${currentChunkIndex + 1}.`);
    statusText.textContent = `Recovered job at chunk ${currentChunkIndex + 1}.`;
  } else if (status === "completed") {
    statusText.textContent = "Recovered completed job.";
  }
}

async function persistJob() {
  if (!currentJobId && chunks.length === 0 && !sourceText && !outputText) {
    return;
  }

  await chrome.storage.local.set({
    [JOB_STORAGE_KEY]: {
      jobId: currentJobId,
      sourceText: sourceText,
      chunks: chunks,
      currentChunkIndex: currentChunkIndex,
      outputText: outputText,
      selectedMode: selectedMode,
      retryCounts: retryCounts,
      failedChunks: failedChunks,
      delayMode: slowdownChunksRemaining > 0 ? "slow" : "normal",
      slowdownChunksRemaining: slowdownChunksRemaining,
      status: status,
      lastError: warningBanner.hidden ? null : warningText.textContent
    }
  });
}

function showWarning(message, showVerificationAction = false) {
  warningBanner.hidden = false;
  warningText.textContent = message;
  verifyBtn.hidden = !showVerificationAction;
}

function clearScheduledWork() {
  if (processingTimer !== null) {
    window.clearTimeout(processingTimer);
    processingTimer = null;
  }
}

function countWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function updateWordCount(element, text) {
  const words = countWords(text);
  element.textContent = `${words.toLocaleString()} words`;
}

function chunkText(text, targetWords = 170) {
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    console.log("Total chunks:", 0);
    return [];
  }

  const sentenceLikeParts = normalizedText
    .split(/(?<=[.?!])\s+(?=[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunksOut = [];
  let currentSentences = [];
  let currentWordCount = 0;

  for (const part of sentenceLikeParts) {
    const sentenceSegments = splitLongSentence(part, targetWords);

    for (const sentence of sentenceSegments) {
      const sentenceWordCount = countWords(sentence);
      const wouldExceedPreferredMax =
        currentWordCount >= CHUNK_MIN_WORDS && currentWordCount + sentenceWordCount > CHUNK_PREFERRED_MAX_WORDS;
      const wouldOverflowHardMax = currentWordCount + sentenceWordCount > CHUNK_HARD_MAX_WORDS;

      if (currentSentences.length > 0 && (wouldExceedPreferredMax || wouldOverflowHardMax)) {
        chunksOut.push(currentSentences.join(" ").trim());
        currentSentences = [];
        currentWordCount = 0;
      }

      currentSentences.push(sentence);
      currentWordCount += sentenceWordCount;

      if (currentWordCount >= CHUNK_HARD_MAX_WORDS) {
        chunksOut.push(currentSentences.join(" ").trim());
        currentSentences = [];
        currentWordCount = 0;
      }
    }
  }

  if (currentSentences.length > 0) {
    chunksOut.push(currentSentences.join(" ").trim());
  }

  rebalanceTrailingChunk(chunksOut);

  console.log("Total chunks:", chunksOut.length);
  return chunksOut;
}

function splitLongSentence(sentence, targetWords = 170) {
  if (countWords(sentence) <= CHUNK_HARD_MAX_WORDS) {
    return [sentence.trim()];
  }

  const segments = [];
  const commaParts = sentence.split(/,\s+/);
  let buffer = "";

  for (const part of commaParts) {
    const candidate = buffer ? `${buffer}, ${part}` : part;

    if (countWords(candidate) <= CHUNK_PREFERRED_MAX_WORDS) {
      buffer = candidate;
      continue;
    }

    if (buffer) {
      segments.push(buffer.trim());
    }

    if (countWords(part) > CHUNK_HARD_MAX_WORDS) {
      segments.push(...splitByWordCount(part, targetWords));
      buffer = "";
      continue;
    }

    buffer = part;
  }

  if (buffer) {
    segments.push(buffer.trim());
  }

  return segments.filter(Boolean);
}

function splitByWordCount(text, targetWords) {
  const words = String(text || "").trim().split(/\s+/).filter(Boolean);
  const parts = [];
  const size = Math.min(Math.max(targetWords, CHUNK_MIN_WORDS), CHUNK_PREFERRED_MAX_WORDS);

  for (let index = 0; index < words.length; index += size) {
    parts.push(words.slice(index, index + size).join(" "));
  }

  return parts;
}

function rebalanceTrailingChunk(chunksOut) {
  if (chunksOut.length < 2) {
    return;
  }

  const lastChunk = chunksOut[chunksOut.length - 1];
  if (countWords(lastChunk) >= SITE_MIN_WORDS) {
    return;
  }

  const previousChunk = chunksOut[chunksOut.length - 2];
  const previousWords = previousChunk.split(/\s+/).filter(Boolean);
  const lastWords = lastChunk.split(/\s+/).filter(Boolean);
  const wordsNeeded = SITE_MIN_WORDS - lastWords.length;
  const moveCount = Math.min(wordsNeeded, previousWords.length);

  if (moveCount <= 0) {
    return;
  }

  const movedWords = previousWords.splice(-moveCount, moveCount);
  chunksOut[chunksOut.length - 2] = previousWords.join(" ").trim();
  chunksOut[chunksOut.length - 1] = [...movedWords, ...lastWords].join(" ").trim();

  if (!chunksOut[chunksOut.length - 2]) {
    const merged = `${chunksOut[chunksOut.length - 1]}`.trim();
    chunksOut.splice(chunksOut.length - 2, 2, merged);
  }
}

window.HumanizeAIChunking = {
  chunkText,
  splitLongSentence,
  countWords
};
