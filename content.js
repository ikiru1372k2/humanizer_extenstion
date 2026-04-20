const INPUT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"]';
const BTN_SELECTOR = 'button[type="button"], button';
const OUTPUT_SELECTOR = 'textarea, [contenteditable="true"], [role="textbox"], [class*="output"], [class*="result"], [data-testid*="output"], #output';

const INPUT_FALLBACKS = [
  '[placeholder*="Paste"]',
  '[aria-label*="Paste"]',
  'main textarea',
  '[contenteditable="true"]',
  '[role="textbox"]',
  'textarea'
];

const BUTTON_FALLBACKS = [
  'button[class*="human"]',
  'button[class*="submit"]',
  'main button',
  'button'
];

const OUTPUT_FALLBACKS = [
  '[class*="output"]',
  '[class*="result"]',
  '[class*="paraphrase"]',
  '[data-testid*="output"]',
  '#output',
  'main div'
];

const CAPTCHA_FALLBACKS = [
  'iframe[title*="challenge"]',
  'iframe[src*="recaptcha"]',
  '.g-recaptcha',
  '#challenge-running',
  '#cf-challenge-running',
  '[name="cf-turnstile-response"]',
  '[class*="captcha"]',
  '#captcha'
];

const MODE_LABEL_MAP = {
  basic: ["basic"],
  standard: ["standard"],
  deep: ["deep"]
};

const MAX_INPUT_RETRIES = 5;
const RETRY_DELAY_MS = 1000;
const REACT_SETTLE_MS = 400;
const POST_RESULT_CLEAR_DELAY_MS = 300;
const CAPTCHA_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 600;
const RESULT_TIMEOUT_MS = 20000;

if (!window.__humanizrInjected) {
  window.__humanizrInjected = true;
  window.__humanizeAIBridge = {
    processChunk: (message) =>
      processChunk(message).catch((error) => {
        notifyError(message.requestId, error.message || "process_failed", true);
      })
  };

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.action !== "INJECT_CHUNK") {
      return;
    }

    window.__humanizeAIBridge.processChunk(message);
  });
}

async function processChunk(message) {
  const { requestId, chunk, mode } = message;

  if (hasCaptcha()) {
    safelySendRuntimeMessage({ action: "CAPTCHA_REQUIRED", requestId });
    notifyError(requestId, "captcha_required", true);
    return;
  }

  const textarea = await findTextarea();

  if (!textarea) {
    notifyError(requestId, "selector_not_found", false, { target: "input" });
    return;
  }

  setInputValue(textarea, chunk);
  await sleep(REACT_SETTLE_MS);

  trySelectMode(mode);

  const outputEl = findOutputElement(textarea);
  const snapshotBefore = outputEl ? readOutputText(outputEl) : "";
  const button = findHumanizeButton();

  if (!button) {
    notifyError(requestId, "selector_not_found", false, { target: "button" });
    return;
  }

  button.click();

  try {
    const resultText = await pollForResult(outputEl, snapshotBefore);
    safelySendRuntimeMessage({
      action: "CHUNK_RESULT",
      requestId,
      result: resultText
    });
    await sleep(POST_RESULT_CLEAR_DELAY_MS);
    setInputValue(textarea, "");
  } catch (error) {
    notifyError(requestId, error.message || "timeout", true);
  }
}

async function findTextarea() {
  for (let attempt = 0; attempt < MAX_INPUT_RETRIES; attempt += 1) {
    const textarea = document.querySelector(INPUT_SELECTOR) || queryFromList(INPUT_FALLBACKS);

    if (isEditableElement(textarea)) {
      return textarea;
    }

    await sleep(RETRY_DELAY_MS);
  }

  return null;
}

function setInputValue(element, value) {
  if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
    const prototype = element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

    if (!descriptor || typeof descriptor.set !== "function") {
      element.value = value;
    } else {
      descriptor.set.call(element, value);
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  if (element instanceof HTMLElement) {
    element.focus();
    element.textContent = value;
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function trySelectMode(mode) {
  const desiredLabels = MODE_LABEL_MAP[String(mode || "").toLowerCase()] || [];

  if (desiredLabels.length === 0) {
    return;
  }

  const buttons = Array.from(document.querySelectorAll("button"));

  for (const button of buttons) {
    const label = normalizeText(button.textContent);

    if (!label) {
      continue;
    }

    if (desiredLabels.some((desired) => label === desired || label.includes(desired))) {
      try {
        button.click();
      } catch (error) {
        console.warn("Mode selection failed", error);
      }
      return;
    }
  }
}

function findHumanizeButton() {
  const directMatch = Array.from(document.querySelectorAll(BTN_SELECTOR)).find((button) => {
    return isHumanizeButton(button);
  });

  if (directMatch) {
    return directMatch;
  }

  for (const selector of BUTTON_FALLBACKS) {
    const buttons = Array.from(document.querySelectorAll(selector));
    const match = buttons.find((button) => isHumanizeButton(button));

    if (match) {
      return match;
    }
  }

  return null;
}

function findOutputElement(inputTextarea) {
  const direct = document.querySelector(OUTPUT_SELECTOR);

  if (direct && direct !== inputTextarea) {
    return direct;
  }

  const secondTextarea = Array.from(document.querySelectorAll("textarea")).find((textarea) => textarea !== inputTextarea);

  if (secondTextarea) {
    return secondTextarea;
  }

  const placeholderMatch = Array.from(document.querySelectorAll("div, p, span")).find((el) => {
    const text = normalizeText(el.textContent);
    return text.includes("paraphrased text will appear here");
  });

  if (placeholderMatch && placeholderMatch.parentElement) {
    return placeholderMatch.parentElement;
  }

  for (const selector of OUTPUT_FALLBACKS) {
    const candidates = Array.from(document.querySelectorAll(selector)).filter((el) => {
      if (!(el instanceof HTMLElement)) {
        return false;
      }

      if (inputTextarea && el.contains(inputTextarea)) {
        return false;
      }

      return readOutputText(el).length > 0 || el.clientHeight > 80;
    });

    if (candidates.length > 0) {
      return candidates[candidates.length - 1];
    }
  }

  return null;
}

function readOutputText(element) {
  if (!element) {
    return "";
  }

  if ("value" in element && typeof element.value === "string") {
    return element.value.trim();
  }

  return (element.innerText || element.textContent || "").trim();
}

function isHumanizeButton(button) {
  if (!(button instanceof HTMLButtonElement)) {
    return false;
  }

  const label = normalizeText(button.textContent);
  return Boolean(label) && (label.includes("humanize") || label.includes("submit") || label.includes("run"));
}

function hasCaptcha() {
  if (CAPTCHA_FALLBACKS.some((selector) => document.querySelector(selector))) {
    return true;
  }

  const title = normalizeText(document.title);
  const bodyText = normalizeText(document.body ? document.body.innerText : "");
  return title.includes("just a moment")
    || title.includes("attention required")
    || bodyText.includes("verify you are human")
    || bodyText.includes("checking your browser")
    || bodyText.includes("cloudflare");
}

function queryFromList(selectors) {
  for (const selector of selectors) {
    const match = document.querySelector(selector);

    if (match) {
      return match;
    }
  }

  return null;
}

function normalizeText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function pollForResult(outputEl, snapshotBefore) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let dynamicOutput = outputEl;

    const timer = setInterval(() => {
      if (!dynamicOutput || !document.contains(dynamicOutput)) {
        dynamicOutput = findOutputElement(findTextareaSync());
      }

      const currentText = readOutputText(dynamicOutput);

      if (currentText && currentText !== snapshotBefore && currentText.length > 10) {
        clearInterval(timer);
        resolve(currentText);
        return;
      }

      if (Date.now() - startedAt >= RESULT_TIMEOUT_MS) {
        clearInterval(timer);
        reject(new Error(currentText ? "empty_result" : "timeout"));
      }
    }, POLL_INTERVAL_MS);
  });
}

function findTextareaSync() {
  const textarea = document.querySelector(INPUT_SELECTOR) || queryFromList(INPUT_FALLBACKS);
  return isEditableElement(textarea) ? textarea : null;
}

function isEditableElement(element) {
  return element instanceof HTMLTextAreaElement
    || element instanceof HTMLInputElement
    || (element instanceof HTMLElement && (element.isContentEditable || element.getAttribute("role") === "textbox"));
}

function notifyError(requestId, error, retryable, details = null) {
  safelySendRuntimeMessage({
    action: "CHUNK_ERROR",
    requestId,
    error,
    retryable,
    details
  });
}

function safelySendRuntimeMessage(payload) {
  try {
    chrome.runtime.sendMessage(payload);
  } catch (error) {
    console.warn("Runtime message failed", payload, error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
