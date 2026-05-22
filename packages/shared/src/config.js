const fs = require("fs");
const os = require("os");
const path = require("path");

function loadProjectConfig(rootDir) {
  const defaultConfig = {
    dataDir: ".data",
    viewerPort: 3939,
    cli: {
      maxOutputChars: 200000
    },
    codex: {
      root: "",
      includeArchived: true,
      projectPathMode: "realpath"
    }
  };

  const configPath = path.join(rootDir, "codex-focus-ui.config.json");
  if (!fs.existsSync(configPath)) return defaultConfig;

  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    return {
      ...defaultConfig,
      ...parsed,
      cli: {
        ...defaultConfig.cli,
        ...(parsed.cli || {})
      },
      codex: {
        ...defaultConfig.codex,
        ...(parsed.codex || {})
      }
    };
  } catch (err) {
    return {
      ...defaultConfig,
      _configError: `配置文件解析失败: ${err.message}`
    };
  }
}

function resolveRuntimeDataDir(rootDir, config) {
  return path.resolve(rootDir, (config && config.dataDir) || ".data");
}

function resolveCodexRoot(rootDir, config, env = process.env) {
  const fromEnv = String(env.CODEX_HOME || "").trim();
  if (fromEnv) return path.resolve(fromEnv);

  const fromConfig = String((((config || {}).codex || {}).root) || "").trim();
  if (fromConfig) {
    return path.isAbsolute(fromConfig)
      ? path.resolve(fromConfig)
      : path.resolve(rootDir, fromConfig);
  }

  return path.join(os.homedir(), ".codex");
}

function getProjectMeta(rootDir) {
  const pkgPath = path.join(rootDir, "package.json");
  const fallback = {
    name: "codex-focus-ui",
    version: "0.0.0"
  };

  if (!fs.existsSync(pkgPath)) return fallback;

  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    return {
      name: parsed.name || fallback.name,
      version: parsed.version || fallback.version
    };
  } catch {
    return fallback;
  }
}

module.exports = {
  loadProjectConfig,
  getProjectMeta,
  resolveRuntimeDataDir,
  resolveCodexRoot
};
