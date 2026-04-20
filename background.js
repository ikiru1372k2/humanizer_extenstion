const APP_URL = chrome.runtime.getURL("app/index.html");
const HUMANIZER_URL = "https://www.humanizeai.pro/";
const REQUEST_TIMEOUT_MS = 25000;
const CONTENT_INIT_DELAY_MS = 500;

let humanizrTabId = null;
const pendingResponses = new Map();
const tabLoadWaiters = new Map();

chrome.runtime.onInstalled.addListener(() => {
  humanizrTabId = null;
});

chrome.runtime.onStartup.addListener(() => {
  humanizrTabId = null;
});

chrome.action.onClicked.addListener(async () => {
  await openAppPage();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) {
    return false;
  }

  if (message.action === "OPEN_APP") {
    openAppPage()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === "OPEN_HUMANIZER_TAB") {
    ensureHumanizerTab(true)
      .then((tabId) => sendResponse({ success: true, tabId }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (message.action === "HUMANIZE_CHUNK") {
    handleChunk(message, sendResponse);
    return true;
  }

  if (message.action === "CAPTCHA_REQUIRED") {
    handleCaptchaRequired(message.requestId)
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === humanizrTabId) {
    humanizrTabId = null;
  }
});

async function openAppPage() {
  const tabs = await chrome.tabs.query({ url: APP_URL });

  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });

    if (typeof tabs[0].windowId === "number") {
      await chrome.windows.update(tabs[0].windowId, { focused: true });
    }

    return tabs[0];
  }

  return chrome.tabs.create({ url: APP_URL, active: true });
}

function handleChunk(message, sendResponse) {
  const requestId = message.requestId;

  if (!requestId) {
    sendResponse({ success: false, error: "missing_request_id", retryable: false });
    return;
  }

  if (pendingResponses.has(requestId)) {
    sendResponse({ success: false, error: "duplicate_request_id", retryable: false });
    return;
  }

  const timeoutId = setTimeout(() => {
    resolvePending(requestId, { success: false, error: "timeout", retryable: true });
  }, REQUEST_TIMEOUT_MS);

  pendingResponses.set(requestId, { sendResponse, timeoutId });

  ensureHumanizerTab()
    .then((tabId) => injectAndRun(tabId, message))
    .then((result) => {
      resolvePending(requestId, result);
    })
    .catch((error) => {
      resolvePending(requestId, {
        success: false,
        error: error.message || "tab_error",
        retryable: true
      });
    });
}

async function ensureHumanizerTab(makeActive = false) {
  if (humanizrTabId !== null) {
    try {
      const existingTab = await chrome.tabs.get(humanizrTabId);

      if (existingTab && !existingTab.discarded) {
        if (makeActive) {
          await chrome.tabs.update(humanizrTabId, { active: true });

          if (typeof existingTab.windowId === "number") {
            await chrome.windows.update(existingTab.windowId, { focused: true });
          }
        }

        if (existingTab.status === "complete") {
          return humanizrTabId;
        }

        await waitForTabLoad(humanizrTabId);
        return humanizrTabId;
      }
    } catch (error) {
      humanizrTabId = null;
    }
  }

  const tab = await chrome.tabs.create({
    url: HUMANIZER_URL,
    active: makeActive
  });

  humanizrTabId = tab.id;
  await waitForTabLoad(tab.id);
  return tab.id;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    if (tabLoadWaiters.has(tabId)) {
      tabLoadWaiters.get(tabId).push({ resolve, reject });
      return;
    }

    tabLoadWaiters.set(tabId, [{ resolve, reject }]);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      chrome.tabs.onUpdated.removeListener(listener);
      const waiters = tabLoadWaiters.get(tabId) || [];
      tabLoadWaiters.delete(tabId);
      waiters.forEach((waiter) => waiter.resolve());
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId)
      .then((tab) => {
        if (tab.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          const waiters = tabLoadWaiters.get(tabId) || [];
          tabLoadWaiters.delete(tabId);
          waiters.forEach((waiter) => waiter.resolve());
        }
      })
      .catch((error) => {
        chrome.tabs.onUpdated.removeListener(listener);
        const waiters = tabLoadWaiters.get(tabId) || [];
        tabLoadWaiters.delete(tabId);
        waiters.forEach((waiter) => waiter.reject(error));
      });
  });
}

async function injectAndRun(tabId, message) {
  const [execution] = await chrome.scripting.executeScript({
    target: { tabId },
    func: runChunkInPage,
    args: [
      {
        requestId: message.requestId,
        chunk: message.chunk,
        mode: message.mode
      }
    ]
  });

  if (!execution || !execution.result) {
    throw new Error("message_channel_closed");
  }

  return execution.result;
}

async function handleCaptchaRequired(requestId) {
  if (humanizrTabId === null) {
    return;
  }

  try {
    const tabId = await ensureHumanizerTab(true);
    const tab = await chrome.tabs.get(tabId);

    if (typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch (error) {
    resolvePending(requestId, { success: false, error: "captcha_tab_unavailable", retryable: true });
  }
}

function resolvePending(requestId, payload) {
  const pending = pendingResponses.get(requestId);

  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingResponses.delete(requestId);

  try {
    pending.sendResponse(payload);
  } catch (error) {
    console.warn("Failed to resolve pending response", requestId, error);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runChunkInPage(payload) {
  const INPUT_SELECTORS = [
    'textarea[placeholder*="Paste"]',
    'textarea',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];
  const OUTPUT_SELECTORS = [
    '[class*="output"]',
    '[class*="result"]',
    '#output',
    'textarea'
  ];
  const CAPTCHA_SELECTORS = [
    'iframe[title*="challenge"]',
    'iframe[src*="recaptcha"]',
    '.g-recaptcha',
    '#challenge-running',
    '#cf-challenge-running',
    '[name="cf-turnstile-response"]',
    '[class*="captcha"]',
    '#captcha'
  ];
  const POLL_INTERVAL_MS = 600;
  const RESULT_TIMEOUT_MS = 20000;

  const normalizeText = (text) =>
    String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");

  const hasCaptcha = () => {
    if (CAPTCHA_SELECTORS.some((selector) => document.querySelector(selector))) {
      return true;
    }

    const title = normalizeText(document.title);
    const bodyText = normalizeText(document.body ? document.body.innerText : "");
    return title.includes("just a moment")
      || title.includes("attention required")
      || bodyText.includes("verify you are human")
      || bodyText.includes("checking your browser")
      || bodyText.includes("cloudflare");
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const queryFirst = (selectors) => {
    for (const selector of selectors) {
      const match = document.querySelector(selector);
      if (match) {
        return match;
      }
    }
    return null;
  };

  const isEditable = (element) =>
    element instanceof HTMLTextAreaElement
    || element instanceof HTMLInputElement
    || (element instanceof HTMLElement && (element.isContentEditable || element.getAttribute("role") === "textbox"));

  const setInputValue = (element, value) => {
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");

      if (descriptor && typeof descriptor.set === "function") {
        descriptor.set.call(element, value);
      } else {
        element.value = value;
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
  };

  const readText = (element) => {
    if (!element) {
      return "";
    }

    if ("value" in element && typeof element.value === "string") {
      return element.value.trim();
    }

    return (element.innerText || element.textContent || "").trim();
  };

  const findInput = () => {
    const input = queryFirst(INPUT_SELECTORS);
    return isEditable(input) ? input : null;
  };

  const findOutput = (inputElement) => {
    const textareas = Array.from(document.querySelectorAll("textarea")).filter((el) => el !== inputElement);
    if (textareas.length > 0) {
      return textareas[textareas.length - 1];
    }

    const placeholder = Array.from(document.querySelectorAll("div, p, span")).find((el) =>
      normalizeText(el.textContent).includes("paraphrased text will appear here"));
    if (placeholder && placeholder.parentElement) {
      return placeholder.parentElement;
    }

    const output = queryFirst(OUTPUT_SELECTORS);
    if (output === inputElement) {
      return null;
    }

    return output;
  };

  const findButton = () => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const okButton = buttons.find((button) => normalizeText(button.textContent) === "ok");
    if (okButton) {
      okButton.click();
    }

    return buttons.find((button) => {
      const text = normalizeText(button.textContent);
      return text.includes("humanize") || text.includes("run");
    }) || null;
  };

  if (hasCaptcha()) {
    return { success: false, error: "captcha_required", retryable: true };
  }

  let input = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    input = findInput();
    if (input) {
      break;
    }
    await sleep(1000);
  }

  if (!input) {
    return { success: false, error: "selector_not_found", retryable: false, details: { target: "input" } };
  }

  const output = findOutput(input);
  const snapshotBefore = readText(output);
  setInputValue(input, payload.chunk);
  await sleep(400);

  const button = findButton();
  if (!button) {
    return { success: false, error: "selector_not_found", retryable: false, details: { target: "button" } };
  }

  button.click();

  const startedAt = Date.now();
  while (Date.now() - startedAt < RESULT_TIMEOUT_MS) {
    if (hasCaptcha()) {
      return { success: false, error: "captcha_required", retryable: true };
    }

    const currentOutput = findOutput(input);
    const currentText = readText(currentOutput);
    if (currentText && currentText !== snapshotBefore && currentText.length > 10) {
      setInputValue(input, "");
      return { success: true, result: currentText };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  return { success: false, error: "timeout", retryable: true };
}
