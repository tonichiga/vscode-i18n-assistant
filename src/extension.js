const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const vscode = require("vscode");

const COMMAND_ID = "i18nAssistant.extractToDictionary";
const EMPTY_PREFIX = "EMPTY {{";

const SUPPORTED_LANGUAGES = [
  "javascriptreact",
  "typescriptreact",
  "javascript",
  "typescript",
];

function activate(context) {
  const disposable = vscode.commands.registerCommand(
    COMMAND_ID,
    async (input) => {
      try {
        await runExtractFlow(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`i18n Assistant: ${message}`);
      }
    },
  );

  const quickFixProvider = vscode.languages.registerCodeActionsProvider(
    SUPPORTED_LANGUAGES,
    {
      provideCodeActions(document, range) {
        const candidate = getStringCandidate(document, range);
        if (!candidate) {
          return undefined;
        }

        const action = new vscode.CodeAction(
          "Extract to i18n dictionary",
          vscode.CodeActionKind.RefactorExtract,
        );

        action.isPreferred = true;

        const quickFixAction = new vscode.CodeAction(
          "Extract to i18n dictionary",
          vscode.CodeActionKind.QuickFix,
        );

        quickFixAction.command = {
          command: COMMAND_ID,
          title: "Extract selected text",
          arguments: [
            {
              range: {
                start: {
                  line: candidate.range.start.line,
                  character: candidate.range.start.character,
                },
                end: {
                  line: candidate.range.end.line,
                  character: candidate.range.end.character,
                },
              },
              selectedText: candidate.selectedText,
            },
          ],
        };

        action.command = {
          command: COMMAND_ID,
          title: "Extract selected text",
          arguments: [
            {
              range: {
                start: {
                  line: candidate.range.start.line,
                  character: candidate.range.start.character,
                },
                end: {
                  line: candidate.range.end.line,
                  character: candidate.range.end.character,
                },
              },
              selectedText: candidate.selectedText,
            },
          ],
        };

        return [action, quickFixAction];
      },
    },
    {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorExtract,
      ],
    },
  );

  context.subscriptions.push(disposable, quickFixProvider);
}

function deactivate() {}

function getWorkspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error("Open a workspace folder to use this command.");
  }

  return folders[0].uri.fsPath;
}

function normalizeLanguageList(rawLanguages, settingName) {
  if (!Array.isArray(rawLanguages) || rawLanguages.length === 0) {
    throw new Error(
      `Setting ${settingName} must contain at least one language.`,
    );
  }

  const normalized = rawLanguages
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new Error(
      `Setting ${settingName} must contain at least one language.`,
    );
  }

  return Array.from(new Set(normalized));
}

function validateLanguageConfig(rawLanguages, rawBaseLanguage, settingName) {
  const languages = normalizeLanguageList(rawLanguages, settingName);
  const baseLanguage =
    typeof rawBaseLanguage === "string" ? rawBaseLanguage.trim() : "";

  if (!baseLanguage) {
    throw new Error("Setting i18nAssistant.baseLanguage is required.");
  }

  if (!languages.includes(baseLanguage)) {
    throw new Error(
      `Base language ${baseLanguage} must be listed in ${settingName}.`,
    );
  }

  return { languages, baseLanguage };
}

function parseDictionaryRootEntry(
  entry,
  globalLanguages,
  globalBaseLanguage,
  index,
) {
  const defaultLanguages = [...globalLanguages];
  const defaultBaseLanguage = globalBaseLanguage;

  if (typeof entry === "string") {
    const rootPath = entry.trim();
    if (!rootPath) {
      throw new Error(
        `Setting i18nAssistant.dictionaryRootPaths[${index}] has an empty root path.`,
      );
    }

    return {
      rootPath,
      languages: defaultLanguages,
      baseLanguage: defaultBaseLanguage,
    };
  }

  if (Array.isArray(entry)) {
    const [rawRootPath, rawLanguages, rawBaseLanguage] = entry;
    const rootPath = typeof rawRootPath === "string" ? rawRootPath.trim() : "";

    if (!rootPath) {
      throw new Error(
        `Setting i18nAssistant.dictionaryRootPaths[${index}][0] must be a non-empty root path string.`,
      );
    }

    const languages =
      rawLanguages === undefined
        ? defaultLanguages
        : normalizeLanguageList(
            rawLanguages,
            `i18nAssistant.dictionaryRootPaths[${index}][1]`,
          );

    const baseLanguage =
      typeof rawBaseLanguage === "string" && rawBaseLanguage.trim()
        ? rawBaseLanguage.trim()
        : defaultBaseLanguage;

    if (!languages.includes(baseLanguage)) {
      throw new Error(
        `Base language ${baseLanguage} must be listed in i18nAssistant.dictionaryRootPaths[${index}][1].`,
      );
    }

    return { rootPath, languages, baseLanguage };
  }

  if (entry && typeof entry === "object") {
    const rootPath =
      typeof entry.rootPath === "string" ? entry.rootPath.trim() : "";

    if (!rootPath) {
      throw new Error(
        `Setting i18nAssistant.dictionaryRootPaths[${index}].rootPath must be a non-empty string.`,
      );
    }

    const languages =
      entry.languages === undefined
        ? defaultLanguages
        : normalizeLanguageList(
            entry.languages,
            `i18nAssistant.dictionaryRootPaths[${index}].languages`,
          );

    const baseLanguage =
      typeof entry.baseLanguage === "string" && entry.baseLanguage.trim()
        ? entry.baseLanguage.trim()
        : defaultBaseLanguage;

    if (!languages.includes(baseLanguage)) {
      throw new Error(
        `Base language ${baseLanguage} must be listed in i18nAssistant.dictionaryRootPaths[${index}].languages.`,
      );
    }

    return { rootPath, languages, baseLanguage };
  }

  throw new Error(
    "Setting i18nAssistant.dictionaryRootPaths items must be strings, arrays, or objects.",
  );
}

function parseDictionaryRootEntries(
  rawEntries,
  globalLanguages,
  globalBaseLanguage,
) {
  if (!Array.isArray(rawEntries)) {
    throw new Error(
      "Setting i18nAssistant.dictionaryRootPaths must be an array.",
    );
  }

  const parsed = rawEntries.map((entry, index) =>
    parseDictionaryRootEntry(entry, globalLanguages, globalBaseLanguage, index),
  );

  const unique = [];
  const seen = new Set();

  for (const item of parsed) {
    if (seen.has(item.rootPath)) {
      continue;
    }

    seen.add(item.rootPath);
    unique.push(item);
  }

  return unique;
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("i18nAssistant");
  const rawLanguages = config.get("languages", ["uk", "en", "pl"]);
  const rawBaseLanguage = config.get("baseLanguage", "uk");
  const dictionaryRootPath = config.get("dictionaryRootPath", ".");
  const rawDictionaryRootPaths = config.get("dictionaryRootPaths", []);
  const dictionaryDir = config.get("dictionaryDir", "dictionaries");
  const missingTranslationStrategy = config.get(
    "missingTranslationStrategy",
    "empty-marker",
  );
  const runPostHook = config.get("runPostHook", false);
  const postHookCommand = config.get(
    "postHookCommand",
    "npm run i18n:check-empty",
  );
  const translationImportModule = config.get(
    "translationImportModule",
    "react-i18next",
  );
  const translationImportName = config.get(
    "translationImportName",
    "useTranslation",
  );
  const translationHookSnippet = config.get(
    "translationHookSnippet",
    "const { t } = useTranslation();",
  );
  const translationFunctionName = config.get("translationFunctionName", "t");

  const languageConfig = validateLanguageConfig(
    rawLanguages,
    rawBaseLanguage,
    "i18nAssistant.languages",
  );
  const languages = languageConfig.languages;
  const baseLanguage = languageConfig.baseLanguage;

  if (!translationImportModule || !translationImportModule.trim()) {
    throw new Error(
      "Setting i18nAssistant.translationImportModule is required.",
    );
  }

  if (!translationImportName || !translationImportName.trim()) {
    throw new Error("Setting i18nAssistant.translationImportName is required.");
  }

  if (!translationHookSnippet || !translationHookSnippet.trim()) {
    throw new Error(
      "Setting i18nAssistant.translationHookSnippet is required.",
    );
  }

  if (!translationFunctionName || !translationFunctionName.trim()) {
    throw new Error(
      "Setting i18nAssistant.translationFunctionName is required.",
    );
  }

  if (!dictionaryRootPath || !dictionaryRootPath.trim()) {
    throw new Error("Setting i18nAssistant.dictionaryRootPath is required.");
  }

  const dictionaryRoots = parseDictionaryRootEntries(
    rawDictionaryRootPaths,
    languages,
    baseLanguage,
  );

  return {
    languages,
    baseLanguage,
    dictionaryRootPath: dictionaryRootPath.trim(),
    dictionaryRoots,
    dictionaryDir,
    missingTranslationStrategy,
    runPostHook,
    postHookCommand,
    translationImportModule: translationImportModule.trim(),
    translationImportName: translationImportName.trim(),
    translationHookSnippet: translationHookSnippet.trim(),
    translationFunctionName: translationFunctionName.trim(),
  };
}

function resolveConfiguredPath(workspaceRoot, configuredPath) {
  if (path.isAbsolute(configuredPath)) {
    return path.normalize(configuredPath);
  }

  return path.resolve(workspaceRoot, configuredPath);
}

function isPathInside(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function getDictionaryRootCandidates(workspaceRoot, config) {
  const configuredRoots =
    config.dictionaryRoots.length > 0
      ? config.dictionaryRoots
      : [
          {
            rootPath: config.dictionaryRootPath,
            languages: config.languages,
            baseLanguage: config.baseLanguage,
          },
        ];

  return configuredRoots.map((item) => ({
    rootPath: resolveConfiguredPath(workspaceRoot, item.rootPath),
    languages: item.languages,
    baseLanguage: item.baseLanguage,
  }));
}

function resolveDictionaryTarget(workspaceRoot, activeFilePath, config) {
  const candidates = getDictionaryRootCandidates(workspaceRoot, config);

  if (candidates.length === 0) {
    return {
      rootPath: workspaceRoot,
      languages: config.languages,
      baseLanguage: config.baseLanguage,
    };
  }

  const inScope = candidates
    .filter((item) => isPathInside(item.rootPath, activeFilePath))
    .sort((a, b) => b.rootPath.length - a.rootPath.length);

  const orderedCandidates = inScope.length > 0 ? inScope : candidates;

  for (const candidate of orderedCandidates) {
    const baseDictionary = path.join(
      candidate.rootPath,
      config.dictionaryDir,
      `${candidate.baseLanguage}.json`,
    );

    if (fs.existsSync(baseDictionary)) {
      return candidate;
    }
  }

  return orderedCandidates[0];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getStringCandidate(document, range) {
  if (!range.isEmpty) {
    const raw = document.getText(range);
    const selectedText = parseSelectedText(raw);
    if (!selectedText) {
      return undefined;
    }

    return { range, selectedText };
  }

  const position = range.start;
  const line = document.lineAt(position.line);
  const literal = findQuotedLiteralAtPosition(line.text, position.character);

  if (!literal) {
    return undefined;
  }

  const start = new vscode.Position(position.line, literal.start + 1);
  const end = new vscode.Position(position.line, literal.end - 1);
  const literalRange = new vscode.Range(start, end);
  const selectedText = parseSelectedText(document.getText(literalRange));

  if (!selectedText) {
    return undefined;
  }

  return { range: literalRange, selectedText };
}

function findQuotedLiteralAtPosition(lineText, character) {
  const regex = /(["'`])(?:\\.|(?!\1).)*\1/g;
  let match = regex.exec(lineText);

  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    if (character >= start && character <= end) {
      return { start, end };
    }

    match = regex.exec(lineText);
  }

  return undefined;
}

function parseSelectedText(raw) {
  const trimmed = raw.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  const endsWithSameQuote =
    (quote === '"' || quote === "'" || quote === "`") &&
    trimmed[trimmed.length - 1] === quote;

  if (endsWithSameQuote) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function getNestedValue(obj, keyPath) {
  const parts = keyPath.split(".").filter(Boolean);
  let current = obj;

  for (const part of parts) {
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, part)
    ) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

function setNestedValue(obj, keyPath, value) {
  const parts = keyPath.split(".").filter(Boolean);
  let current = obj;

  for (let index = 0; index < parts.length - 1; index += 1) {
    const key = parts[index];
    if (
      !Object.prototype.hasOwnProperty.call(current, key) ||
      current[key] === null ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    ) {
      current[key] = {};
    }

    current = current[key];
  }

  current[parts[parts.length - 1]] = value;
}

function loadJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Dictionary file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function suggestKeyFromText(text) {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);

  return slug ? `common.${slug}` : "common.new_key";
}

function ensureUseTranslationImport(documentText, config) {
  const importName = config.translationImportName;
  const importModule = config.translationImportModule;
  const importNameRegex = escapeRegex(importName);
  const importModuleRegex = escapeRegex(importModule);

  const hasNamedImport = new RegExp(
    `import\\s*\\{[^}]*\\b${importNameRegex}\\b[^}]*\\}\\s*from\\s*["']${importModuleRegex}["'];?`,
    "m",
  ).test(documentText);

  if (hasNamedImport) {
    return documentText;
  }

  const providerNamedImportRegex = new RegExp(
    `import\\s*\\{([^}]*)\\}\\s*from\\s*["']${importModuleRegex}["'];?`,
    "m",
  );

  if (providerNamedImportRegex.test(documentText)) {
    return documentText.replace(providerNamedImportRegex, (full, members) => {
      const normalized = members
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      if (!normalized.includes(importName)) {
        normalized.push(importName);
      }

      return `import { ${normalized.join(", ")} } from "${importModule}";`;
    });
  }

  const importRegex = /^import\s.+;\s*$/gm;
  const matches = [...documentText.matchAll(importRegex)];

  if (matches.length === 0) {
    return `import { ${importName} } from "${importModule}";\n${documentText}`;
  }

  const last = matches[matches.length - 1];
  const insertIndex = (last.index || 0) + last[0].length;

  return `${documentText.slice(0, insertIndex)}\nimport { ${importName} } from "${importModule}";${documentText.slice(insertIndex)}`;
}

function formatHookSnippetForInsertion(snippet) {
  return snippet
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");
}

function ensureHookUsage(documentText, config) {
  const importName = config.translationImportName;
  const functionName = config.translationFunctionName;
  const hookSnippet = config.translationHookSnippet;

  if (documentText.includes(hookSnippet)) {
    return documentText;
  }

  const hasFunctionAssignment = new RegExp(
    `\\b(?:const|let|var)\\s+(?:\\{\\s*${escapeRegex(functionName)}\\s*\\}|${escapeRegex(functionName)})\\s*=\\s*${escapeRegex(importName)}\\s*\\(`,
    "m",
  ).test(documentText);

  if (hasFunctionAssignment) {
    return documentText;
  }

  const functionStartRegex =
    /(const\s+\w+\s*=\s*\([^)]*\)\s*=>\s*\{|function\s+\w+\s*\([^)]*\)\s*\{)/m;
  const match = functionStartRegex.exec(documentText);

  if (!match) {
    return documentText;
  }

  const start = (match.index || 0) + match[0].length;
  const insertion = `\n${formatHookSnippetForInsertion(hookSnippet)}`;

  return `${documentText.slice(0, start)}${insertion}${documentText.slice(start)}`;
}

function replaceSelectedText(
  documentText,
  startOffset,
  endOffset,
  keyPath,
  config,
) {
  const replacement = `{${config.translationFunctionName}("${keyPath}")}`;
  return `${documentText.slice(0, startOffset)}${replacement}${documentText.slice(endOffset)}`;
}

function jsonForInlineScript(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

function normalizeTranslations(
  languages,
  baseLanguage,
  baseText,
  strategy,
  rawTranslations,
) {
  const result = {};

  for (const lang of languages) {
    const value =
      typeof rawTranslations[lang] === "string"
        ? rawTranslations[lang].trim()
        : "";
    const isBase = lang === baseLanguage;

    if (isBase) {
      if (!value) {
        throw new Error("Base translation cannot be empty.");
      }
      result[lang] = value;
      continue;
    }

    if (value) {
      result[lang] = value;
      continue;
    }

    result[lang] =
      strategy === "copy-base"
        ? result[baseLanguage]
        : `${EMPTY_PREFIX}${result[baseLanguage]}}}`;
  }

  return result;
}

function askPayloadViaWebview(config, selectedText, suggestedKey) {
  return new Promise((resolve) => {
    let settled = false;
    const safeResolve = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    const panel = vscode.window.createWebviewPanel(
      "i18nAssistantExtract",
      "i18n Extract",
      vscode.ViewColumn.Active,
      { enableScripts: true },
    );

    const initialTranslations = {};
    for (const lang of config.languages) {
      initialTranslations[lang] =
        lang === config.baseLanguage ? selectedText : "";
    }

    const payloadJson = jsonForInlineScript({
      languages: config.languages,
      baseLanguage: config.baseLanguage,
      suggestedKey,
      selectedText,
      initialTranslations,
    });

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        padding: 16px;
      }
      .field {
        margin-bottom: 12px;
      }
      label {
        display: block;
        font-weight: 600;
        margin-bottom: 6px;
      }
      input, textarea {
        width: 100%;
        box-sizing: border-box;
        padding: 8px;
      }
      .buttons {
        display: flex;
        gap: 8px;
        margin-top: 16px;
      }
      button {
        padding: 8px 12px;
      }
      .hint {
        opacity: 0.8;
        margin-bottom: 12px;
      }
      .lang-badge {
        opacity: 0.8;
      }
    </style>
  </head>
  <body>
    <h2>Extract text to i18n</h2>
    <p class="hint">Selected text: <strong id="selectedText"></strong></p>

    <div class="field">
      <label for="keyPath">Dictionary key</label>
      <input id="keyPath" />
    </div>

    <div id="translations"></div>

    <div class="buttons">
      <button id="submitBtn">Save and Replace</button>
      <button id="cancelBtn" type="button">Cancel</button>
    </div>

    <script>
      const vscode = acquireVsCodeApi();
      const payload = ${payloadJson};

      const selectedTextEl = document.getElementById("selectedText");
      const keyPathEl = document.getElementById("keyPath");
      const translationsEl = document.getElementById("translations");

      selectedTextEl.textContent = payload.selectedText;
      keyPathEl.value = payload.suggestedKey;

      payload.languages.forEach((lang) => {
        const wrapper = document.createElement("div");
        wrapper.className = "field";

        const label = document.createElement("label");
        label.textContent = "Translation: " + lang + (lang === payload.baseLanguage ? " (base)" : "");

        const input = document.createElement("textarea");
        input.id = "lang_" + lang;
        input.rows = 2;
        input.value = payload.initialTranslations[lang] || "";

        wrapper.appendChild(label);
        wrapper.appendChild(input);
        translationsEl.appendChild(wrapper);
      });

      document.getElementById("submitBtn").addEventListener("click", () => {
        const keyPath = keyPathEl.value.trim();
        const translations = {};

        payload.languages.forEach((lang) => {
          const input = document.getElementById("lang_" + lang);
          translations[lang] = input ? input.value : "";
        });

        vscode.postMessage({
          type: "submit",
          keyPath,
          translations,
        });
      });

      document.getElementById("cancelBtn").addEventListener("click", () => {
        vscode.postMessage({ type: "cancel" });
      });
    </script>
  </body>
</html>`;

    const disposable = panel.webview.onDidReceiveMessage((message) => {
      if (!message || typeof message !== "object") {
        return;
      }

      if (message.type === "cancel") {
        disposable.dispose();
        safeResolve(undefined);
        panel.dispose();
        return;
      }

      if (message.type === "submit") {
        const keyPath =
          typeof message.keyPath === "string" ? message.keyPath.trim() : "";
        if (!keyPath) {
          vscode.window.showWarningMessage("Key is required.");
          return;
        }

        if (!/^[a-zA-Z0-9_.-]+$/.test(keyPath)) {
          vscode.window.showWarningMessage(
            "Use letters, digits, dot, underscore and dash only.",
          );
          return;
        }

        try {
          const translations = normalizeTranslations(
            config.languages,
            config.baseLanguage,
            selectedText,
            config.missingTranslationStrategy,
            message.translations || {},
          );

          disposable.dispose();
          safeResolve({ keyPath, translations });
          panel.dispose();
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          vscode.window.showWarningMessage(text);
        }
      }
    });

    panel.onDidDispose(() => {
      disposable.dispose();
      safeResolve(undefined);
    });
  });
}

function execAsync(command, cwd) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function runPostHookIfEnabled(config, workspaceRoot) {
  if (!config.runPostHook) {
    return;
  }

  if (!config.postHookCommand || !config.postHookCommand.trim()) {
    return;
  }

  try {
    const result = await execAsync(config.postHookCommand, workspaceRoot);
    const output = result.stdout.trim();
    if (output) {
      vscode.window.showInformationMessage(`Post-hook finished: ${output}`);
    } else {
      vscode.window.showInformationMessage("Post-hook finished successfully.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Post-hook failed: ${message}`);
  }
}

async function runExtractFlow(input) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("Open a file and select text first.");
  }

  const selection =
    input && input.range
      ? new vscode.Selection(
          new vscode.Position(
            input.range.start.line,
            input.range.start.character,
          ),
          new vscode.Position(input.range.end.line, input.range.end.character),
        )
      : editor.selection;

  if (selection.isEmpty) {
    throw new Error("Select text to extract to dictionary.");
  }

  const document = editor.document;
  const selectedText =
    input && typeof input.selectedText === "string"
      ? parseSelectedText(input.selectedText)
      : parseSelectedText(document.getText(selection));

  if (!selectedText) {
    throw new Error("Selected text is empty after trimming.");
  }

  const config = getConfig();
  const workspaceRoot = getWorkspaceRoot();
  const selectedDictionaryTarget = resolveDictionaryTarget(
    workspaceRoot,
    document.uri.fsPath,
    config,
  );
  const effectiveConfig = {
    ...config,
    languages: selectedDictionaryTarget.languages,
    baseLanguage: selectedDictionaryTarget.baseLanguage,
  };

  const payload = await askPayloadViaWebview(
    effectiveConfig,
    selectedText,
    suggestKeyFromText(selectedText),
  );

  if (!payload) {
    return;
  }
  const dictionaryRoot = path.join(
    selectedDictionaryTarget.rootPath,
    config.dictionaryDir,
  );
  const keyPath = payload.keyPath;
  const translations = payload.translations;

  const dictionariesByLang = {};
  for (const lang of effectiveConfig.languages) {
    const dictionaryFilePath = path.join(dictionaryRoot, `${lang}.json`);
    dictionariesByLang[lang] = {
      filePath: dictionaryFilePath,
      data: loadJson(dictionaryFilePath),
    };
  }

  const existingInBase = getNestedValue(
    dictionariesByLang[effectiveConfig.baseLanguage].data,
    keyPath,
  );

  if (typeof existingInBase === "string") {
    const choice = await vscode.window.showQuickPick(["Overwrite", "Cancel"], {
      title: `Key ${keyPath} already exists in ${effectiveConfig.baseLanguage}.json`,
      placeHolder: "Choose what to do",
    });

    if (choice !== "Overwrite") {
      return;
    }
  }

  for (const lang of effectiveConfig.languages) {
    setNestedValue(dictionariesByLang[lang].data, keyPath, translations[lang]);
    saveJson(dictionariesByLang[lang].filePath, dictionariesByLang[lang].data);
  }

  const latestDocument = await vscode.workspace.openTextDocument(document.uri);
  const startOffset = latestDocument.offsetAt(selection.start);
  const endOffset = latestDocument.offsetAt(selection.end);

  let updatedText = replaceSelectedText(
    latestDocument.getText(),
    startOffset,
    endOffset,
    keyPath,
    config,
  );

  updatedText = ensureUseTranslationImport(updatedText, config);
  updatedText = ensureHookUsage(updatedText, config);

  const fullRange = new vscode.Range(
    latestDocument.positionAt(0),
    latestDocument.positionAt(latestDocument.getText().length),
  );

  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.replace(latestDocument.uri, fullRange, updatedText);

  const success = await vscode.workspace.applyEdit(workspaceEdit);

  if (!success) {
    throw new Error("Could not apply code changes in editor.");
  }

  await runPostHookIfEnabled(config, workspaceRoot);

  vscode.window.showInformationMessage(
    `i18n key ${keyPath} added for ${effectiveConfig.languages.join(", ")}.`,
  );
}

module.exports = {
  activate,
  deactivate,
};
