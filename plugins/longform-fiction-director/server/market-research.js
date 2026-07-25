"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const parse5 = require("./vendor/parse5");

const { decodeFanqieText } = require("./download-provider");
const parsedBundledCharset = require("./fanqie-charset.json");

const FANQIE_PUA_BASE = 0xE3E8;
const bundledCharset = Array.isArray(parsedBundledCharset?.[0]) ? parsedBundledCharset[0] : [];
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_HTML_CHARS = 250_000;
const DEFAULT_MAX_ITEMS = 50;
const DEFAULT_MAX_DESCRIPTION_CHARS = 800;
const MAX_RANK_URL_CHARS = 2_048;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_HTML_CHARS = 1_000_000;
const MAX_ITEMS = 100;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_EVIDENCE_CHARS = 250_000;
const MAX_TAGS = 3;
const MAX_TAG_CHARS = 40;
const MAX_HTML_NODES = 20_000;
const MAX_HTML_DEPTH = 128;
const MAX_STATISTICS_SOURCE_CHARS = 4_000;
const MAX_URL_DECODE_ROUNDS = 8;
const MAX_EMBEDDED_URL_CANDIDATES = 256;
const MAX_EMBEDDED_URL_CHARS = 4_096;
const MAX_STYLESHEET_CHARS = 64_000;
const MAX_STYLESHEET_RULES = 256;
const MAX_RELEVANT_STYLESHEET_RULES = 256;
const MAX_STYLESHEET_SELECTOR_CHARS = 256;
const PRIVATE_FANQIE_URL_SIGNATURE = /(?:https?|%68ttps?)(?::[\\/]+|%3A(?:%2F|%5C){2})(?:www(?:\.|%2E))?fanqienovel(?:\.|%2E)com(?:[\\/]|%(?:2F|5C))+(?:reader|page|%72eader|%70age|%72%65%61%64%65%72|%70%61%67%65)(?=(?:[\\/?#]|%(?:2F|5C|3F|23)|$))[^\s<>"'&\[\]\(\),;\uFF0C\uFF1B|]*/giu;
const ALLOWED_HOSTS = new Set(["fanqienovel.com", "www.fanqienovel.com"]);
const STATISTICS_ELEMENTS = new Set(["p", "span", "time", "div"]);
const INACTIVE_ELEMENTS = new Set([
  "script", "style", "noscript", "template", "title", "textarea", "iframe", "xmp", "noembed", "noframes"
]);
const TEXT_BOUNDARY_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "details", "dialog", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);
const STYLESHEET_HIDDEN = Symbol("stylesheetHidden");
const ITEM_TEXT_LIMITS = Object.freeze({
  rank: 32,
  title: 200,
  author: 120,
  readCount: 80,
  status: 80,
  latestPart: 200,
  latestUpdate: 280
});

function createError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(Math.floor(number), maximum);
}

function normalizeRankUrl(value) {
  if (typeof value !== "string"
    || !value
    || value.length > MAX_RANK_URL_CHARS
    || value !== value.trim()
    || value.includes("%")
    || value.includes("?")
    || value.includes("#")
    || /[\u0000-\u001F\u007F]/u.test(value)) {
    throw createError("MARKET_URL_INVALID", "rankUrl must be a safe public Fanqie rank URL.");
  }

  const authorityMatch = value.match(/^https:\/\/([^/?#\\]+)(\/[^?#\\]*)?$/iu);
  if (!authorityMatch || !ALLOWED_HOSTS.has(authorityMatch[1].toLowerCase())) {
    throw createError("MARKET_URL_INVALID", "rankUrl must use a canonical public Fanqie authority.");
  }
  const rawPath = authorityMatch[2] || "";
  if (!/^\/rank(?:\/[A-Za-z0-9_-]+)?$/u.test(rawPath)) {
    throw createError("MARKET_URL_INVALID", "rankUrl must use a canonical public Fanqie rank path.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw createError("MARKET_URL_INVALID", "rankUrl must be a valid HTTPS URL.", error);
  }

  const isRankPath = parsed.pathname === rawPath;
  const hasUnsafePathEncoding = parsed.pathname.includes("%");
  const hasReaderPath = /\/(?:page|reader)(?:\/|$)/iu.test(parsed.pathname);
  if (parsed.protocol !== "https:"
    || !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
    || !isRankPath
    || hasUnsafePathEncoding
    || hasReaderPath) {
    throw createError("MARKET_URL_INVALID", "rankUrl must stay on the public Fanqie rank path.");
  }
  return parsed.toString();
}

function normalizeProjectPath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw createError("PROJECT_PATH_REQUIRED", "A project path is required.");
  }
  try {
    return path.resolve(value);
  } catch (error) {
    throw createError("PROJECT_PATH_INVALID", "The project path is invalid.", error);
  }
}

function getHeader(response, name) {
  if (typeof response?.headers?.get === "function") return response.headers.get(name);
  if (!response?.headers || typeof response.headers !== "object") return null;
  const key = Object.keys(response.headers).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key ? response.headers[key] : null;
}

function responseIsHtml(response) {
  const contentType = String(getHeader(response, "content-type") || "").trim();
  return /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType);
}

async function readBoundedHtml(response, maxHtmlChars) {
  const declaredLength = Number.parseInt(getHeader(response, "content-length"), 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxHtmlChars * 4) {
    throw createError("MARKET_RESPONSE_TOO_LARGE", "The Fanqie rank response exceeded maxHtmlChars.");
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    if (typeof response.text !== "function") {
      throw createError("MARKET_RESPONSE_INVALID", "The Fanqie rank response body is unavailable.");
    }
    const html = String(await response.text());
    if (html.length > maxHtmlChars) {
      throw createError("MARKET_RESPONSE_TOO_LARGE", "The Fanqie rank response exceeded maxHtmlChars.");
    }
    return html;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      html += typeof value === "string" ? value : decoder.decode(value, { stream: true });
      if (html.length > maxHtmlChars) {
        await reader.cancel().catch(() => {});
        throw createError("MARKET_RESPONSE_TOO_LARGE", "The Fanqie rank response exceeded maxHtmlChars.");
      }
    }
    html += decoder.decode();
    if (html.length > maxHtmlChars) {
      throw createError("MARKET_RESPONSE_TOO_LARGE", "The Fanqie rank response exceeded maxHtmlChars.");
    }
    return html;
  } finally {
    reader.releaseLock();
  }
}

function isElementNode(node) {
  return typeof node?.tagName === "string";
}

function isTextNode(node) {
  return node?.nodeName === "#text";
}

function extractionChildren(node) {
  if (!node || INACTIVE_ELEMENTS.has(node.tagName)) return [];
  if (node.tagName === "dialog" && !hasAttribute(node, "open")) return [];
  if (node.tagName === "details" && !hasAttribute(node, "open")) {
    const summary = (node.childNodes || []).find((child) => child.tagName === "summary");
    return summary ? [summary] : [];
  }
  return node.childNodes || [];
}

function sourceNode(node) {
  return Boolean(node?.sourceCodeLocation);
}

function throwComplexityError(kind) {
  throw createError(
    "MARKET_RESPONSE_TOO_COMPLEX",
    `The Fanqie rank HTML exceeded its fixed ${kind} limit.`
  );
}

function enforceHtmlComplexity(document) {
  // Count source-backed parse5 nodes, including nodes in template.content. The
  // document, fragments, and parse5's synthetic html/head/body nodes have no
  // sourceCodeLocation and are intentionally excluded from this fixed budget.
  let nodeCount = 0;
  const stack = [{ node: document, elementDepth: 0 }];

  while (stack.length) {
    const frame = stack.pop();
    const { node } = frame;
    const isSourceElement = isElementNode(node) && sourceNode(node);
    const elementDepth = frame.elementDepth + (isSourceElement ? 1 : 0);

    if (sourceNode(node)) {
      nodeCount += 1;
      if (nodeCount > MAX_HTML_NODES) throwComplexityError("node");
    }
    if (elementDepth > MAX_HTML_DEPTH) throwComplexityError("depth");

    const children = node?.tagName === "template"
      ? (node.content?.childNodes || [])
      : (node?.childNodes || []);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], elementDepth });
    }
  }
}

function preflightHtmlComplexity(html) {
  const defaultAdapter = parse5.defaultTreeAdapter;
  const sourceCounted = Symbol("sourceCounted");
  const depthChecked = Symbol("depthChecked");
  const templateOwner = Symbol("templateOwner");
  let nodeCount = 0;

  function countSourceNode(node, location) {
    if (!location || node[sourceCounted]) return;
    node[sourceCounted] = true;
    nodeCount += 1;
    if (nodeCount > MAX_HTML_NODES) throwComplexityError("node");
  }

  function parentNode(node) {
    return node?.[templateOwner] || defaultAdapter.getParentNode(node);
  }

  function checkElementDepth(parent, node) {
    if (!isElementNode(node) || !sourceNode(node) || node[depthChecked]) return;
    node[depthChecked] = true;
    let elementDepth = 1;
    for (let current = parent; current; current = parentNode(current)) {
      if (isElementNode(current) && sourceNode(current)) elementDepth += 1;
    }
    if (elementDepth > MAX_HTML_DEPTH) throwComplexityError("depth");
  }

  const countingAdapter = {
    ...defaultAdapter,
    appendChild(parent, node) {
      checkElementDepth(parent, node);
      defaultAdapter.appendChild(parent, node);
    },
    insertBefore(parent, node, referenceNode) {
      checkElementDepth(parent, node);
      defaultAdapter.insertBefore(parent, node, referenceNode);
    },
    setTemplateContent(template, content) {
      defaultAdapter.setTemplateContent(template, content);
      content[templateOwner] = template;
    },
    setNodeSourceCodeLocation(node, location) {
      defaultAdapter.setNodeSourceCodeLocation(node, location);
      countSourceNode(node, location);
    }
  };

  return parse5.Parser.parse(String(html), {
    sourceCodeLocationInfo: true,
    treeAdapter: countingAdapter
  });
}

function parseHtml(html) {
  const document = preflightHtmlComplexity(html);
  enforceHtmlComplexity(document);
  return document;
}

function classNames(node) {
  return String(attributeValue(node, "class") || "").split(/\s+/u).filter(Boolean);
}

function hasClass(node, className) {
  return classNames(node).includes(className);
}

function findElements(root, predicate) {
  if (elementOrAncestorIsHidden(root)) return [];
  const matches = [];
  const stack = [...extractionChildren(root)].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (!isElementNode(node) || elementIsHidden(node)) continue;
    if (predicate(node)) matches.push(node);
    const children = extractionChildren(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return matches;
}

function findFirst(root, predicate) {
  return findElements(root, predicate)[0] || null;
}

function findFirstIncluding(root, predicate) {
  if (isElementNode(root) && !elementOrAncestorIsHidden(root) && predicate(root)) return root;
  return findFirst(root, predicate);
}

function hasAncestorClass(node, className) {
  for (let parent = node?.parentNode; parent; parent = parent.parentNode) {
    if (hasClass(parent, className)) return true;
  }
  return false;
}

function hasRankHeadingContext(node) {
  for (let parent = node?.parentNode; parent; parent = parent.parentNode) {
    const classes = classNames(parent).join(" ");
    if (hasClass(parent, "muye-rank-wrap-header")
      || /(?:rank.*(?:header|banner)|(?:header|banner).*rank)/iu.test(classes)) return true;
  }
  return false;
}

function hasAttribute(node, name) {
  return (node?.attrs || []).some((attribute) => attribute.name === name);
}

function attributeValue(node, name) {
  return (node?.attrs || []).find((attribute) => attribute.name === name)?.value;
}

function decodeCssEscapes(value) {
  return String(value || "").replace(
    /\\(?:([0-9A-F]{1,6})(?:[ \t\r\n\f]|$)|([^\r\n\f0-9A-F]))/giu,
    (_match, hexadecimal, character) => {
      if (hexadecimal) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        if (codePoint === 0 || codePoint > 0x10FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) {
          return "\uFFFD";
        }
        return String.fromCodePoint(codePoint);
      }
      return character || "";
    }
  );
}

function inlineStyleHidesElement(value) {
  const declarations = String(value || "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split(";");
  const winners = new Map();
  for (const declaration of declarations) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = decodeCssEscapes(declaration.slice(0, separator)).trim().toLowerCase();
    if (property !== "display" && property !== "visibility") continue;
    let setting = decodeCssEscapes(declaration.slice(separator + 1)).trim();
    const important = /![ \t\r\n\f]*important[ \t\r\n\f]*$/iu.test(setting);
    setting = setting.replace(/![ \t\r\n\f]*important[ \t\r\n\f]*$/iu, "").trim().toLowerCase();
    if (!setting) continue;
    const winner = winners.get(property);
    if (!winner || important || !winner.important) {
      winners.set(property, { setting, important });
    }
  }
  return winners.get("display")?.setting === "none"
    || winners.get("visibility")?.setting === "hidden";
}

function parseStyleSimpleSelector(value) {
  const selector = decodeCssEscapes(value).trim();
  if (!selector || selector.length > MAX_STYLESHEET_SELECTOR_CHARS) return null;
  let remainder = selector;
  const result = { tag: null, id: null, classes: [], attributes: [] };
  const tagMatch = remainder.match(/^(?:([A-Za-z][A-Za-z0-9_-]*)|(\*))/u);
  if (tagMatch) {
    result.tag = tagMatch[1]?.toLowerCase() || "*";
    remainder = remainder.slice(tagMatch[0].length);
  }
  while (remainder) {
    const classMatch = remainder.match(/^\.([A-Za-z_][A-Za-z0-9_-]*)/u);
    if (classMatch) {
      result.classes.push(classMatch[1]);
      remainder = remainder.slice(classMatch[0].length);
      continue;
    }
    const idMatch = remainder.match(/^#([A-Za-z_][A-Za-z0-9_-]*)/u);
    if (idMatch) {
      result.id = idMatch[1];
      remainder = remainder.slice(idMatch[0].length);
      continue;
    }
    const attributeMatch = remainder.match(
      /^\[\s*([A-Za-z_][A-Za-z0-9_-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+)))?\s*\]/u
    );
    if (attributeMatch) {
      result.attributes.push({
        name: attributeMatch[1],
        value: attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? null
      });
      remainder = remainder.slice(attributeMatch[0].length);
      continue;
    }
    return null;
  }
  return result;
}

function parseStyleSelector(value) {
  const parts = decodeCssEscapes(value).trim().split(/\s+/u);
  if (parts.length > 2 || parts.some((part) => !part)) return null;
  const selectors = parts.map(parseStyleSimpleSelector);
  return selectors.every(Boolean) ? selectors : null;
}

function styleSimpleSelectorMatches(node, selector) {
  if (!isElementNode(node)) return false;
  if (selector.tag && selector.tag !== "*" && node.tagName !== selector.tag) return false;
  if (selector.id && attributeValue(node, "id") !== selector.id) return false;
  if (selector.classes.some((className) => !hasClass(node, className))) return false;
  return selector.attributes.every((attribute) => {
    if (!hasAttribute(node, attribute.name)) return false;
    if (attribute.value === null) return true;
    return String(attributeValue(node, attribute.name)).toLowerCase() === attribute.value.toLowerCase();
  });
}

function styleSelectorMatches(node, selectors) {
  const last = selectors.at(-1);
  if (!styleSimpleSelectorMatches(node, last)) return false;
  let ancestor = node.parentNode;
  for (let index = selectors.length - 2; index >= 0; index -= 1) {
    while (ancestor && !styleSimpleSelectorMatches(ancestor, selectors[index])) {
      ancestor = ancestor.parentNode;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parentNode;
  }
  return true;
}

function styleText(node) {
  let output = "";
  const stack = [...(node.childNodes || [])].reverse();
  while (stack.length && output.length < MAX_STYLESHEET_CHARS) {
    const current = stack.pop();
    if (isTextNode(current)) {
      output += current.value.slice(0, MAX_STYLESHEET_CHARS - output.length);
      continue;
    }
    const children = current?.childNodes || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return output;
}

function stylesheetSelectorVocabulary(document) {
  const vocabulary = {
    tags: new Set(),
    ids: new Set(),
    classes: new Set(),
    attributeNames: new Set(),
    attributeValues: new Set()
  };
  const stack = [document];
  while (stack.length) {
    const node = stack.pop();
    if (isElementNode(node)) {
      vocabulary.tags.add(node.tagName);
      const id = attributeValue(node, "id");
      if (id) vocabulary.ids.add(id);
      for (const className of String(attributeValue(node, "class") || "").split(/\s+/u)) {
        if (className) vocabulary.classes.add(className);
      }
      for (const attribute of node.attrs || []) {
        const name = String(attribute.name || "").toLowerCase();
        if (!name) continue;
        vocabulary.attributeNames.add(name);
        vocabulary.attributeValues.add(`${name}\u0000${String(attribute.value || "")}`);
      }
    }
    const children = node?.tagName === "template"
      ? (node.content?.childNodes || [])
      : (node?.childNodes || []);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return vocabulary;
}

function styleSelectorMayMatchVocabulary(selectors, vocabulary) {
  const target = selectors.at(-1);
  if (target.tag && target.tag !== "*" && !vocabulary.tags.has(target.tag)) return false;
  if (target.id && !vocabulary.ids.has(target.id)) return false;
  if (target.classes.some((className) => !vocabulary.classes.has(className))) return false;
  return target.attributes.every((attribute) => (
    vocabulary.attributeNames.has(attribute.name)
    && (attribute.value === null
      || vocabulary.attributeValues.has(`${attribute.name}\u0000${attribute.value}`))
  ));
}

function collectStylesheetVisibilityRules(document, vocabulary) {
  const rules = [];
  const relevantRules = [];
  let hideAllElements = false;
  const stack = [document];
  while (stack.length && !hideAllElements) {
    const node = stack.pop();
    if (isElementNode(node) && node.tagName === "style") {
      const css = styleText(node).replace(/\/\*[\s\S]*?\*\//gu, "");
      for (const block of css.split("}")) {
        const openingBrace = block.lastIndexOf("{");
        if (openingBrace < 0) continue;
        const declaration = block.slice(openingBrace + 1);
        if (!inlineStyleHidesElement(declaration)) continue;
        for (const selectorText of block.slice(0, openingBrace).split(",")) {
          const selectors = parseStyleSelector(selectorText);
          if (!selectors) continue;
          if (rules.length < MAX_STYLESHEET_RULES) {
            rules.push(selectors);
            continue;
          }
          if (!styleSelectorMayMatchVocabulary(selectors, vocabulary)) continue;
          if (relevantRules.length < MAX_RELEVANT_STYLESHEET_RULES) {
            relevantRules.push(selectors);
          } else {
            hideAllElements = true;
            break;
          }
        }
        if (hideAllElements) break;
      }
      continue;
    }
    const children = node?.tagName === "template"
      ? (node.content?.childNodes || [])
      : (node?.childNodes || []);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return { rules, relevantRules, hideAllElements };
}

function applyStylesheetVisibility(document) {
  const vocabulary = stylesheetSelectorVocabulary(document);
  const { rules, relevantRules, hideAllElements } = collectStylesheetVisibilityRules(document, vocabulary);
  const allRules = [...rules, ...relevantRules];
  if (!allRules.length && !hideAllElements) return;
  const stack = [document];
  while (stack.length) {
    const node = stack.pop();
    if (isElementNode(node) && node.tagName !== "style"
      && (hideAllElements || allRules.some((selectors) => styleSelectorMatches(node, selectors)))) {
      node[STYLESHEET_HIDDEN] = true;
    }
    const children = node?.tagName === "template"
      ? (node.content?.childNodes || [])
      : (node?.childNodes || []);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
}

function elementIsHidden(node) {
  if (!isElementNode(node)) return false;
  if (node[STYLESHEET_HIDDEN]) return true;
  if (INACTIVE_ELEMENTS.has(node.tagName)) return true;
  if (hasAttribute(node, "hidden")) return true;
  if (String(attributeValue(node, "aria-hidden") || "").trim().toLowerCase() === "true") return true;
  return inlineStyleHidesElement(attributeValue(node, "style") || "");
}

function elementOrAncestorIsHidden(node) {
  for (let current = node; current; current = current.parentNode) {
    if (elementIsHidden(current)) return true;
  }
  return false;
}

function rawText(node) {
  if (!node) return "";
  for (let parent = node.parentNode; parent; parent = parent.parentNode) {
    if (elementIsHidden(parent)) return "";
  }
  const parts = [];
  const textBoundary = Symbol("textBoundary");
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (current === textBoundary) {
      parts.push(" ");
      continue;
    }
    if (isTextNode(current)) {
      parts.push(current.value);
      continue;
    }
    if (!isElementNode(current)) continue;
    if (elementIsHidden(current)) continue;
    if (TEXT_BOUNDARY_ELEMENTS.has(current.tagName)) {
      parts.push(" ");
      stack.push(textBoundary);
    }
    const children = extractionChildren(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return parts.join("");
}

function truncateCharacters(value, maximum) {
  if (!value) return "";
  const characters = [...value];
  return characters.length > maximum ? characters.slice(0, maximum).join("") : value;
}

function safelyDecodeUrlPath(value) {
  let decoded = String(value);
  for (let round = 0; round < MAX_URL_DECODE_ROUNDS; round += 1) {
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      next = decoded.replace(/%([0-9A-F]{2})/giu, (_match, hexadecimal) => (
        String.fromCharCode(Number.parseInt(hexadecimal, 16))
      ));
    }
    if (next === decoded) break;
    decoded = next;
  }
  return /%[0-9A-F]{2}/iu.test(decoded) ? null : decoded;
}

function stripZeroWidthCharacters(value) {
  return String(value).replace(/[\u200B-\u200D\uFEFF\u2060-\u2061]/gu, "");
}

function normalizeUrlToken(value) {
  const decoded = safelyDecodeUrlPath(stripZeroWidthCharacters(value));
  if (decoded === null) return null;
  return stripZeroWidthCharacters(decoded).replace(/\\/gu, "/");
}

function privateBookPath(value) {
  return /\/(?:reader|page)(?=[/?#]|$)/iu.test(value);
}

function parseUrlToken(value) {
  const absoluteMatch = String(value).match(/https?:\/+[^\s<>"']*/iu);
  const networkMatch = absoluteMatch ? null : String(value).match(/\/\/[^\s<>"']+/u);
  const candidate = absoluteMatch?.[0] || (networkMatch ? `https:${networkMatch[0]}` : null);
  if (!candidate) return null;
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function privateBookToken(value) {
  const normalized = normalizeUrlToken(value);
  if (normalized === null) return true;
  const parsed = parseUrlToken(normalized);
  if (parsed) {
    return ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
      && privateBookPath(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  }
  return privateBookPath(normalized);
}

function embeddedUrlFragmentEnd(value, start) {
  const limit = Math.min(value.length, start + MAX_EMBEDDED_URL_CHARS);
  const boundaryOffset = value.slice(start, limit).search(/[\s<>"'&\[\]\(\),;\uFF0C\uFF1B|]/u);
  return boundaryOffset < 0 ? limit : start + boundaryOffset;
}

function scrubPrivateFanqieUrlSignatures(value) {
  return String(value).replace(PRIVATE_FANQIE_URL_SIGNATURE, " ");
}

function stripEmbeddedPrivateBookUrls(value) {
  const source = stripZeroWidthCharacters(value);
  const starts = /(?:https?|%68ttps?)(?=(?::[\\/]+|%3A(?:%2F|%5C)))/giu;
  let candidateCount = 0;
  let cursor = 0;
  let output = "";

  for (const match of source.matchAll(starts)) {
    const start = match.index;
    if (start < cursor) continue;
    candidateCount += 1;
    if (candidateCount > MAX_EMBEDDED_URL_CANDIDATES) {
      return output + scrubPrivateFanqieUrlSignatures(source.slice(cursor));
    }
    const end = embeddedUrlFragmentEnd(source, start);
    const candidate = source.slice(start, end);
    if (!privateBookToken(candidate)) continue;
    output += source.slice(cursor, start);
    cursor = end;
  }
  return output + source.slice(cursor);
}

function stripPrivateBookUrls(value) {
  return stripEmbeddedPrivateBookUrls(value).replace(/\S+/gu, (candidate) => (
    candidate.split(/([,\uFF0C;\uFF1B|]+)/u).map((segment) => (
      privateBookToken(segment) ? " " : segment
    )).join("")
  ));
}

function normalizeDecodedValue(value, maximum) {
  const decoded = stripZeroWidthCharacters(stripPrivateBookUrls(value))
    .replace(/\s+/gu, " ")
    .trim();
  return truncateCharacters(decoded, maximum) || null;
}

function normalizedValue(value, charset, maximum) {
  return normalizeDecodedValue(decodeFanqieText(value, charset), maximum);
}

function normalizedText(node, charset, maximum) {
  if (!node) return null;
  return normalizedValue(rawText(node), charset, maximum);
}

function valueHasUnknownPuaMapping(value, charset) {
  for (const character of String(value || "")) {
    const codePoint = character.codePointAt(0);
    if (codePoint < 0xE000 || codePoint > 0xF8FF) continue;
    const index = codePoint - FANQIE_PUA_BASE;
    const decoded = Array.isArray(charset) && index >= 0 ? charset[index] : undefined;
    if (!decoded || decoded === "?") return true;
  }
  return false;
}

function hasUnknownPuaMapping(node, charset) {
  return node ? valueHasUnknownPuaMapping(rawText(node), charset) : false;
}

function parseStatusAndTags(node, charset) {
  if (!node) {
    return { status: null, tags: [], statusUnknown: false, tagsUnknown: false };
  }
  const segments = rawText(node).split(/\s*\u00b7\s*/u);
  const statusSource = segments.shift() || "";
  const tagSources = segments.slice(0, MAX_TAGS);
  const tags = [];
  let tagsUnknown = false;
  for (const source of tagSources) {
    const tag = normalizedValue(source, charset, MAX_TAG_CHARS);
    if (!tag) continue;
    tags.push(tag);
    if (valueHasUnknownPuaMapping(source, charset)) tagsUnknown = true;
  }
  return {
    status: normalizedValue(statusSource, charset, ITEM_TEXT_LIMITS.status),
    tags,
    statusUnknown: valueHasUnknownPuaMapping(statusSource, charset),
    tagsUnknown
  };
}

function titleIsUncertain(value) {
  return !value || /[\uE000-\uF8FF]/u.test(value) || !/[\p{L}\p{N}]/u.test(value);
}

function textFromClass(root, className, charset, maximum) {
  return normalizedText(findFirst(root, (node) => hasClass(node, className)), charset, maximum);
}

function boundedStatisticsText(value, charset) {
  let output = "";
  let pendingWhitespace = false;
  for (const token of String(value || "")) {
    const decoded = decodeFanqieText(token, charset);
    for (const character of decoded) {
      if (/[\u200B-\u200D\uFEFF]/u.test(character)) continue;
      if (/\s/u.test(character)) {
        pendingWhitespace = true;
        continue;
      }
      if (pendingWhitespace) {
        if (output.length >= MAX_STATISTICS_SOURCE_CHARS) return output;
        output += " ";
        pendingWhitespace = false;
      }
      if (output.length >= MAX_STATISTICS_SOURCE_CHARS) return output;
      output += character;
    }
  }
  if (pendingWhitespace && output.length < MAX_STATISTICS_SOURCE_CHARS) output += " ";
  return output;
}

function appendBoundedText(value, addition, maximum) {
  if (!addition) return value;
  if (value.length >= maximum) return value;
  const startIndex = value.endsWith(" ") && addition.startsWith(" ") ? 1 : 0;
  return value + addition.slice(startIndex, startIndex + maximum - value.length);
}

function findStatisticsCandidate(root, charset) {
  // This is one bounded post-order pass. Each visible subtree is summarized
  // once and capped before it can grow with the source response.
  const summaries = new Map();
  const stack = [{ node: root, exiting: false, insideItem: false, order: 0 }];
  let nextOrder = 0;
  let best = null;

  while (stack.length) {
    const frame = stack.pop();
    const { node } = frame;
    if (isTextNode(node)) {
      summaries.set(node, boundedStatisticsText(node.value, charset));
      continue;
    }

    if (!frame.exiting) {
      if (isElementNode(node) && elementIsHidden(node)) {
        summaries.set(node, "");
        continue;
      }
      const insideItem = frame.insideItem || (isElementNode(node) && hasClass(node, "rank-book-item"));
      const order = nextOrder;
      nextOrder += 1;
      stack.push({ node, exiting: true, insideItem, order });
      const children = extractionChildren(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({ node: children[index], exiting: false, insideItem, order: 0 });
      }
      continue;
    }

    if (!isElementNode(node)) {
      summaries.set(node, "");
      continue;
    }
    let summary = TEXT_BOUNDARY_ELEMENTS.has(node.tagName) ? " " : "";
    for (const child of extractionChildren(node)) {
      summary = appendBoundedText(summary, summaries.get(child) || "", MAX_STATISTICS_SOURCE_CHARS);
      summaries.delete(child);
    }
    if (TEXT_BOUNDARY_ELEMENTS.has(node.tagName)) {
      summary = appendBoundedText(summary, " ", MAX_STATISTICS_SOURCE_CHARS);
    }
    summaries.set(node, summary);

    if (!frame.insideItem && STATISTICS_ELEMENTS.has(node.tagName)) {
      const value = normalizeDecodedValue(summary, 500);
      if (value
        && /(?:\u7edf\u8ba1.{0,24}(?:\u622a\u6b62|\u622a\u81f3)|(?:\u622a\u6b62|\u622a\u81f3).{0,24}\u7edf\u8ba1)/u.test(value)
        && (!best
          || value.length < best.value.length
          || (value.length === best.value.length && frame.order < best.order))) {
        best = { node, value, order: frame.order };
      }
    }
  }
  return best;
}

function parseRankPage(html, { charset, maxItems, maxDescriptionChars }) {
  const document = parseHtml(html);
  applyStylesheetVisibility(document);
  const headingNodes = findElements(document, (node) => (
    node.tagName === "h1" && !hasAncestorClass(node, "rank-book-item")
  ));
  const headingNode = headingNodes.find(hasRankHeadingContext) || headingNodes[0] || null;
  const titleHasUnknownPua = hasUnknownPuaMapping(headingNode, charset);
  const title = normalizedText(headingNode, charset, ITEM_TEXT_LIMITS.title);

  const statisticsCandidate = findStatisticsCandidate(document, charset);
  const statisticsTime = truncateCharacters(statisticsCandidate?.value || "", 240) || null;
  const statisticsHasUnknownPua = hasUnknownPuaMapping(statisticsCandidate?.node, charset);

  const itemNodes = findElements(document, (node) => hasClass(node, "rank-book-item")).slice(0, maxItems);
  const uncertainFields = [];
  const items = itemNodes.map((itemNode, itemIndex) => {
    const rankContainer = findFirst(itemNode, (node) => hasClass(node, "book-item-index"));
    const rankNode = rankContainer && findFirstIncluding(rankContainer, (node) => node.tagName === "h1");
    const titleContainer = findFirst(itemNode, (node) => hasClass(node, "title"));
    const titleAnchor = titleContainer && findFirstIncluding(titleContainer, (node) => (
      node.tagName === "a" && String(attributeValue(node, "href") || "").startsWith("/page/")
    ));
    const authorContainer = findFirst(itemNode, (node) => hasClass(node, "author"));
    const authorAnchor = authorContainer && findFirstIncluding(authorContainer, (node) => node.tagName === "a");
    const authorSpan = authorContainer && findFirstIncluding(authorContainer, (node) => node.tagName === "span");
    const descriptionNode = findFirst(itemNode, (node) => hasClass(node, "desc") && hasClass(node, "abstract"));
    const readCountNode = findFirst(itemNode, (node) => hasClass(node, "book-item-count"));
    const statusNode = findFirst(itemNode, (node) => hasClass(node, "book-item-footer-status"));
    const chapterNode = findFirst(itemNode, (node) => node.tagName === "a" && hasClass(node, "chapter"));
    const updateTimeNode = findFirst(itemNode, (node) => hasClass(node, "book-item-footer-time"));
    const authorAnchorValue = normalizedText(authorAnchor, charset, ITEM_TEXT_LIMITS.author);
    const authorSpanValue = normalizedText(authorSpan, charset, ITEM_TEXT_LIMITS.author);
    const authorNode = authorAnchorValue ? authorAnchor : (authorSpanValue ? authorSpan : null);
    const statusAndTags = parseStatusAndTags(statusNode, charset);
    const chapter = normalizedText(chapterNode, charset, ITEM_TEXT_LIMITS.latestPart);
    const updateTime = normalizedText(updateTimeNode, charset, ITEM_TEXT_LIMITS.latestPart);
    const latestUpdate = truncateCharacters([chapter, updateTime].filter(Boolean).join(" / "), ITEM_TEXT_LIMITS.latestUpdate) || null;

    const item = {
      rank: normalizedText(rankNode, charset, ITEM_TEXT_LIMITS.rank),
      title: normalizedText(titleAnchor, charset, ITEM_TEXT_LIMITS.title),
      author: authorAnchorValue || authorSpanValue,
      readCount: normalizedText(readCountNode, charset, ITEM_TEXT_LIMITS.readCount),
      status: statusAndTags.status,
      tags: statusAndTags.tags,
      latestUpdate,
      description: normalizedText(descriptionNode, charset, maxDescriptionChars)
    };

    const unknownFields = {
      rank: hasUnknownPuaMapping(rankNode, charset),
      title: hasUnknownPuaMapping(titleAnchor, charset),
      author: hasUnknownPuaMapping(authorNode, charset),
      readCount: hasUnknownPuaMapping(readCountNode, charset),
      status: statusAndTags.statusUnknown,
      tags: statusAndTags.tagsUnknown,
      description: hasUnknownPuaMapping(descriptionNode, charset)
    };
    for (const field of ["rank", "title", "author", "readCount", "status", "tags", "description"]) {
      const missing = field === "tags" ? !item.tags.length : !item[field];
      const uncertain = field === "title"
        ? unknownFields.title || titleIsUncertain(item.title)
        : unknownFields[field];
      if (missing || uncertain) {
        uncertainFields.push(`items[${itemIndex}].${field}`);
      }
    }
    if (!chapter
      || !updateTime
      || hasUnknownPuaMapping(chapterNode, charset)
      || hasUnknownPuaMapping(updateTimeNode, charset)) {
      uncertainFields.push(`items[${itemIndex}].latestUpdate`);
    }
    return item;
  });

  if (titleHasUnknownPua || titleIsUncertain(title)) uncertainFields.unshift("title");
  if (!statisticsTime || statisticsHasUnknownPua) {
    uncertainFields.splice(uncertainFields[0] === "title" ? 1 : 0, 0, "statisticsTime");
  }
  if (!items.length) uncertainFields.push("items");
  return { title, statisticsTime, items, uncertainFields };
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/\\/gu, "\\\\")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/([`*_[\]#])/gu, "\\$1");
}

function displayValue(value) {
  return value ? escapeMarkdown(value) : "\u672a\u63d0\u4f9b\uff08\u4e0d\u786e\u5b9a\uff09";
}

function localDateStamp(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function renderEvidence({ sourceUrl, capturedAt, title, statisticsTime, items, uncertainFields }) {
  const lines = [
    "# \u756a\u8304\u516c\u5f00\u699c\u5355\u5e02\u573a\u8bc1\u636e",
    "",
    `- \u91c7\u96c6\u65f6\u95f4\uff1a${capturedAt}`,
    `- \u699c\u5355\u7edf\u8ba1\u65f6\u95f4\uff1a${displayValue(statisticsTime)}`,
    `- \u6765\u6e90 URL\uff1a${escapeMarkdown(sourceUrl)}`,
    `- \u9875\u9762\u6807\u9898\uff1a${displayValue(title)}`,
    "",
    "## \u4e0d\u786e\u5b9a\u9879"
  ];

  if (uncertainFields.length) {
    for (const field of uncertainFields) {
      lines.push(`- \`${field}\`\uff1a\u9875\u9762\u672a\u63d0\u4f9b\u5b8c\u6574\u5b57\u6bb5\uff0c\u672a\u4f5c\u63a8\u65ad\u3002`);
    }
  } else {
    lines.push("- \u672a\u53d1\u73b0\u7f3a\u5931\u5b57\u6bb5\u3002");
  }

  lines.push("", "## \u699c\u5355\u6761\u76ee");
  items.forEach((item, index) => {
    lines.push(
      "",
      `### \u6761\u76ee ${index + 1}`,
      `- \u6392\u540d\uff1a${displayValue(item.rank)}`,
      `- \u4e66\u540d\uff1a${displayValue(item.title)}`,
      `- \u4f5c\u8005\uff1a${displayValue(item.author)}`,
      `- \u5728\u8bfb\u91cf\uff1a${displayValue(item.readCount)}`,
      `- \u72b6\u6001\uff1a${displayValue(item.status)}`,
      `- \u6807\u7b7e\uff1a${displayValue(item.tags.length ? item.tags.join(" / ") : null)}`,
      `- \u6700\u65b0\u66f4\u65b0\uff1a${displayValue(item.latestUpdate)}`,
      `- \u7b80\u4ecb\uff1a${displayValue(item.description)}`
    );
  });
  return `${lines.join("\n")}\n`;
}

function createMarketResearch({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxHtmlChars = DEFAULT_MAX_HTML_CHARS,
  maxItems = DEFAULT_MAX_ITEMS,
  maxDescriptionChars = DEFAULT_MAX_DESCRIPTION_CHARS,
  charset
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw createError("MARKET_FETCH_REQUIRED", "A fetch implementation is required.");
  }
  if (typeof now !== "function") {
    throw createError("MARKET_TIME_REQUIRED", "now must be a function.");
  }

  const safeRequestTimeoutMs = positiveInteger(
    requestTimeoutMs,
    DEFAULT_REQUEST_TIMEOUT_MS,
    MAX_REQUEST_TIMEOUT_MS
  );
  const safeMaxHtmlChars = positiveInteger(maxHtmlChars, DEFAULT_MAX_HTML_CHARS, MAX_HTML_CHARS);
  const safeMaxItems = positiveInteger(maxItems, DEFAULT_MAX_ITEMS, MAX_ITEMS);
  const safeMaxDescriptionChars = positiveInteger(
    maxDescriptionChars,
    DEFAULT_MAX_DESCRIPTION_CHARS,
    MAX_DESCRIPTION_CHARS
  );
  const safeCharset = charset === undefined
    ? bundledCharset
    : (Array.isArray(charset?.[0]) ? charset[0] : charset);

  async function scan({ projectPath, rankUrl } = {}) {
    const sourceUrl = normalizeRankUrl(rankUrl);
    const projectRoot = normalizeProjectPath(projectPath);
    const capturedDate = new Date(now());
    if (Number.isNaN(capturedDate.getTime())) {
      throw createError("MARKET_TIME_INVALID", "now returned an invalid date.");
    }
    const capturedAt = capturedDate.toISOString();

    let response;
    try {
      response = await fetchImpl(sourceUrl, {
        redirect: "error",
        signal: AbortSignal.timeout(safeRequestTimeoutMs)
      });
    } catch (error) {
      throw createError("MARKET_REQUEST_FAILED", "The public Fanqie rank request failed.", error);
    }

    if (!response || !Number.isInteger(response.status)) {
      throw createError("MARKET_RESPONSE_INVALID", "The Fanqie rank response is invalid.");
    }
    if (response.status !== 200) {
      throw createError("MARKET_HTTP_ERROR", `Fanqie returned HTTP ${response.status || "unknown"}.`);
    }
    if (!responseIsHtml(response)) {
      throw createError("MARKET_RESPONSE_NOT_HTML", "The Fanqie rank response was not HTML.");
    }

    let html;
    try {
      html = await readBoundedHtml(response, safeMaxHtmlChars);
    } catch (error) {
      if (error?.code === "MARKET_RESPONSE_TOO_LARGE" || error?.code === "MARKET_RESPONSE_INVALID") throw error;
      throw createError("MARKET_RESPONSE_READ_FAILED", "The Fanqie rank response could not be read.", error);
    }

    let parsed;
    try {
      parsed = parseRankPage(html, {
        charset: safeCharset,
        maxItems: safeMaxItems,
        maxDescriptionChars: safeMaxDescriptionChars
      });
    } catch (error) {
      if (error?.code === "MARKET_RESPONSE_TOO_COMPLEX") throw error;
      throw createError("MARKET_RESPONSE_INVALID", "The Fanqie rank HTML could not be parsed.", error);
    }

    const result = {
      sourceUrl,
      capturedAt,
      title: parsed.title,
      statisticsTime: parsed.statisticsTime,
      items: parsed.items,
      relativePath: `.fiction-director/working/market-${localDateStamp(capturedDate)}.md`,
      uncertainFields: parsed.uncertainFields
    };
    const evidencePath = path.join(projectRoot, ...result.relativePath.split("/"));
    const evidence = renderEvidence(result);
    if ([...evidence].length > MAX_EVIDENCE_CHARS) {
      throw createError("MARKET_EVIDENCE_TOO_LARGE", "The market evidence record exceeded its fixed size limit.");
    }
    try {
      await fs.mkdir(path.dirname(evidencePath), { recursive: true });
      await fs.writeFile(evidencePath, evidence, "utf8");
    } catch (error) {
      throw createError("MARKET_EVIDENCE_WRITE_FAILED", "The market evidence record could not be written.", error);
    }
    return result;
  }

  return { scan };
}

module.exports = { createMarketResearch };
