var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/debug.js
var require_debug = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/debug.js"(exports, module) {
    "use strict";
    var debug = typeof process === "object" && process.env && process.env.NODE_DEBUG && /\bsemver\b/i.test(process.env.NODE_DEBUG) ? (...args) => console.error("SEMVER", ...args) : () => {
    };
    module.exports = debug;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/constants.js
var require_constants = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/constants.js"(exports, module) {
    "use strict";
    var SEMVER_SPEC_VERSION = "2.0.0";
    var MAX_LENGTH = 256;
    var MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER || /* istanbul ignore next */
    9007199254740991;
    var MAX_SAFE_COMPONENT_LENGTH = 16;
    var MAX_SAFE_BUILD_LENGTH = MAX_LENGTH - 6;
    var RELEASE_TYPES = [
      "major",
      "premajor",
      "minor",
      "preminor",
      "patch",
      "prepatch",
      "prerelease"
    ];
    module.exports = {
      MAX_LENGTH,
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_SAFE_INTEGER,
      RELEASE_TYPES,
      SEMVER_SPEC_VERSION,
      FLAG_INCLUDE_PRERELEASE: 1,
      FLAG_LOOSE: 2
    };
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/re.js
var require_re = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/re.js"(exports, module) {
    "use strict";
    var {
      MAX_SAFE_COMPONENT_LENGTH,
      MAX_SAFE_BUILD_LENGTH,
      MAX_LENGTH
    } = require_constants();
    var debug = require_debug();
    exports = module.exports = {};
    var re = exports.re = [];
    var safeRe = exports.safeRe = [];
    var src = exports.src = [];
    var safeSrc = exports.safeSrc = [];
    var t = exports.t = {};
    var R = 0;
    var LETTERDASHNUMBER = "[a-zA-Z0-9-]";
    var safeRegexReplacements = [
      ["\\s", 1],
      ["\\d", MAX_LENGTH],
      [LETTERDASHNUMBER, MAX_SAFE_BUILD_LENGTH]
    ];
    var makeSafeRegex = (value) => {
      for (const [token, max] of safeRegexReplacements) {
        value = value.split(`${token}*`).join(`${token}{0,${max}}`).split(`${token}+`).join(`${token}{1,${max}}`);
      }
      return value;
    };
    var createToken = (name, value, isGlobal) => {
      const safe = makeSafeRegex(value);
      const index = R++;
      debug(name, index, value);
      t[name] = index;
      src[index] = value;
      safeSrc[index] = safe;
      re[index] = new RegExp(value, isGlobal ? "g" : void 0);
      safeRe[index] = new RegExp(safe, isGlobal ? "g" : void 0);
    };
    createToken("NUMERICIDENTIFIER", "0|[1-9]\\d*");
    createToken("NUMERICIDENTIFIERLOOSE", "\\d+");
    createToken("NONNUMERICIDENTIFIER", `\\d*[a-zA-Z-]${LETTERDASHNUMBER}*`);
    createToken("MAINVERSION", `(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})\\.(${src[t.NUMERICIDENTIFIER]})`);
    createToken("MAINVERSIONLOOSE", `(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})\\.(${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASEIDENTIFIER", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIER]})`);
    createToken("PRERELEASEIDENTIFIERLOOSE", `(?:${src[t.NONNUMERICIDENTIFIER]}|${src[t.NUMERICIDENTIFIERLOOSE]})`);
    createToken("PRERELEASE", `(?:-(${src[t.PRERELEASEIDENTIFIER]}(?:\\.${src[t.PRERELEASEIDENTIFIER]})*))`);
    createToken("PRERELEASELOOSE", `(?:-?(${src[t.PRERELEASEIDENTIFIERLOOSE]}(?:\\.${src[t.PRERELEASEIDENTIFIERLOOSE]})*))`);
    createToken("BUILDIDENTIFIER", `${LETTERDASHNUMBER}+`);
    createToken("BUILD", `(?:\\+(${src[t.BUILDIDENTIFIER]}(?:\\.${src[t.BUILDIDENTIFIER]})*))`);
    createToken("FULLPLAIN", `v?${src[t.MAINVERSION]}${src[t.PRERELEASE]}?${src[t.BUILD]}?`);
    createToken("FULL", `^${src[t.FULLPLAIN]}$`);
    createToken("LOOSEPLAIN", `[v=\\s]*${src[t.MAINVERSIONLOOSE]}${src[t.PRERELEASELOOSE]}?${src[t.BUILD]}?`);
    createToken("LOOSE", `^${src[t.LOOSEPLAIN]}$`);
    createToken("GTLT", "((?:<|>)?=?)");
    createToken("XRANGEIDENTIFIERLOOSE", `${src[t.NUMERICIDENTIFIERLOOSE]}|x|X|\\*`);
    createToken("XRANGEIDENTIFIER", `${src[t.NUMERICIDENTIFIER]}|x|X|\\*`);
    createToken("XRANGEPLAIN", `[v=\\s]*(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:\\.(${src[t.XRANGEIDENTIFIER]})(?:${src[t.PRERELEASE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGEPLAINLOOSE", `[v=\\s]*(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:\\.(${src[t.XRANGEIDENTIFIERLOOSE]})(?:${src[t.PRERELEASELOOSE]})?${src[t.BUILD]}?)?)?`);
    createToken("XRANGE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAIN]}$`);
    createToken("XRANGELOOSE", `^${src[t.GTLT]}\\s*${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COERCEPLAIN", `${"(^|[^\\d])(\\d{1,"}${MAX_SAFE_COMPONENT_LENGTH}})(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?(?:\\.(\\d{1,${MAX_SAFE_COMPONENT_LENGTH}}))?`);
    createToken("COERCE", `${src[t.COERCEPLAIN]}(?:$|[^\\d])`);
    createToken("COERCEFULL", src[t.COERCEPLAIN] + `(?:${src[t.PRERELEASE]})?(?:${src[t.BUILD]})?(?:$|[^\\d])`);
    createToken("COERCERTL", src[t.COERCE], true);
    createToken("COERCERTLFULL", src[t.COERCEFULL], true);
    createToken("LONETILDE", "(?:~>?)");
    createToken("TILDETRIM", `(\\s*)${src[t.LONETILDE]}\\s+`, true);
    exports.tildeTrimReplace = "$1~";
    createToken("TILDE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAIN]}$`);
    createToken("TILDELOOSE", `^${src[t.LONETILDE]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("LONECARET", "(?:\\^)");
    createToken("CARETTRIM", `(\\s*)${src[t.LONECARET]}\\s+`, true);
    exports.caretTrimReplace = "$1^";
    createToken("CARET", `^${src[t.LONECARET]}${src[t.XRANGEPLAIN]}$`);
    createToken("CARETLOOSE", `^${src[t.LONECARET]}${src[t.XRANGEPLAINLOOSE]}$`);
    createToken("COMPARATORLOOSE", `^${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]})$|^$`);
    createToken("COMPARATOR", `^${src[t.GTLT]}\\s*(${src[t.FULLPLAIN]})$|^$`);
    createToken("COMPARATORTRIM", `(\\s*)${src[t.GTLT]}\\s*(${src[t.LOOSEPLAIN]}|${src[t.XRANGEPLAIN]})`, true);
    exports.comparatorTrimReplace = "$1$2$3";
    createToken("HYPHENRANGE", `^\\s*(${src[t.XRANGEPLAIN]})\\s+-\\s+(${src[t.XRANGEPLAIN]})\\s*$`);
    createToken("HYPHENRANGELOOSE", `^\\s*(${src[t.XRANGEPLAINLOOSE]})\\s+-\\s+(${src[t.XRANGEPLAINLOOSE]})\\s*$`);
    createToken("STAR", "(<|>)?=?\\s*\\*");
    createToken("GTE0", "^\\s*>=\\s*0\\.0\\.0\\s*$");
    createToken("GTE0PRE", "^\\s*>=\\s*0\\.0\\.0-0\\s*$");
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/parse-options.js
var require_parse_options = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/parse-options.js"(exports, module) {
    "use strict";
    var looseOption = Object.freeze({ loose: true });
    var emptyOpts = Object.freeze({});
    var parseOptions = (options) => {
      if (!options) {
        return emptyOpts;
      }
      if (typeof options !== "object") {
        return looseOption;
      }
      return options;
    };
    module.exports = parseOptions;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/identifiers.js
var require_identifiers = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/internal/identifiers.js"(exports, module) {
    "use strict";
    var numeric = /^[0-9]+$/;
    var compareIdentifiers = (a2, b) => {
      if (typeof a2 === "number" && typeof b === "number") {
        return a2 === b ? 0 : a2 < b ? -1 : 1;
      }
      const anum = numeric.test(a2);
      const bnum = numeric.test(b);
      if (anum && bnum) {
        a2 = +a2;
        b = +b;
      }
      return a2 === b ? 0 : anum && !bnum ? -1 : bnum && !anum ? 1 : a2 < b ? -1 : 1;
    };
    var rcompareIdentifiers = (a2, b) => compareIdentifiers(b, a2);
    module.exports = {
      compareIdentifiers,
      rcompareIdentifiers
    };
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/semver.js
var require_semver = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/classes/semver.js"(exports, module) {
    "use strict";
    var debug = require_debug();
    var { MAX_LENGTH, MAX_SAFE_INTEGER } = require_constants();
    var { safeRe: re, t } = require_re();
    var parseOptions = require_parse_options();
    var { compareIdentifiers } = require_identifiers();
    var isPrereleaseIdentifier = (prerelease, identifier) => {
      const identifiers = identifier.split(".");
      if (identifiers.length > prerelease.length) {
        return false;
      }
      for (let i2 = 0; i2 < identifiers.length; i2++) {
        if (compareIdentifiers(prerelease[i2], identifiers[i2]) !== 0) {
          return false;
        }
      }
      return true;
    };
    var SemVer = class _SemVer {
      constructor(version, options) {
        options = parseOptions(options);
        if (version instanceof _SemVer) {
          if (version.loose === !!options.loose && version.includePrerelease === !!options.includePrerelease) {
            return version;
          } else {
            version = version.version;
          }
        } else if (typeof version !== "string") {
          throw new TypeError(`Invalid version. Must be a string. Got type "${typeof version}".`);
        }
        if (version.length > MAX_LENGTH) {
          throw new TypeError(
            `version is longer than ${MAX_LENGTH} characters`
          );
        }
        debug("SemVer", version, options);
        this.options = options;
        this.loose = !!options.loose;
        this.includePrerelease = !!options.includePrerelease;
        const m = version.trim().match(options.loose ? re[t.LOOSE] : re[t.FULL]);
        if (!m) {
          throw new TypeError(`Invalid Version: ${version}`);
        }
        this.raw = version;
        this.major = +m[1];
        this.minor = +m[2];
        this.patch = +m[3];
        if (this.major > MAX_SAFE_INTEGER || this.major < 0) {
          throw new TypeError("Invalid major version");
        }
        if (this.minor > MAX_SAFE_INTEGER || this.minor < 0) {
          throw new TypeError("Invalid minor version");
        }
        if (this.patch > MAX_SAFE_INTEGER || this.patch < 0) {
          throw new TypeError("Invalid patch version");
        }
        if (!m[4]) {
          this.prerelease = [];
        } else {
          this.prerelease = m[4].split(".").map((id) => {
            if (/^[0-9]+$/.test(id)) {
              const num = +id;
              if (num >= 0 && num < MAX_SAFE_INTEGER) {
                return num;
              }
            }
            return id;
          });
        }
        this.build = m[5] ? m[5].split(".") : [];
        this.format();
      }
      format() {
        this.version = `${this.major}.${this.minor}.${this.patch}`;
        if (this.prerelease.length) {
          this.version += `-${this.prerelease.join(".")}`;
        }
        return this.version;
      }
      toString() {
        return this.version;
      }
      compare(other) {
        debug("SemVer.compare", this.version, this.options, other);
        if (!(other instanceof _SemVer)) {
          if (typeof other === "string" && other === this.version) {
            return 0;
          }
          other = new _SemVer(other, this.options);
        }
        if (other.version === this.version) {
          return 0;
        }
        return this.compareMain(other) || this.comparePre(other);
      }
      compareMain(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.major < other.major) {
          return -1;
        }
        if (this.major > other.major) {
          return 1;
        }
        if (this.minor < other.minor) {
          return -1;
        }
        if (this.minor > other.minor) {
          return 1;
        }
        if (this.patch < other.patch) {
          return -1;
        }
        if (this.patch > other.patch) {
          return 1;
        }
        return 0;
      }
      comparePre(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        if (this.prerelease.length && !other.prerelease.length) {
          return -1;
        } else if (!this.prerelease.length && other.prerelease.length) {
          return 1;
        } else if (!this.prerelease.length && !other.prerelease.length) {
          return 0;
        }
        let i2 = 0;
        do {
          const a2 = this.prerelease[i2];
          const b = other.prerelease[i2];
          debug("prerelease compare", i2, a2, b);
          if (a2 === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a2 === void 0) {
            return -1;
          } else if (a2 === b) {
            continue;
          } else {
            return compareIdentifiers(a2, b);
          }
        } while (++i2);
      }
      compareBuild(other) {
        if (!(other instanceof _SemVer)) {
          other = new _SemVer(other, this.options);
        }
        let i2 = 0;
        do {
          const a2 = this.build[i2];
          const b = other.build[i2];
          debug("build compare", i2, a2, b);
          if (a2 === void 0 && b === void 0) {
            return 0;
          } else if (b === void 0) {
            return 1;
          } else if (a2 === void 0) {
            return -1;
          } else if (a2 === b) {
            continue;
          } else {
            return compareIdentifiers(a2, b);
          }
        } while (++i2);
      }
      // preminor will bump the version up to the next minor release, and immediately
      // down to pre-release. premajor and prepatch work the same way.
      inc(release, identifier, identifierBase) {
        if (release.startsWith("pre")) {
          if (!identifier && identifierBase === false) {
            throw new Error("invalid increment argument: identifier is empty");
          }
          if (identifier) {
            const match = `-${identifier}`.match(this.options.loose ? re[t.PRERELEASELOOSE] : re[t.PRERELEASE]);
            if (!match || match[1] !== identifier) {
              throw new Error(`invalid identifier: ${identifier}`);
            }
          }
        }
        switch (release) {
          case "premajor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor = 0;
            this.major++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "preminor":
            this.prerelease.length = 0;
            this.patch = 0;
            this.minor++;
            this.inc("pre", identifier, identifierBase);
            break;
          case "prepatch":
            this.prerelease.length = 0;
            this.inc("patch", identifier, identifierBase);
            this.inc("pre", identifier, identifierBase);
            break;
          // If the input is a non-prerelease version, this acts the same as
          // prepatch.
          case "prerelease":
            if (this.prerelease.length === 0) {
              this.inc("patch", identifier, identifierBase);
            }
            this.inc("pre", identifier, identifierBase);
            break;
          case "release":
            if (this.prerelease.length === 0) {
              throw new Error(`version ${this.raw} is not a prerelease`);
            }
            this.prerelease.length = 0;
            break;
          case "major":
            if (this.minor !== 0 || this.patch !== 0 || this.prerelease.length === 0) {
              this.major++;
            }
            this.minor = 0;
            this.patch = 0;
            this.prerelease = [];
            break;
          case "minor":
            if (this.patch !== 0 || this.prerelease.length === 0) {
              this.minor++;
            }
            this.patch = 0;
            this.prerelease = [];
            break;
          case "patch":
            if (this.prerelease.length === 0) {
              this.patch++;
            }
            this.prerelease = [];
            break;
          // This probably shouldn't be used publicly.
          // 1.0.0 'pre' would become 1.0.0-0 which is the wrong direction.
          case "pre": {
            const base = Number(identifierBase) ? 1 : 0;
            if (this.prerelease.length === 0) {
              this.prerelease = [base];
            } else {
              let i2 = this.prerelease.length;
              while (--i2 >= 0) {
                if (typeof this.prerelease[i2] === "number") {
                  this.prerelease[i2]++;
                  i2 = -2;
                }
              }
              if (i2 === -1) {
                if (identifier === this.prerelease.join(".") && identifierBase === false) {
                  throw new Error("invalid increment argument: identifier already exists");
                }
                this.prerelease.push(base);
              }
            }
            if (identifier) {
              let prerelease = [identifier, base];
              if (identifierBase === false) {
                prerelease = [identifier];
              }
              if (isPrereleaseIdentifier(this.prerelease, identifier)) {
                const prereleaseBase = this.prerelease[identifier.split(".").length];
                if (isNaN(prereleaseBase)) {
                  this.prerelease = prerelease;
                }
              } else {
                this.prerelease = prerelease;
              }
            }
            break;
          }
          default:
            throw new Error(`invalid increment argument: ${release}`);
        }
        this.raw = this.format();
        if (this.build.length) {
          this.raw += `+${this.build.join(".")}`;
        }
        return this;
      }
    };
    module.exports = SemVer;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare.js
var require_compare = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/compare.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var compare = (a2, b, loose) => new SemVer(a2, loose).compare(new SemVer(b, loose));
    module.exports = compare;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/parse.js
var require_parse = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/parse.js"(exports, module) {
    "use strict";
    var SemVer = require_semver();
    var parse = (version, options, throwErrors = false) => {
      if (version instanceof SemVer) {
        return version;
      }
      try {
        return new SemVer(version, options);
      } catch (er) {
        if (!throwErrors) {
          return null;
        }
        throw er;
      }
    };
    module.exports = parse;
  }
});

// ../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/valid.js
var require_valid = __commonJS({
  "../../node_modules/.pnpm/semver@7.8.5/node_modules/semver/functions/valid.js"(exports, module) {
    "use strict";
    var parse = require_parse();
    var valid = (version, options) => {
      const v = parse(version, options);
      return v ? v.version : null;
    };
    module.exports = valid;
  }
});

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
import { z as z2 } from "zod";

// ../provider-bridge-protocol/src/bridge-kit/tool-arg-schemas.ts
import { z } from "zod";
var bashArgsSchema = z.object({
  command: z.string().optional(),
  cwd: z.string().optional()
}).passthrough();
var textBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string()
});

// ../provider-bridge-protocol/src/bridge-kit/provider-visibility-helpers.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getRecordProperty(value, key) {
  const next = value[key];
  return isRecord(next) ? next : null;
}
function getStringProperty(value, key) {
  const next = value[key];
  return typeof next === "string" ? next : void 0;
}
function getRawSdkMessage(event) {
  if (event.method !== "sdk/message") {
    return null;
  }
  if (!isRecord(event.params)) {
    return null;
  }
  const message = event.params["message"];
  return isRecord(message) ? message : null;
}

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
var contentWrapperSchema = z2.object({
  content: z2.array(z2.unknown())
}).passthrough();
var shellEnvironmentVariableKeySchema = z2.string().regex(/^[A-Z_][A-Z0-9_]*$/i);
function toOptionalString(value) {
  return typeof value === "string" ? value : void 0;
}
function toOptionalRecord(value) {
  return isRecord(value) ? value : void 0;
}
function buildShellEnvOverrides(envVars) {
  const overrides = {};
  for (const [key, value] of Object.entries(envVars ?? {})) {
    if (!shellEnvironmentVariableKeySchema.safeParse(key).success) {
      continue;
    }
    overrides[key] = value;
  }
  return overrides;
}
function toNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function normalizeProviderCommandOutput(args) {
  const trimmedText = args.text.trim();
  if (args.emptyPlaceholders.some((placeholder) => placeholder === trimmedText)) {
    return void 0;
  }
  return args.text.length > 0 ? args.text : void 0;
}
function extractResultText(content) {
  if (content === null || content === void 0) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") {
    return JSON.stringify(content);
  }
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const wrapper = contentWrapperSchema.safeParse(content);
    if (wrapper.success) {
      return extractResultText(wrapper.data.content);
    }
    return JSON.stringify(content);
  }
  if (!Array.isArray(content)) return "";
  const toolReferenceSummary = describeToolReferenceBlocks(content);
  if (toolReferenceSummary) {
    return toolReferenceSummary;
  }
  const chunks = [];
  for (const block of content) {
    const parsed = textBlockSchema.safeParse(block);
    if (parsed.success) {
      chunks.push(parsed.data.text);
      continue;
    }
    const fallback = describeResultContentBlock(block);
    if (fallback) {
      chunks.push(fallback);
    }
  }
  return chunks.join("\n");
}
function describeToolReferenceBlocks(blocks) {
  const toolNames = [];
  for (const block of blocks) {
    if (!isRecord(block) || getStringProperty(block, "type") !== "tool_reference") {
      return null;
    }
    const toolName = getStringProperty(block, "tool_name");
    if (!toolName) {
      return null;
    }
    toolNames.push(toolName);
  }
  return toolNames.length > 0 ? `Matched tools: ${toolNames.join(", ")}` : null;
}
function describeResultContentBlock(block) {
  if (!isRecord(block)) {
    return null;
  }
  const type = getStringProperty(block, "type");
  if (!type) {
    return null;
  }
  const path9 = getStringProperty(block, "path");
  const toolName = getStringProperty(block, "tool_name");
  const url = getStringProperty(block, "url") ?? getStringProperty(block, "imageUrl");
  if (path9) {
    return `[${type}: ${path9}]`;
  }
  if (toolName) {
    return `[${type}: ${toolName}]`;
  }
  if (url) {
    return `[${type}: ${url}]`;
  }
  return `[${type}]`;
}
var ZERO_TOKEN_USAGE = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0
};
function addTokenUsage(total, last) {
  return {
    totalTokens: total.totalTokens + last.totalTokens,
    inputTokens: total.inputTokens + last.inputTokens,
    cachedInputTokens: total.cachedInputTokens + last.cachedInputTokens,
    ...total.cacheReadInputTokens === void 0 && last.cacheReadInputTokens === void 0 ? {} : {
      cacheReadInputTokens: (total.cacheReadInputTokens ?? 0) + (last.cacheReadInputTokens ?? 0)
    },
    ...total.cacheWriteInputTokens === void 0 && last.cacheWriteInputTokens === void 0 ? {} : {
      cacheWriteInputTokens: (total.cacheWriteInputTokens ?? 0) + (last.cacheWriteInputTokens ?? 0)
    },
    outputTokens: total.outputTokens + last.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens + last.reasoningOutputTokens
  };
}

// ../provider-bridge-protocol/src/bridge-kit/bounded-line-reader.ts
import { StringDecoder } from "node:string_decoder";
var MAX_JSON_RPC_LINE_BYTES = 64 * 1024 * 1024;
function readBoundedLines(args) {
  const maxLineBytes = args.maxLineBytes ?? MAX_JSON_RPC_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  let discardedBytes = 0;
  args.input.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (; ; ) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex === -1) {
        break;
      }
      if (discarding) {
        discarding = false;
        args.onOverflow(discardedBytes);
        discardedBytes = 0;
      } else {
        emit(pending + text.slice(start, newlineIndex));
      }
      pending = "";
      start = newlineIndex + 1;
    }
    const tail = text.slice(start);
    if (discarding) {
      discardedBytes += Buffer.byteLength(tail);
      return;
    }
    pending += tail;
    if (Buffer.byteLength(pending) > maxLineBytes) {
      discarding = true;
      discardedBytes = Buffer.byteLength(pending);
      pending = "";
    }
  });
  args.input.on("end", () => {
    if (!discarding && pending.length > 0) {
      emit(pending);
    }
    pending = "";
    args.onClose?.();
  });
  function emit(line) {
    args.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

// ../provider-bridge-protocol/src/bridge-kit/bridge-harness.ts
var BridgeRecoveryError = class extends Error {
  code;
  recovery;
  constructor(args) {
    super(
      args.message,
      args.cause === void 0 ? void 0 : { cause: args.cause }
    );
    this.name = "BridgeRecoveryError";
    this.code = args.code;
    this.recovery = args.recovery;
  }
};
function createBridgeIo({
  write = (line) => process.stdout.write(line)
} = {}) {
  const send = (message) => {
    write(`${JSON.stringify(message)}
`);
  };
  return {
    send,
    sendError: (id, code, message, data) => {
      send({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...data === void 0 ? {} : { data } }
      });
    },
    sendResult: (id, result) => {
      send({ jsonrpc: "2.0", id, result });
    }
  };
}
function createBridgeLineHandler(args) {
  return (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    args.handleParsedMessage(parsed);
  };
}
function runBridgeRequest(args) {
  void args.handleRequest(args.request).catch((error) => {
    if (error instanceof BridgeRecoveryError) {
      args.sendError(args.request.id, error.code, error.message, {
        recovery: error.recovery
      });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    args.sendError(args.request.id, -32e3, message);
  });
}

// ../provider-bridge-protocol/src/bridge-kit/bridge-recorder.ts
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { StringDecoder as StringDecoder2 } from "node:string_decoder";
var PROVIDER_BRIDGE_RECORD_DIR_ENV = "BB_PROVIDER_BRIDGE_RECORD_DIR";
var BRIDGE_RECORDING_PROCESS_SCOPE = "_process";
function bridgeRecordingFileName(direction) {
  return `${direction}.ndjson`;
}
function createRecordingLineSplitter(onLine, maxLineBytes = MAX_JSON_RPC_LINE_BYTES) {
  const decoder = new StringDecoder2("utf8");
  let pending = "";
  let discarding = false;
  return {
    push(chunk) {
      const text = typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk));
      let start = 0;
      for (; ; ) {
        const newlineIndex = text.indexOf("\n", start);
        if (newlineIndex === -1) {
          break;
        }
        if (!discarding) {
          const line = pending + text.slice(start, newlineIndex);
          onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
        }
        discarding = false;
        pending = "";
        start = newlineIndex + 1;
      }
      if (discarding) {
        return;
      }
      pending += text.slice(start);
      if (Buffer.byteLength(pending) > maxLineBytes) {
        discarding = true;
        pending = "";
      }
    }
  };
}
function safeScopeSegment(threadId) {
  if (threadId === null || threadId === "") {
    return BRIDGE_RECORDING_PROCESS_SCOPE;
  }
  const sanitized = threadId.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return sanitized === "" || sanitized.startsWith("_") ? `t-${sanitized}` : sanitized;
}
function parseRuntimeLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed;
  const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : void 0;
  const method = typeof record.method === "string" ? record.method : void 0;
  const params = record.params;
  const threadId = typeof params === "object" && params !== null && typeof params.threadId === "string" ? params.threadId : void 0;
  return { id, method, threadId };
}
function pendingKey(id) {
  return `${typeof id}:${String(id)}`;
}
function createBridgeRecorder(args) {
  const dir = resolve(args.dir);
  const fds = /* @__PURE__ */ new Map();
  const runtimeRequestThreads = /* @__PURE__ */ new Map();
  const bridgeRequestThreads = /* @__PURE__ */ new Map();
  const run = Date.now();
  let seq = 0;
  let closed = false;
  function fdFor(scope, direction) {
    const key = `${scope}\0${direction}`;
    const existing = fds.get(key);
    if (existing !== void 0) {
      return existing;
    }
    const scopeDir = join(dir, scope);
    mkdirSync(scopeDir, { recursive: true });
    const fd = openSync(
      join(scopeDir, bridgeRecordingFileName(direction)),
      "a"
    );
    fds.set(key, fd);
    return fd;
  }
  function record(recordArgs) {
    if (closed) {
      return;
    }
    seq += 1;
    const entry = {
      ts: Date.now(),
      run,
      seq,
      dir: recordArgs.direction,
      line: recordArgs.line
    };
    try {
      writeSync(
        fdFor(safeScopeSegment(recordArgs.threadId), recordArgs.direction),
        `${JSON.stringify(entry)}
`
      );
    } catch (error) {
      process.stderr.write(
        `provider bridge recorder: failed to append to ${dir}: ${error instanceof Error ? error.message : String(error)}
`
      );
    }
  }
  function recordRuntimeLine(direction, line) {
    const parsed = parseRuntimeLine(line);
    let threadId = parsed?.threadId ?? null;
    if (parsed !== null && parsed.id !== void 0) {
      const key = pendingKey(parsed.id);
      if (parsed.method !== void 0) {
        (direction === "runtime\u2192bridge" ? runtimeRequestThreads : bridgeRequestThreads).set(key, threadId);
      } else {
        const pending = direction === "runtime\u2192bridge" ? bridgeRequestThreads : runtimeRequestThreads;
        const owner = pending.get(key);
        if (owner !== void 0) {
          pending.delete(key);
          threadId = owner;
        }
      }
    }
    record({ direction, line, threadId });
  }
  function recordChildIo(child, scope) {
    const { stdin, stdout } = child;
    if (stdout) {
      const splitter = createRecordingLineSplitter(
        (line) => record({
          direction: "provider\u2192bridge",
          line,
          threadId: scope.threadId
        })
      );
      stdout.on("data", (chunk) => splitter.push(chunk));
    }
    if (stdin) {
      const splitter = createRecordingLineSplitter(
        (line) => record({
          direction: "bridge\u2192provider",
          line,
          threadId: scope.threadId
        })
      );
      const originalWrite = stdin.write.bind(stdin);
      stdin.write = ((chunk, ...rest) => {
        splitter.push(chunk);
        return originalWrite(
          chunk,
          ...rest
        );
      });
    }
  }
  return {
    record,
    recordRuntimeLine,
    recordChildIo,
    close() {
      closed = true;
      for (const fd of fds.values()) {
        try {
          closeSync(fd);
        } catch {
        }
      }
      fds.clear();
    }
  };
}
var RECORDER_GLOBAL_KEY = /* @__PURE__ */ Symbol.for("bb.providerBridgeRecorder");
function globalSlot() {
  const holder = globalThis;
  const existing = holder[RECORDER_GLOBAL_KEY];
  if (existing !== void 0) {
    return existing;
  }
  const slot = { recorder: null, resolved: false };
  holder[RECORDER_GLOBAL_KEY] = slot;
  return slot;
}
function getBridgeRecorder() {
  const slot = globalSlot();
  if (!slot.resolved) {
    slot.resolved = true;
    const dir = process.env[PROVIDER_BRIDGE_RECORD_DIR_ENV];
    if (dir !== void 0 && dir.trim() !== "") {
      slot.recorder = createBridgeRecorder({ dir: dir.trim() });
    }
  }
  return slot.recorder;
}
function experimental_isProviderBridgeRecording() {
  return getBridgeRecorder() !== null;
}
function experimental_recordProviderChildIo(child, scope) {
  getBridgeRecorder()?.recordChildIo(child, scope);
}

// ../provider-bridge-protocol/src/bridge-kit/bridge-socket-server.ts
var BRIDGE_SOCKET_ENV = "BB_BRIDGE_SOCKET";
var BRIDGE_REATTACH_TTL_MS = 30 * 60 * 1e3;
var BRIDGE_REPLAY_MEMORY_CAP_BYTES = 64 * 1024 * 1024;
var BRIDGE_REPLAY_HARD_CAP_BYTES = 1024 * 1024 * 1024;

// ../provider-bridge-protocol/src/bridge-kit/bridge-runtime-env.ts
function withoutBridgeRuntimeEnv(env) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  delete childEnv[PROVIDER_BRIDGE_RECORD_DIR_ENV];
  delete childEnv[BRIDGE_SOCKET_ENV];
  return childEnv;
}

// ../provider-bridge-protocol/src/bridge-kit/bridge-tool-calls.ts
import { z as z23 } from "zod";

// ../domain/src/context-snapshot.ts
import { z as z3 } from "zod";
var tokenCountSchema = z3.number().int().nonnegative();
var contextEntrySchema = z3.object({
  id: z3.string().min(1),
  label: z3.string().min(1),
  tokens: tokenCountSchema
});
var contextCategorySchema = z3.object({
  id: z3.string().min(1),
  label: z3.string().min(1),
  kind: z3.enum(["used", "free", "reserved", "deferred"]),
  tokens: tokenCountSchema,
  entries: z3.array(contextEntrySchema)
});
var contextSnapshotSchema = z3.object({
  capturedAt: z3.iso.datetime(),
  providerSessionId: z3.string().min(1),
  providerTurnId: z3.string().min(1).nullable(),
  model: z3.string().min(1),
  usedTokens: tokenCountSchema,
  contextWindowTokens: z3.number().int().positive(),
  autoCompactAtTokens: z3.number().int().positive().nullable(),
  estimated: z3.boolean(),
  categories: z3.array(contextCategorySchema)
});

// ../domain/src/acp-cli.ts
import { z as z6 } from "zod";

// ../domain/src/provider-skill-roots.ts
function isAbsoluteProviderSkillRootPath(value) {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  const drive = /^[a-zA-Z]:\//u.exec(normalized);
  const rest = drive ? normalized.slice(drive[0].length) : normalized.slice(1);
  if (!drive && !normalized.startsWith("/")) {
    return false;
  }
  return rest.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function isRelativeProviderSkillRootPath(value) {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[a-zA-Z]:\//u.test(normalized) && normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

// ../domain/src/shared-types.ts
import { z as z5 } from "zod";

// ../domain/src/json-value.ts
import { z as z4 } from "zod";
var jsonValueSchema = z4.lazy(
  () => z4.union([
    z4.string(),
    z4.number(),
    z4.boolean(),
    z4.null(),
    z4.array(jsonValueSchema),
    z4.record(z4.string(), jsonValueSchema)
  ])
);
var jsonObjectSchema = z4.record(
  z4.string(),
  jsonValueSchema
);

// ../domain/src/shared-types.ts
var reasoningLevelValues = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra"
];
var reasoningLevelSchema = z5.string().min(1);
function isStandardReasoningLevel(level) {
  return reasoningLevelValues.includes(level);
}
var serviceTierSchema = z5.string().min(1);
var instructionModeValues = ["append", "replace"];
var instructionModeSchema = z5.enum(instructionModeValues);
var permissionModeValues = ["accept-edits", "auto", "full"];
var permissionModeSchema = z5.enum(permissionModeValues);
var permissionModeInputSchema = z5.union([permissionModeSchema, z5.literal("workspace-write")]).transform(
  (permissionMode) => permissionMode === "workspace-write" ? "accept-edits" : permissionMode
);
var legacyRecordedPermissionModeValues = [
  "workspace-write",
  "readonly"
];
var recordedPermissionModeSchema = z5.enum([
  ...permissionModeValues,
  ...legacyRecordedPermissionModeValues
]);
var permissionEscalationValues = ["ask", "deny"];
var permissionEscalationSchema = z5.enum(permissionEscalationValues);
var promptInputVisibilityValues = ["agent-only"];
var promptInputVisibilitySchema = z5.enum(promptInputVisibilityValues);
var promptInputVisibilityFields = {
  visibility: promptInputVisibilitySchema.optional()
};
var promptMentionPathSourceValues = ["workspace", "thread-storage"];
var promptMentionPathSourceSchema = z5.enum(promptMentionPathSourceValues);
var promptMentionPathEntryKindValues = ["file", "directory"];
var promptMentionPathEntryKindSchema = z5.enum(
  promptMentionPathEntryKindValues
);
var promptMentionCommandTriggerValues = ["/", "$"];
var promptMentionCommandTriggerSchema = z5.enum(
  promptMentionCommandTriggerValues
);
var promptMentionCommandSourceValues = ["skill", "command"];
var promptMentionCommandSourceSchema = z5.enum(
  promptMentionCommandSourceValues
);
var promptMentionCommandOriginValues = [
  "builtin",
  "project",
  "user"
];
var promptMentionCommandOriginSchema = z5.enum(
  promptMentionCommandOriginValues
);
var canonicalPromptMentionResourceSchema = z5.discriminatedUnion("kind", [
  z5.object({
    kind: z5.literal("thread"),
    threadId: z5.string(),
    projectId: z5.string().optional(),
    label: z5.string()
  }),
  z5.object({
    kind: z5.literal("project"),
    projectId: z5.string(),
    label: z5.string()
  }),
  z5.object({
    kind: z5.literal("section"),
    sectionId: z5.string(),
    label: z5.string()
  }),
  z5.object({
    kind: z5.literal("path"),
    source: promptMentionPathSourceSchema,
    entryKind: promptMentionPathEntryKindSchema,
    path: z5.string(),
    label: z5.string()
  }),
  z5.object({
    kind: z5.literal("command"),
    trigger: promptMentionCommandTriggerSchema,
    name: z5.string(),
    source: promptMentionCommandSourceSchema,
    origin: promptMentionCommandOriginSchema,
    label: z5.string(),
    argumentHint: z5.string().nullable()
  }),
  z5.object({
    kind: z5.literal("plugin"),
    pluginId: z5.string(),
    icon: z5.string().nullable().optional(),
    itemId: z5.string(),
    label: z5.string()
  }),
  z5.object({
    kind: z5.literal("attachment"),
    path: z5.string(),
    label: z5.string()
  })
]);
function normalizeLegacyPromptMentionResource(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value;
  if (record.kind !== "folder" || typeof record.folderId !== "string") {
    return value;
  }
  const { folderId, ...rest } = record;
  return { ...rest, kind: "section", sectionId: folderId };
}
var promptMentionResourceSchema = z5.preprocess(
  normalizeLegacyPromptMentionResource,
  canonicalPromptMentionResourceSchema
);
var promptTextMentionSchema = z5.object({
  start: z5.number().int().nonnegative(),
  end: z5.number().int().nonnegative(),
  resource: promptMentionResourceSchema
});
var promptInputSchema = z5.discriminatedUnion("type", [
  z5.object({
    type: z5.literal("text"),
    text: z5.string(),
    mentions: z5.array(promptTextMentionSchema).default([]),
    ...promptInputVisibilityFields
  }),
  z5.object({
    type: z5.literal("image"),
    url: z5.string().url(),
    ...promptInputVisibilityFields
  }),
  z5.object({
    type: z5.literal("localImage"),
    path: z5.string(),
    sourceProjectId: z5.string().min(1).optional(),
    hostId: z5.string().min(1).optional(),
    ...promptInputVisibilityFields
  }),
  z5.object({
    type: z5.literal("localFile"),
    path: z5.string(),
    sourceProjectId: z5.string().min(1).optional(),
    hostId: z5.string().min(1).optional(),
    name: z5.string().optional(),
    sizeBytes: z5.number().int().nonnegative().optional(),
    mimeType: z5.string().optional(),
    ...promptInputVisibilityFields
  })
]);
function isSelectedPromptCommandMention(mention, selector) {
  return mention.resource.kind === "command" && mention.resource.trigger === selector.trigger && mention.resource.name === selector.name;
}
function isStandaloneBuiltinCommand(input, name) {
  const selector = { trigger: "/", name };
  const selected = input.flatMap(
    (item) => item.type === "text" ? item.mentions.filter(
      (mention2) => isSelectedPromptCommandMention(mention2, selector)
    ).map((mention2) => ({ mention: mention2, text: item.text })) : []
  );
  const standalone = selected[0];
  if (selected.length !== 1 || !standalone || input.some((item) => item.type !== "text")) {
    return false;
  }
  const { mention, text } = standalone;
  if (mention.resource.kind !== "command" || mention.resource.source !== "command" || mention.resource.origin !== "builtin" || text.slice(mention.start, mention.end) !== `/${name}`) {
    return false;
  }
  return removeCommandMentionsFromPromptInput(input, selector).every(
    (item) => item.type === "text" && item.text.trim() === ""
  );
}
function isStandaloneBuiltinCompactCommand(input) {
  return isStandaloneBuiltinCommand(input, "compact");
}
function commandRemovalRanges(input, selector) {
  return input.mentions.filter((mention) => isSelectedPromptCommandMention(mention, selector)).map((mention) => ({
    start: mention.start,
    end: input.text[mention.end] === " " && mention.end < input.text.length ? mention.end + 1 : mention.end
  })).sort((left, right) => left.start - right.start || left.end - right.end);
}
function removedBefore(ranges, position) {
  let removed = 0;
  for (const range of ranges) {
    if (range.end <= position) {
      removed += range.end - range.start;
    }
  }
  return removed;
}
function isInsideRemovalRange(ranges, mention) {
  return ranges.some(
    (range) => mention.start < range.end && mention.end > range.start
  );
}
function removeCommandMentionsFromTextInput(input, selector) {
  const ranges = commandRemovalRanges(input, selector);
  if (ranges.length === 0) {
    return input;
  }
  let text = "";
  let cursor = 0;
  for (const range of ranges) {
    text += input.text.slice(cursor, range.start);
    cursor = range.end;
  }
  text += input.text.slice(cursor);
  return {
    ...input,
    text,
    mentions: input.mentions.filter(
      (mention) => !isSelectedPromptCommandMention(mention, selector) && !isInsideRemovalRange(ranges, mention)
    ).map((mention) => {
      const start = mention.start - removedBefore(ranges, mention.start);
      const end = mention.end - removedBefore(ranges, mention.end);
      return { ...mention, start, end };
    })
  };
}
function removeCommandMentionsFromPromptInput(input, selector) {
  return input.map(
    (item) => item.type === "text" ? removeCommandMentionsFromTextInput(item, selector) : item
  );
}
var threadExecutionSourceSchema = z5.enum([
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start"
]);
var callerExecutionInputSourceValues = [
  "explicit",
  "client-preference"
];
var callerExecutionInputSourceSchema = z5.enum(
  callerExecutionInputSourceValues
);
var threadExecutionOptionsSchema = z5.object({
  model: z5.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  source: threadExecutionSourceSchema.optional(),
  seq: z5.number().int().optional()
});
var resolvedThreadExecutionOptionsSchema = threadExecutionOptionsSchema.extend({
  model: z5.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  source: threadExecutionSourceSchema
});
var recordedThreadExecutionOptionsSchema = resolvedThreadExecutionOptionsSchema.extend({
  permissionMode: recordedPermissionModeSchema
});
var threadExecutionReportSchema = z5.object({
  model: z5.string().min(1),
  reasoningLevel: reasoningLevelSchema.nullable(),
  permissionMode: permissionModeSchema.nullable(),
  serviceTier: serviceTierSchema.nullable()
});
var runtimePermissionScopeValues = ["workspace", "full"];
var runtimePermissionScopeSchema = z5.enum(runtimePermissionScopeValues);
var runtimePermissionPolicySchema = z5.discriminatedUnion(
  "permissionMode",
  [
    z5.object({
      permissionMode: z5.literal("accept-edits"),
      permissionScope: z5.literal("workspace"),
      approvalReviewer: z5.literal("user"),
      permissionEscalation: permissionEscalationSchema
    }),
    z5.object({
      permissionMode: z5.literal("auto"),
      permissionScope: z5.literal("workspace"),
      approvalReviewer: z5.literal("automatic"),
      permissionEscalation: permissionEscalationSchema
    }),
    z5.object({
      permissionMode: z5.literal("full"),
      permissionScope: z5.literal("full"),
      approvalReviewer: z5.null(),
      permissionEscalation: z5.null()
    })
  ]
);
var promptModeSchema = z5.literal("plan");
var sessionOptionValueSchema = z5.union([z5.string(), z5.boolean()]);
var sessionOptionSelectionsSchema = z5.record(
  z5.string().min(1),
  sessionOptionValueSchema
);
var runtimeThreadExecutionBaseOptionsSchema = z5.object({
  model: z5.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  providerOptions: jsonObjectSchema
});
var runtimeThreadExecutionOptionsSchema = runtimeThreadExecutionBaseOptionsSchema.and(runtimePermissionPolicySchema);
var projectExecutionDefaultsSchema = z5.object({
  providerId: z5.string().min(1),
  model: z5.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema
});

// ../domain/src/acp-cli.ts
var providerSkillRootPathSchema = z6.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Skill roots must be relative paths without dot segments"
);
var uniqueProviderSkillRootPathsSchema = z6.array(providerSkillRootPathSchema).superRefine((paths, context) => {
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: "custom",
      message: "Skill roots must not contain duplicates"
    });
  }
});
var providerNativeSkillRootsSchema = z6.object({
  user: uniqueProviderSkillRootPathsSchema.default([]),
  project: uniqueProviderSkillRootPathsSchema.default([])
}).strict();
var acpReasoningCliLevelValueOverridesSchema = z6.record(
  reasoningLevelSchema,
  z6.string().min(1)
);
var acpReasoningCliSchema = z6.object({
  flag: z6.string().min(1),
  supportedLevels: z6.array(reasoningLevelSchema).min(1),
  levelValues: acpReasoningCliLevelValueOverridesSchema.optional(),
  defaultLevel: reasoningLevelSchema.optional()
}).strict().superRefine((reasoningCli, context) => {
  const supportedLevels = new Set(reasoningCli.supportedLevels);
  if (supportedLevels.size !== reasoningCli.supportedLevels.length) {
    context.addIssue({
      code: "custom",
      message: "supportedLevels must not contain duplicates",
      path: ["supportedLevels"]
    });
  }
  if (reasoningCli.defaultLevel !== void 0 && !supportedLevels.has(reasoningCli.defaultLevel)) {
    context.addIssue({
      code: "custom",
      message: "defaultLevel must be one of supportedLevels",
      path: ["defaultLevel"]
    });
  }
});
var acpNativeReasoningSchema = z6.object({
  configId: z6.string().min(1),
  supportedLevels: z6.array(reasoningLevelSchema).min(1),
  levelValues: acpReasoningCliLevelValueOverridesSchema.optional(),
  defaultLevel: reasoningLevelSchema.optional()
}).strict().superRefine((nativeReasoning, context) => {
  const supportedLevels = new Set(nativeReasoning.supportedLevels);
  if (supportedLevels.size !== nativeReasoning.supportedLevels.length) {
    context.addIssue({
      code: "custom",
      message: "supportedLevels must not contain duplicates",
      path: ["supportedLevels"]
    });
  }
  if (nativeReasoning.defaultLevel !== void 0 && !supportedLevels.has(nativeReasoning.defaultLevel)) {
    context.addIssue({
      code: "custom",
      message: "defaultLevel must be one of supportedLevels",
      path: ["defaultLevel"]
    });
  }
});
var acpPermissionCliArgsSchema = z6.array(z6.string().min(1)).min(1);
var acpPermissionCliSchema = z6.object({
  full: acpPermissionCliArgsSchema.optional(),
  workspaceWrite: acpPermissionCliArgsSchema.optional(),
  readonly: acpPermissionCliArgsSchema.optional(),
  insertAfterArgs: z6.number().int().min(0).optional()
}).strict().superRefine((permissionCli, context) => {
  if (permissionCli.full === void 0 && permissionCli.workspaceWrite === void 0 && permissionCli.readonly === void 0) {
    context.addIssue({
      code: "custom",
      message: "permissionCli must configure at least one permission mode"
    });
  }
});

// ../domain/src/native-roots.ts
import { z as z7 } from "zod";
var PROVIDER_NATIVE_ROOTS_MAX = 32;
var PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}:$/u;
var nativeRootNamePrefixSchema = z7.string().refine(
  (value) => value === "" || PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN.test(value),
  "A root name prefix is a plugin-name-like token ending in ':'"
);
var nativeRootManifestPathSchema = z7.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "A manifest marker is a relative path without dot segments"
);
var relativeNativeRootPathSchema = z7.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Roots must be relative paths without dot segments"
);
var absoluteNativeRootPathSchema = z7.string().min(1).refine(
  isAbsoluteProviderSkillRootPath,
  "Absolute roots must be absolute paths without dot segments"
);
var providerNativeRootInputSchema = z7.union([
  z7.string().min(1),
  z7.object({
    path: z7.string().min(1),
    /** Skills nest in subdirectories (the agent scans recursively). */
    recursive: z7.boolean().optional(),
    /**
     * Scan the same relative directory in every ancestor of the workspace
     * up to the repository root (`project` roots only).
     */
    ancestors: z7.boolean().optional(),
    /**
     * Prepended to every name under the root, a vendor plugin's
     * `plugin-name:`; a prefixed root is listed as a plugin root.
     */
    namePrefix: nativeRootNamePrefixSchema.optional(),
    /**
     * A file, relative to a skill directory under this root, that marks the
     * directory as a vendor plugin rather than a skill (Claude's
     * `.claude-plugin/plugin.json`): bb skips such a directory. The plugin
     * that knows the vendor layout declares it; core names no vendor path.
     */
    skipIfManifest: nativeRootManifestPathSchema.optional()
  }).strict()
]);
var providerNativeRootsInputSchema = z7.object({
  user: z7.array(providerNativeRootInputSchema).optional(),
  project: z7.array(providerNativeRootInputSchema).optional()
}).strict();
var providerNativeRootSchema = z7.object({
  path: z7.string().min(1),
  recursive: z7.boolean(),
  ancestors: z7.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  /** Absent: every skill-shaped directory under the root is a skill. */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
function uniqueByPath(roots) {
  return new Set(roots.map((root) => root.path)).size === roots.length;
}
function nativeRootSideSchema(side) {
  return z7.array(
    providerNativeRootSchema.extend({ path: relativeNativeRootPathSchema }).superRefine((root, context) => {
      if (root.ancestors && side !== "project") {
        context.addIssue({
          code: "custom",
          message: "Only project roots may walk ancestors"
        });
      }
    })
  ).max(PROVIDER_NATIVE_ROOTS_MAX).refine(uniqueByPath, "Roots must not repeat a path");
}
var providerNativeRootsSchema = z7.object({
  user: nativeRootSideSchema("user"),
  project: nativeRootSideSchema("project")
}).strict();
var EMPTY_PROVIDER_NATIVE_ROOTS = Object.freeze({
  user: Object.freeze([]),
  project: Object.freeze([])
});
function normalizeProviderNativeRoot(entry) {
  if (typeof entry === "string") {
    return { path: entry, recursive: false, ancestors: false, namePrefix: "" };
  }
  return {
    path: entry.path,
    recursive: entry.recursive ?? false,
    ancestors: entry.ancestors ?? false,
    namePrefix: entry.namePrefix ?? "",
    ...entry.skipIfManifest === void 0 ? {} : { skipIfManifest: entry.skipIfManifest }
  };
}
function normalizeProviderNativeRoots(roots) {
  return {
    user: (roots?.user ?? []).map(normalizeProviderNativeRoot),
    project: (roots?.project ?? []).map(normalizeProviderNativeRoot)
  };
}
var providerResolvedNativeRootShapeSchema = z7.enum([
  "skills",
  "skill",
  "skill-file",
  "commands",
  "command-file"
]);
var resolvedNativeRootFieldsSchema = z7.object({
  path: absoluteNativeRootPathSchema,
  origin: z7.enum(["user", "project"]),
  recursive: z7.boolean(),
  /** Only with origin `project`, for a path inside the workspace. */
  ancestors: z7.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  shape: providerResolvedNativeRootShapeSchema,
  /**
   * `skill-file` only: the skill name when the file's frontmatter names
   * none. A vendor plugin's root SKILL.md takes the plugin's name; absent
   * means the parent directory's name.
   */
  fallbackName: z7.string().min(1).optional(),
  /**
   * `skills` only: a file, relative to a skill directory under this root,
   * that marks the directory as a vendor plugin rather than a skill; the
   * daemon skips such a directory (see the declared root's `skipIfManifest`).
   */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
var providerResolvedNativeRootSchema = resolvedNativeRootFieldsSchema.superRefine((root, context) => {
  if (root.skipIfManifest !== void 0 && root.shape !== "skills") {
    context.addIssue({
      code: "custom",
      message: "Only a skills root carries a manifest marker"
    });
  }
  if (root.ancestors && root.origin !== "project") {
    context.addIssue({
      code: "custom",
      message: "Only project roots may walk ancestors"
    });
  }
  if (root.fallbackName !== void 0 && root.shape !== "skill-file") {
    context.addIssue({
      code: "custom",
      message: "Only a skill-file root carries a fallback name"
    });
  }
});
var providerResolvedNativeRootInputSchema = resolvedNativeRootFieldsSchema.partial({
  recursive: true,
  ancestors: true,
  namePrefix: true,
  shape: true
});
var resolvedSkillShapes = /* @__PURE__ */ new Set([
  "skills",
  "skill",
  "skill-file"
]);
var resolvedCommandShapes = /* @__PURE__ */ new Set([
  "commands",
  "command-file"
]);
var PROVIDER_RESOLVED_NATIVE_ROOTS_MAX = 256;
var providerResolvedNativeRootsSchema = z7.object({
  skills: z7.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedSkillShapes.has(root.shape),
      "A skills root needs a skill shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX),
  commands: z7.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedCommandShapes.has(root.shape),
      "A commands root needs a command shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX)
}).strict();
var EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS = Object.freeze({
  skills: Object.freeze([]),
  commands: Object.freeze([])
});
var providerNativeRootSetSchema = z7.object({
  skills: providerNativeRootsSchema,
  commands: providerNativeRootsSchema,
  resolved: providerResolvedNativeRootsSchema
}).strict();

// ../domain/src/completed-turn-display.ts
import { z as z8 } from "zod";
var COMPLETED_TURN_DISPLAY_VALUES = ["collapse", "flat"];
var completedTurnDisplaySchema = z8.enum(COMPLETED_TURN_DISPLAY_VALUES);

// ../domain/src/background-task.ts
import { z as z9 } from "zod";
var LOCAL_WORKFLOW_TASK_TYPE = "local_workflow";
var LOCAL_BASH_TASK_TYPE = "local_bash";
var LOCAL_AGENT_TASK_TYPE = "local_agent";
var LOCAL_SUBAGENT_TASK_TYPE = "local_subagent";
function isBackgroundAgentTaskType(taskType) {
  return taskType === LOCAL_AGENT_TASK_TYPE || taskType === LOCAL_SUBAGENT_TASK_TYPE;
}
var backgroundTaskStatusValues = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "killed",
  "stopped"
];
var backgroundTaskStatusSchema = z9.enum(backgroundTaskStatusValues);
var workflowAgentStateValues = [
  "queued",
  "running",
  "done",
  "failed",
  "skipped"
];
var workflowAgentStateSchema = z9.enum(workflowAgentStateValues);
var workflowAgentSnapshotSchema = z9.object({
  index: z9.number().int().positive(),
  label: z9.string(),
  state: workflowAgentStateSchema,
  model: z9.string(),
  attempt: z9.number().int().positive(),
  cached: z9.boolean(),
  lastProgressAt: z9.number(),
  phaseIndex: z9.number().int().positive().optional(),
  phaseTitle: z9.string().optional(),
  agentType: z9.string().optional(),
  isolation: z9.string().optional(),
  queuedAt: z9.number().optional(),
  startedAt: z9.number().optional(),
  lastToolName: z9.string().optional(),
  lastToolSummary: z9.string().optional(),
  promptPreview: z9.string().optional(),
  resultPreview: z9.string().optional(),
  error: z9.string().optional(),
  tokens: z9.number().optional(),
  toolCalls: z9.number().optional(),
  durationMs: z9.number().optional()
});
var workflowPhaseSnapshotSchema = z9.object({
  index: z9.number().int().positive(),
  title: z9.string(),
  kind: z9.string().optional()
});
var workflowProgressSnapshotSchema = z9.object({
  phases: z9.array(workflowPhaseSnapshotSchema),
  agents: z9.array(workflowAgentSnapshotSchema)
});
var backgroundTaskUsageSchema = z9.object({
  totalTokens: z9.number(),
  toolUses: z9.number(),
  durationMs: z9.number()
});
function backgroundTaskItemStatus(taskStatus) {
  switch (taskStatus) {
    case "pending":
    case "running":
    case "paused":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
    case "killed":
      return "failed";
    case "stopped":
      return "interrupted";
  }
}
function isSettledBackgroundTaskStatus(taskStatus) {
  return backgroundTaskItemStatus(taskStatus) !== "pending";
}

// ../domain/src/provider-event.ts
import { z as z18 } from "zod";

// ../domain/src/thread-events.ts
import { z as z15 } from "zod";

// ../domain/src/pending-interactions.ts
import { z as z12 } from "zod";

// ../domain/src/plugin-interaction-limits.ts
var PLUGIN_INTERACTION_MAX_TITLE_LENGTH = 160;
var PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES = 64 * 1024;
var PLUGIN_INTERACTION_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1e3;
function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ../domain/src/item-presentation.ts
import { z as z10 } from "zod";
var THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH = 280;
var threadEventItemPresentationLabelSchema = z10.object({
  pending: z10.string().min(1),
  completed: z10.string().min(1)
});
var threadEventItemPresentationIconSchema = z10.object({
  glyph: z10.string().min(1)
});
var threadEventItemPresentationTintSchema = z10.object({
  light: z10.string().min(1),
  dark: z10.string().min(1)
});
var THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH = 80;
var threadEventItemPresentationBadgeSchema = z10.object({
  glyph: z10.string().min(1),
  label: z10.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  hint: z10.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  tone: z10.enum(["neutral", "destructive"])
});
var threadEventItemPresentationSchema = z10.object({
  label: threadEventItemPresentationLabelSchema,
  icon: threadEventItemPresentationIconSchema,
  title: z10.string().optional(),
  detail: z10.string().max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  suppress: z10.boolean().optional(),
  tint: threadEventItemPresentationTintSchema.optional(),
  badge: threadEventItemPresentationBadgeSchema.optional()
});

// ../domain/src/provider-extension-kind.ts
import { z as z11 } from "zod";
var EXTENSION_KIND_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/u;
function isExtensionKind(value) {
  return EXTENSION_KIND_PATTERN.test(value);
}
var extensionKindSchema = z11.string().refine(isExtensionKind, {
  message: 'extension kinds are "<pluginId>/<name>" (lowercase letters, digits, and "-")'
});

// ../domain/src/pending-interactions.ts
var pendingInteractionStatusSchema = z12.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted"
]);
var pendingInteractionCommandActionSchema = z12.discriminatedUnion(
  "type",
  [
    z12.object({
      type: z12.literal("read"),
      command: z12.string(),
      name: z12.string(),
      path: z12.string()
    }),
    z12.object({
      type: z12.literal("listFiles"),
      command: z12.string(),
      path: z12.string().nullable()
    }),
    z12.object({
      type: z12.literal("search"),
      command: z12.string(),
      query: z12.string().nullable(),
      path: z12.string().nullable()
    }),
    z12.object({
      type: z12.literal("unknown"),
      command: z12.string()
    })
  ]
);
var pendingInteractionNetworkPermissionsSchema = z12.object({
  enabled: z12.boolean().nullable()
});
var pendingInteractionFileSystemPermissionsSchema = z12.object({
  read: z12.array(z12.string()),
  write: z12.array(z12.string())
});
var pendingInteractionMacOsPreferencesPermissionSchema = z12.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsContactsPermissionSchema = z12.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsAutomationPermissionSchema = z12.union([
  z12.literal("none"),
  z12.literal("all"),
  z12.object({
    kind: z12.literal("bundle_ids"),
    bundleIds: z12.array(z12.string())
  })
]);
var pendingInteractionMacOsPermissionsSchema = z12.object({
  preferences: pendingInteractionMacOsPreferencesPermissionSchema,
  automations: pendingInteractionMacOsAutomationPermissionSchema,
  launchServices: z12.boolean(),
  accessibility: z12.boolean(),
  calendar: z12.boolean(),
  reminders: z12.boolean(),
  contacts: pendingInteractionMacOsContactsPermissionSchema
});
var pendingInteractionRequestedPermissionProfileSchema = z12.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
  macos: pendingInteractionMacOsPermissionsSchema.nullable()
});
var pendingInteractionGrantablePermissionProfileSchema = z12.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable()
}).strict();
var pendingInteractionGrantedPermissionProfileSchema = pendingInteractionGrantablePermissionProfileSchema;
var pendingInteractionApprovalDecisionSchema = z12.enum([
  "allow_once",
  "allow_for_session",
  "deny"
]);
var pendingInteractionFileChangeWriteScopeSchema = z12.string().min(1);
var pendingInteractionCommandApprovalSubjectSchema = z12.object({
  kind: z12.literal("command"),
  itemId: z12.string().min(1),
  command: z12.string().min(1),
  cwd: z12.string().nullable(),
  actions: z12.array(pendingInteractionCommandActionSchema),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionFileChangeApprovalSubjectSchema = z12.object({
  kind: z12.literal("file_change"),
  itemId: z12.string().min(1),
  writeScope: pendingInteractionFileChangeWriteScopeSchema.nullable(),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionPermissionGrantApprovalSubjectSchema = z12.object({
  kind: z12.literal("permission_grant"),
  itemId: z12.string().min(1),
  toolName: z12.string().nullable(),
  permissions: pendingInteractionGrantablePermissionProfileSchema
});
var pendingInteractionPlanApprovalSubjectSchema = z12.object({
  kind: z12.literal("plan"),
  itemId: z12.string().min(1),
  plan: z12.string().min(1),
  planFilePath: z12.string().min(1).nullable()
});
var pendingInteractionToolUseApprovalSubjectSchema = z12.object({
  kind: z12.literal("tool_use"),
  itemId: z12.string().min(1),
  tool: z12.string().min(1),
  presentation: threadEventItemPresentationSchema
});
var pendingInteractionApprovalSubjectSchema = z12.discriminatedUnion("kind", [
  pendingInteractionCommandApprovalSubjectSchema,
  pendingInteractionFileChangeApprovalSubjectSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionPlanApprovalSubjectSchema,
  pendingInteractionToolUseApprovalSubjectSchema
]);
var approvalPendingInteractionPayloadSchema = z12.object({
  kind: z12.literal("approval"),
  subject: pendingInteractionApprovalSubjectSchema,
  reason: z12.string().nullable(),
  availableDecisions: z12.array(pendingInteractionApprovalDecisionSchema).min(1)
});
var USER_QUESTION_MAX_QUESTIONS = 4;
var USER_QUESTION_MAX_OPTIONS = 4;
var USER_QUESTION_MAX_SELECTED = 4;
var USER_QUESTION_MAX_FREE_TEXT_LENGTH = 4096;
var pendingInteractionUserQuestionIdSchema = z12.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question ids cannot be blank"
});
var pendingInteractionUserQuestionPromptSchema = z12.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question prompts cannot be blank"
});
var pendingInteractionUserQuestionShortLabelSchema = z12.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question short labels cannot be blank"
});
var pendingInteractionUserQuestionOptionValueSchema = z12.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option values cannot be blank"
});
var pendingInteractionUserQuestionOptionLabelSchema = z12.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option labels cannot be blank"
});
var pendingInteractionUserQuestionOptionDescriptionSchema = z12.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option descriptions cannot be blank"
});
var pendingInteractionUserQuestionFreeTextSchema = z12.string().min(1).max(
  USER_QUESTION_MAX_FREE_TEXT_LENGTH,
  `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`
).refine((value) => value.trim().length > 0, {
  message: "User question free text cannot be blank"
});
var pendingInteractionUserQuestionOptionSchema = z12.object({
  value: pendingInteractionUserQuestionOptionValueSchema,
  label: pendingInteractionUserQuestionOptionLabelSchema,
  description: pendingInteractionUserQuestionOptionDescriptionSchema.optional()
});
var pendingInteractionUserQuestionQuestionSchema = z12.object({
  id: pendingInteractionUserQuestionIdSchema,
  prompt: pendingInteractionUserQuestionPromptSchema,
  shortLabel: pendingInteractionUserQuestionShortLabelSchema.optional(),
  multiSelect: z12.boolean(),
  options: z12.array(pendingInteractionUserQuestionOptionSchema).max(
    USER_QUESTION_MAX_OPTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_OPTIONS} options`
  ).optional(),
  allowFreeText: z12.boolean()
}).superRefine((question, context) => {
  const optionValues = /* @__PURE__ */ new Set();
  question.options?.forEach((option, index) => {
    if (optionValues.has(option.value)) {
      context.addIssue({
        code: z12.ZodIssueCode.custom,
        message: "User question option values must be unique",
        path: ["options", index, "value"]
      });
      return;
    }
    optionValues.add(option.value);
  });
}).refine(
  (question) => question.allowFreeText || (question.options?.length ?? 0) > 0,
  {
    message: "User questions must allow free text or provide at least one option",
    path: ["options"]
  }
);
var userQuestionPendingInteractionPayloadSchema = z12.object({
  kind: z12.literal("user_question"),
  questions: z12.array(pendingInteractionUserQuestionQuestionSchema).min(1).max(
    USER_QUESTION_MAX_QUESTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_QUESTIONS} questions`
  )
}).superRefine((payload, context) => {
  const questionIds = /* @__PURE__ */ new Set();
  payload.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: z12.ZodIssueCode.custom,
        message: "User question ids must be unique",
        path: ["questions", index, "id"]
      });
      return;
    }
    questionIds.add(question.id);
  });
});
var pluginPendingInteractionPayloadSchema = z12.object({
  kind: z12.literal("plugin"),
  title: z12.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema,
  presentation: threadEventItemPresentationSchema.optional()
});
var pluginExtensionInteractionRequestPayloadSchema = z12.object({
  kind: extensionKindSchema,
  title: z12.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin request data exceeds 64 KiB" }
  )
});
var interactionRequestPayloadSchema = z12.union([
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
var pendingInteractionPayloadSchema = z12.union([
  approvalPendingInteractionPayloadSchema,
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
function isApprovalPendingInteractionPayload(payload) {
  return payload.kind === "approval";
}
function isUserQuestionPendingInteractionPayload(payload) {
  return payload.kind === "user_question";
}
var approvalDecisionDiscriminatorError = "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'";
var approvalPendingInteractionResolutionSchema = z12.discriminatedUnion(
  "decision",
  [
    z12.object({
      decision: z12.literal("allow_once"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z12.object({
      decision: z12.literal("allow_for_session"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z12.object({
      decision: z12.literal("deny")
    })
  ],
  approvalDecisionDiscriminatorError
);
var pendingInteractionUserAnswerSchema = z12.object({
  selected: z12.array(z12.string().min(1)).max(
    USER_QUESTION_MAX_SELECTED,
    `User question selected choices cannot exceed ${USER_QUESTION_MAX_SELECTED}`
  ),
  freeText: pendingInteractionUserQuestionFreeTextSchema.optional()
});
var userQuestionPendingInteractionResolutionSchema = z12.object({
  kind: z12.literal("user_answer"),
  answers: z12.record(z12.string().min(1), pendingInteractionUserAnswerSchema)
});
var pluginInteractionDescriptionSchema = z12.object({
  title: z12.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH).optional(),
  detail: z12.string().trim().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  payload: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin interaction description payload exceeds 64 KiB" }
  ).optional()
});
var pluginPendingInteractionResolutionSchema = z12.object({
  kind: z12.literal("plugin_submitted"),
  description: pluginInteractionDescriptionSchema.optional()
});
var pluginExtensionInteractionResolutionSchema = z12.object({
  kind: z12.literal("request_answer"),
  value: jsonValueSchema
});
var pendingInteractionResolutionSchema = z12.union(
  [
    approvalPendingInteractionResolutionSchema,
    userQuestionPendingInteractionResolutionSchema,
    pluginPendingInteractionResolutionSchema,
    pluginExtensionInteractionResolutionSchema
  ],
  approvalDecisionDiscriminatorError
);
function isApprovalPendingInteractionResolution(resolution) {
  return "decision" in resolution;
}
function isUserQuestionPendingInteractionResolution(resolution) {
  return "kind" in resolution && resolution.kind === "user_answer";
}
var approvalInteractionOutcomeSchema = z12.object({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema
});
var userQuestionInteractionOutcomeSchema = z12.object({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema
});
var pluginExtensionInteractionOutcomeSchema = z12.object({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema
});
var providerInteractionOutcomeSchema = z12.union([
  approvalInteractionOutcomeSchema,
  userQuestionInteractionOutcomeSchema,
  pluginExtensionInteractionOutcomeSchema
]);
function isApprovalInteractionOutcome(outcome) {
  return outcome.payload.kind === "approval";
}
var pendingInteractionProviderOriginSchema = z12.object({
  kind: z12.literal("provider"),
  providerId: z12.string().min(1),
  providerThreadId: z12.string().min(1),
  providerRequestId: z12.string().min(1)
});
var pendingInteractionPluginOriginSchema = z12.object({
  kind: z12.literal("plugin"),
  pluginId: z12.string().min(1),
  rendererId: z12.string().min(1)
});
var pendingInteractionCreateSchema = z12.object({
  threadId: z12.string().min(1),
  turnId: z12.string().min(1),
  providerId: z12.string().min(1),
  providerThreadId: z12.string().min(1),
  providerRequestId: z12.string().min(1),
  payload: pendingInteractionPayloadSchema
});
var pendingInteractionBaseSchema = z12.object({
  id: z12.string().min(1),
  threadId: z12.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z12.string().nullable(),
  createdAt: z12.number().int().nonnegative(),
  expiresAt: z12.number().int().nonnegative().nullable().optional(),
  resolvedAt: z12.number().int().nonnegative().nullable()
});
var providerPendingInteractionBaseSchema = pendingInteractionBaseSchema.extend({
  turnId: z12.string().min(1),
  providerId: z12.string().min(1),
  providerThreadId: z12.string().min(1),
  providerRequestId: z12.string().min(1),
  origin: pendingInteractionProviderOriginSchema.optional()
});
var approvalPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable()
});
var userQuestionPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable()
});
var pluginExtensionPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema.nullable()
});
var providerPendingInteractionSchema = z12.union([
  approvalPendingInteractionSchema,
  userQuestionPendingInteractionSchema,
  pluginExtensionPendingInteractionSchema
]);
var pluginPendingInteractionSchema = pendingInteractionBaseSchema.extend({
  turnId: z12.string().min(1).nullable(),
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema,
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pendingInteractionSchema = z12.union([
  providerPendingInteractionSchema,
  pluginPendingInteractionSchema
]);
var interactionLifecycleRecordBaseSchema = z12.object({
  id: z12.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z12.string().nullable()
});
var interactionLifecycleProviderOriginSchema = z12.object({
  kind: z12.literal("provider"),
  providerId: z12.string().min(1),
  providerRequestId: z12.string().min(1)
});
var approvalInteractionLifecycleRecordPayloadSchema = approvalPendingInteractionPayloadSchema.omit({ availableDecisions: true });
var approvalInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: approvalInteractionLifecycleRecordPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable()
});
var userQuestionInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable()
});
var pluginInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema.omit({ data: true }),
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pluginExtensionInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: pluginExtensionInteractionRequestPayloadSchema.omit({
    data: true
  }),
  resolution: pluginExtensionInteractionResolutionSchema.omit({ value: true }).nullable()
});
var interactionLifecycleSchema = z12.union([
  approvalInteractionLifecycleSchema,
  userQuestionInteractionLifecycleSchema,
  pluginInteractionLifecycleSchema,
  pluginExtensionInteractionLifecycleSchema
]);

// ../domain/src/protocol-ids.ts
import { z as z13 } from "zod";
var clientTurnRequestIdSchema = z13.string().regex(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);

// ../domain/src/system-message.ts
import { z as z14 } from "zod";
var systemMessageKindValues = [
  "ownership-assigned",
  "ownership-removed",
  "child-needs-attention",
  "child-completed",
  "child-failed",
  "child-interrupted",
  "child-outcome-batch",
  "tool-result-delivered",
  "unlabeled"
];
var systemMessageKindSchema = z14.enum(systemMessageKindValues);
var systemThreadInterruptedReasonSchema = z14.enum([
  "manual-stop",
  "host-daemon-restarted",
  "host-removed",
  "provider-turn-idle"
]);
var childThreadOutcomeSchema = z14.object({
  threadId: z14.string(),
  status: z14.enum(["completed", "failed", "interrupted"]),
  interruption: z14.object({
    reason: systemThreadInterruptedReasonSchema,
    cause: z14.literal("host-connection-lost").optional()
  }).optional()
});
var systemMessageSubjectSchema = z14.discriminatedUnion("kind", [
  z14.object({
    kind: z14.literal("thread"),
    threadId: z14.string(),
    threadName: z14.string(),
    outcomes: z14.array(childThreadOutcomeSchema).optional()
  }),
  z14.object({
    kind: z14.literal("thread-batch"),
    count: z14.number(),
    outcomes: z14.array(childThreadOutcomeSchema).optional()
  }),
  z14.object({
    kind: z14.literal("tool-call"),
    toolName: z14.string(),
    suppress: z14.boolean()
  })
]);

// ../domain/src/thread-events.ts
var systemEventTypeValues = [
  "client/thread/start",
  "client/turn/requested",
  "client/turn/rejected",
  "client/turn/start",
  "system/error",
  "system/manager/user_message",
  "system/thread/interrupted",
  "system/operation",
  "system/interaction/lifecycle",
  "system/permissionGrant/lifecycle",
  "system/userQuestion/lifecycle",
  "system/thread-provisioning",
  // Legacy persisted watchdog diagnostic; retained for read/decode/render
  // only, with no current producer.
  "system/provider-turn-watchdog"
];
var threadTurnInitiatorValues = ["user", "agent", "system"];
var threadTurnInitiatorSchema = z15.enum(threadTurnInitiatorValues);
var turnRequestOptionsSchema = recordedThreadExecutionOptionsSchema;
var turnRequestTargetSchema = z15.discriminatedUnion("kind", [
  z15.object({ kind: z15.literal("thread-start") }),
  z15.object({ kind: z15.literal("new-turn") }),
  z15.object({
    kind: z15.literal("auto"),
    expectedTurnId: z15.string().nullable()
  }),
  z15.object({
    kind: z15.literal("steer"),
    expectedTurnId: z15.string().nullable()
  })
]);
var clientTurnLifecycleEventDataSchema = z15.object({
  direction: z15.literal("outbound"),
  source: z15.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  request: z15.object({
    method: z15.enum(["thread/start", "turn/start"]),
    params: z15.record(z15.string(), z15.unknown())
  })
});
var turnRequestEventDataSchema = z15.object({
  direction: z15.literal("outbound"),
  requestId: clientTurnRequestIdSchema,
  // Retry provenance, written only when a `turn.failed` gate's retry row
  // dispatches. Both fields are present together or not at all: absence means
  // "this is an original dispatch", which is the overwhelmingly common case.
  // (Supersedes the pre-plugin `continuationOfRequestId` key, which the removed
  // core rate-limit recovery wrote and nothing ever read.)
  /** The original request this attempt re-submits, unchanged across attempts. */
  retryOfRequestId: clientTurnRequestIdSchema.optional(),
  /** Which attempt this is: 2 is the first retry of the original request. */
  retryAttempt: z15.number().int().min(2).optional(),
  source: z15.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  senderThreadId: z15.string().nullable(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
  input: z15.array(promptInputSchema),
  inputGroups: z15.array(z15.array(promptInputSchema).min(1)).min(1).optional(),
  target: turnRequestTargetSchema,
  request: z15.object({
    method: z15.enum(["thread/start", "turn/start"]),
    params: z15.record(z15.string(), z15.unknown())
  }),
  execution: turnRequestOptionsSchema
});
var turnRequestRejectedEventDataSchema = z15.object({
  requestId: clientTurnRequestIdSchema,
  reason: z15.string().min(1),
  message: z15.string().min(1)
});
var systemErrorEventDataSchema = z15.object({
  code: z15.string().optional(),
  message: z15.string(),
  detail: z15.string().optional()
});
var ownershipChangeOperationActionValues = [
  "assign",
  "release",
  "transfer"
];
var ownershipChangeOperationActionSchema = z15.enum(
  ownershipChangeOperationActionValues
);
var ownershipChangeOperationMetadataSchema = z15.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z15.string().nullable(),
  nextParentThreadTitle: z15.string().nullable(),
  previousParentThreadId: z15.string().nullable(),
  previousParentThreadTitle: z15.string().nullable()
});
var systemOperationEventDataSchema = z15.object({
  operation: z15.string(),
  status: z15.string(),
  message: z15.string(),
  operationId: z15.string(),
  metadata: z15.record(z15.string(), jsonValueSchema).optional()
});
var systemInteractionLifecycleEventDataSchema = z15.object({
  interaction: interactionLifecycleSchema
});
var systemPermissionGrantLifecycleEventDataSchema = z15.object({
  interactionId: z15.string(),
  providerId: z15.string(),
  providerRequestId: z15.string(),
  status: pendingInteractionStatusSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z15.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema
});
var systemUserQuestionLifecycleEventDataSchema = z15.object({
  interactionId: z15.string(),
  providerId: z15.string(),
  providerRequestId: z15.string(),
  status: pendingInteractionStatusSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z15.string().nullable().default(null),
  payload: userQuestionPendingInteractionPayloadSchema
});
var systemThreadInterruptedEventDataSchema = z15.object({
  reason: systemThreadInterruptedReasonSchema,
  cause: z15.literal("host-connection-lost").optional()
});
var provisioningTranscriptEntrySchema = z15.object({
  type: z15.enum(["step", "output"]),
  key: z15.string(),
  text: z15.string(),
  startedAt: z15.number().optional(),
  status: z15.enum(["started", "completed", "failed"]).optional(),
  metadata: z15.record(z15.string(), z15.unknown()).optional()
});
var systemThreadProvisioningStatusValues = [
  "active",
  "completed",
  "failed",
  "cancelled"
];
var systemThreadProvisioningStatusSchema = z15.enum(
  systemThreadProvisioningStatusValues
);
var systemThreadProvisioningEventDataSchema = z15.object({
  provisioningId: z15.string(),
  status: systemThreadProvisioningStatusSchema,
  environmentId: z15.string().nullable(),
  entries: z15.array(provisioningTranscriptEntrySchema)
});
var systemLegacyUserMessageEventDataSchema = z15.object({
  text: z15.string(),
  toolCallId: z15.string().optional(),
  turnId: z15.string().optional()
});
var systemProviderTurnWatchdogEventDataSchema = z15.object({
  reason: z15.literal("provider-turn-idle"),
  thresholdMs: z15.number().int().positive(),
  elapsedMs: z15.number().int().nonnegative(),
  activeTurnId: z15.string().min(1),
  activeTurnStartedAt: z15.number().int().nonnegative(),
  lastActivityEventSequence: z15.number().int().positive(),
  lastActivityEventType: z15.string().min(1),
  lastActivityEventAt: z15.number().int().nonnegative(),
  providerId: z15.string().min(1),
  providerThreadId: z15.string().min(1).nullable(),
  firedAt: z15.number().int().nonnegative()
});

// ../domain/src/thread-event-scope.ts
import { z as z16 } from "zod";
var threadEventScopeKindValues = ["thread", "turn"];
var threadEventScopeKindSchema = z16.enum(threadEventScopeKindValues);
var threadEventScopeSchema = z16.discriminatedUnion("kind", [
  z16.object({ kind: z16.literal("thread") }),
  z16.object({ kind: z16.literal("turn"), turnId: z16.string().min(1) })
]);
var threadEventScopePolicyValues = [
  "thread",
  "turn",
  "thread-or-turn"
];
var threadEventScopePolicySchema = z16.enum(threadEventScopePolicyValues);
var threadEventScopeDefinitionByType = {
  "thread/started": {
    policy: "thread",
    rationale: "Thread lifecycle event; it creates the thread timeline itself."
  },
  "thread/identity": {
    policy: "thread",
    rationale: "Thread metadata event; it identifies the provider thread outside turn chronology."
  },
  "turn/started": { policy: "turn" },
  "turn/completed": { policy: "turn" },
  "turn/input/accepted": { policy: "turn" },
  "thread/name/updated": {
    policy: "thread",
    rationale: "Thread metadata event; names are not part of a specific turn transcript."
  },
  "thread/compacted": { policy: "turn" },
  "thread/context/cleared": { policy: "turn" },
  "thread/goal/updated": {
    policy: "thread",
    rationale: "Thread goal state is current thread metadata, not part of a specific turn transcript."
  },
  "thread/goal/cleared": {
    policy: "thread",
    rationale: "Thread goal state is current thread metadata, not part of a specific turn transcript."
  },
  "item/started": { policy: "turn" },
  "item/completed": { policy: "turn" },
  "item/agentMessage/delta": { policy: "turn" },
  "item/commandExecution/outputDelta": { policy: "turn" },
  "item/fileChange/outputDelta": { policy: "turn" },
  "item/reasoning/summaryTextDelta": { policy: "turn" },
  "item/reasoning/textDelta": { policy: "turn" },
  "item/plan/delta": { policy: "turn" },
  "item/mcpToolCall/progress": { policy: "turn" },
  "item/toolCall/progress": { policy: "turn" },
  "item/backgroundTask/progress": {
    policy: "thread",
    rationale: "Background tasks outlive their spawning turn; thread scope keeps turn windows sequence-contiguous (late progress must not interleave into later turns' ranges)."
  },
  "item/backgroundTask/completed": {
    policy: "thread",
    rationale: "Terminal task state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range."
  },
  "item/delegation/progress": {
    policy: "thread",
    rationale: "Background delegations outlive their spawning turn exactly like background tasks; thread scope keeps turn windows sequence-contiguous."
  },
  "item/delegation/completed": {
    policy: "thread",
    rationale: "A background delegation's terminal state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range."
  },
  "thread/tokenUsage/updated": { policy: "turn" },
  "thread/contextWindowUsage/updated": {
    policy: "thread-or-turn",
    rationale: "Context usage is session state; providers can report it before, during, or after a turn."
  },
  "turn/plan/updated": { policy: "turn" },
  "turn/diff/updated": { policy: "turn" },
  "provider/error": {
    policy: "thread-or-turn",
    rationale: "Provider diagnostics use thread scope for provider setup/session failures; in-turn failures use turn scope."
  },
  "provider/rateLimits/updated": {
    policy: "thread",
    rationale: "Subscription usage is account-scoped state that can affect multiple turns and threads."
  },
  "provider.env-resolved": {
    policy: "thread",
    rationale: "Resolved provider environment is session state and can change between turns."
  },
  "thread/extensionState/updated": {
    policy: "thread",
    rationale: "Plugin-declared thread state is current thread metadata (like goals), not part of a specific turn transcript; latest snapshot per kind wins."
  },
  "provider/warning": {
    policy: "thread-or-turn",
    rationale: "Provider warnings use thread scope for config, deprecation, or global notices; turn-specific warnings use turn scope."
  },
  "provider/modelFallback": {
    policy: "thread-or-turn",
    rationale: "Provider model fallback signals can occur while a turn is active or at session scope before a turn is established."
  },
  "thread/execution/reported": {
    policy: "thread",
    rationale: "What the provider reports it runs with is session state, reported when a session is constructed, before or between turns."
  },
  "provider/unhandled": {
    policy: "thread-or-turn",
    rationale: "Unhandled provider events use thread scope only when no active turn context exists; in-turn unknown events use turn scope."
  },
  "client/thread/start": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it requests thread creation before any turn exists."
  },
  "client/turn/requested": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it records the request before provider turn acceptance."
  },
  "client/turn/rejected": {
    policy: "thread",
    rationale: "Client request rejection occurs before provider turn acceptance and identifies the request at thread scope."
  },
  "client/turn/start": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it records the start request before provider turn acceptance."
  },
  "system/error": {
    policy: "thread-or-turn",
    rationale: "System errors use thread scope for app, daemon, or session failures outside a turn; turn failures use turn scope."
  },
  "system/manager/user_message": {
    policy: "thread-or-turn",
    rationale: "Legacy persisted user-visible system messages may be thread-scoped for general updates or turn-scoped for in-turn updates."
  },
  "system/thread/interrupted": {
    policy: "thread",
    rationale: "Thread stop lifecycle event; it represents user interruption of the whole running thread."
  },
  "system/operation": {
    policy: "thread-or-turn",
    rationale: "Thread-management operations use thread scope outside provider turns; tool-owned operations use turn scope so the operation stays with the tool call that caused it."
  },
  "system/interaction/lifecycle": {
    policy: "thread-or-turn",
    rationale: "A provider interaction belongs to the turn that raised it; a plugin may raise one outside any turn."
  },
  "system/permissionGrant/lifecycle": { policy: "turn" },
  "system/userQuestion/lifecycle": { policy: "turn" },
  "system/thread-provisioning": {
    policy: "thread",
    rationale: "Workspace provisioning lifecycle event; environment setup belongs to the thread, not a turn."
  },
  "system/provider-turn-watchdog": {
    policy: "thread",
    rationale: "Legacy persisted watchdog diagnostics are decoded for old timelines only; there is no current producer."
  }
};
function getThreadEventScopePolicyDefinitionEntries() {
  return Object.entries(threadEventScopeDefinitionByType).map(
    ([type, definition]) => ({
      type,
      definition
    })
  );
}
function buildThreadEventScopePolicyByType() {
  const policies = {};
  for (const entry of getThreadEventScopePolicyDefinitionEntries()) {
    policies[entry.type] = entry.definition.policy;
  }
  return policies;
}
var threadEventScopePolicyByType = buildThreadEventScopePolicyByType();
function validateThreadEventScope(args) {
  const policy = threadEventScopePolicyByType[args.type];
  if (policy === "thread-or-turn") {
    return { valid: true };
  }
  if (policy !== args.scope.kind) {
    return {
      valid: false,
      message: `${args.type} requires ${policy} scope but received ${args.scope.kind} scope`
    };
  }
  return { valid: true };
}

// ../domain/src/thread-timeline-goal.ts
import { z as z17 } from "zod";
var threadTimelineGoalStatusSchema = z17.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete"
]);
var threadTimelineGoalSchema = z17.object({
  sourceSeq: z17.number().int().nonnegative(),
  updatedAt: z17.number(),
  objective: z17.string(),
  status: threadTimelineGoalStatusSchema,
  tokenBudget: z17.number().nullable(),
  tokensUsed: z17.number(),
  timeUsedSeconds: z17.number()
});

// ../domain/src/provider-event.ts
var threadEventItemStatusSchema = z18.enum([
  "pending",
  "completed",
  "failed",
  "interrupted"
]);
var threadEventItemApprovalStatusSchema = z18.enum(["waiting_for_approval", "denied"]).nullable();
var threadEventTurnStatusSchema = z18.enum([
  "completed",
  "failed",
  "interrupted"
]);
var providerErrorCategoryValues = [
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown"
];
var providerErrorCategorySchema = z18.enum(providerErrorCategoryValues);
var providerErrorInfoSchema = z18.object({
  category: providerErrorCategorySchema,
  providerCode: z18.string().nullable(),
  httpStatusCode: z18.number().nullable()
});
var providerRateLimitStatusSchema = z18.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown"
]);
var providerRateLimitWindowSchema = z18.object({
  providerKey: z18.string().min(1).nullable(),
  label: z18.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z18.number().int().nonnegative().nullable()
});
var providerRateLimitStateSchema = z18.object({
  providerId: z18.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z18.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z18.array(providerRateLimitWindowSchema),
  reachedReason: z18.string().min(1).nullable(),
  overageStatus: z18.enum(["allowed", "warning", "rejected", "unavailable"]).nullable(),
  overageReason: z18.string().min(1).nullable()
});
var threadEventFileChangeKindSchema = z18.enum(["add", "delete", "update"]);
var threadEventFileChangeSchema = z18.object({
  path: z18.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z18.string().optional(),
  diff: z18.string().optional()
});
var threadEventPlanStepStatusSchema = z18.enum([
  "pending",
  "active",
  "completed",
  "failed"
]);
var threadEventPlanStepSchema = z18.object({
  step: z18.string(),
  status: threadEventPlanStepStatusSchema.optional()
});
var itemPresentationField = {
  presentation: threadEventItemPresentationSchema.optional()
};
var threadEventWebSearchItemSchema = z18.object({
  type: z18.literal("webSearch"),
  id: z18.string(),
  queries: z18.array(z18.string()).min(1),
  resultText: z18.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventWebFetchItemSchema = z18.object({
  type: z18.literal("webFetch"),
  id: z18.string(),
  url: z18.string(),
  prompt: z18.string().nullable(),
  pattern: z18.string().nullable(),
  resultText: z18.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventImageViewItemSchema = z18.object({
  type: z18.literal("imageView"),
  id: z18.string(),
  path: z18.string(),
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventFileReadItemSchema = z18.object({
  type: z18.literal("fileRead"),
  id: z18.string(),
  path: z18.string(),
  cmd: z18.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventSearchModeSchema = z18.enum(["content", "path", "list"]);
var threadEventSearchItemSchema = z18.object({
  type: z18.literal("search"),
  id: z18.string(),
  mode: threadEventSearchModeSchema,
  query: z18.string(),
  path: z18.string().optional(),
  cmd: z18.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventDelegationItemSchema = z18.object({
  type: z18.literal("delegation"),
  id: z18.string(),
  childRef: z18.string().min(1),
  label: z18.string(),
  status: threadEventItemStatusSchema,
  background: z18.boolean(),
  summary: z18.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventPlanStepsItemSchema = z18.object({
  type: z18.literal("planSteps"),
  id: z18.string(),
  steps: z18.array(threadEventPlanStepSchema),
  explanation: z18.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventExtensionItemSchema = z18.object({
  type: z18.literal("extension"),
  id: z18.string(),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
  status: threadEventItemStatusSchema,
  presentation: threadEventItemPresentationSchema,
  parentToolCallId: z18.string().optional()
});
var threadEventTextTruncationSchema = z18.object({
  originalLength: z18.number(),
  retainedHeadLength: z18.number(),
  retainedTailLength: z18.number(),
  truncatedAt: z18.number()
});
var threadEventItemTruncationSchema = z18.object({
  aggregatedOutput: threadEventTextTruncationSchema.optional(),
  result: threadEventTextTruncationSchema.optional(),
  resultText: threadEventTextTruncationSchema.optional()
});
var threadEventImageGenerationItemSchema = z18.object({
  type: z18.literal("imageGeneration"),
  id: z18.string(),
  status: threadEventItemStatusSchema,
  prompt: z18.string().nullable(),
  path: z18.string().nullable(),
  result: z18.string().optional(),
  error: z18.string().nullable(),
  transparentBackground: z18.boolean(),
  truncation: threadEventItemTruncationSchema.optional(),
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventUserContentSchema = z18.discriminatedUnion("type", [
  z18.object({ type: z18.literal("text"), text: z18.string() }),
  z18.object({ type: z18.literal("image"), url: z18.string() }),
  z18.object({ type: z18.literal("localImage"), path: z18.string() }),
  z18.object({ type: z18.literal("localFile"), path: z18.string() })
]);
var threadEventTokenUsageBreakdownSchema = z18.object({
  totalTokens: z18.number(),
  inputTokens: z18.number(),
  cachedInputTokens: z18.number(),
  cacheReadInputTokens: z18.number().nonnegative().optional(),
  cacheWriteInputTokens: z18.number().nonnegative().optional(),
  outputTokens: z18.number(),
  reasoningOutputTokens: z18.number()
});
var threadUsageCostSchema = z18.object({
  amount: z18.number().nonnegative(),
  currency: z18.string().min(1)
});
var threadEventContextWindowUsageSchema = z18.object({
  snapshot: contextSnapshotSchema.optional(),
  usedTokens: z18.number().nullable(),
  modelContextWindow: z18.number().nullable(),
  estimated: z18.boolean(),
  cost: threadUsageCostSchema.optional()
});
var threadEventTokenUsageSchema = z18.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z18.number().nullable()
});
var threadEventWarningCategorySchema = z18.enum([
  "deprecation",
  "config",
  "general",
  "compaction-skipped"
]);
var providerRawEventSchema = z18.object({
  jsonrpc: z18.literal("2.0"),
  id: z18.union([z18.string(), z18.number()]).optional(),
  method: z18.string(),
  params: jsonValueSchema.optional()
});
var providerUnhandledEventSchema = z18.object({
  type: z18.literal("provider/unhandled"),
  threadId: z18.string(),
  providerThreadId: z18.string(),
  providerId: z18.string(),
  rawType: z18.string(),
  rawEvent: providerRawEventSchema,
  parentToolCallId: z18.string().optional()
});
var toolCallProgressEventSchema = z18.object({
  type: z18.literal("item/toolCall/progress"),
  threadId: z18.string(),
  providerThreadId: z18.string(),
  itemId: z18.string(),
  message: z18.string().optional(),
  parentToolCallId: z18.string().optional()
});
var threadEventBackgroundTaskItemSchema = z18.object({
  type: z18.literal("backgroundTask"),
  id: z18.string(),
  familyId: z18.string().optional(),
  taskType: z18.string(),
  description: z18.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z18.boolean(),
  workflowName: z18.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z18.string().optional(),
  error: z18.string().optional(),
  outputFile: z18.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z18.string().optional()
});
var threadEventItemSchema = z18.discriminatedUnion("type", [
  z18.object({
    type: z18.literal("userMessage"),
    id: z18.string(),
    content: z18.array(threadEventUserContentSchema),
    clientRequestId: clientTurnRequestIdSchema.optional(),
    parentToolCallId: z18.string().optional()
  }).strict(),
  z18.object({
    type: z18.literal("agentMessage"),
    id: z18.string(),
    text: z18.string(),
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("commandExecution"),
    id: z18.string(),
    command: z18.string(),
    cwd: z18.string(),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    aggregatedOutput: z18.string().optional(),
    exitCode: z18.number().optional(),
    durationMs: z18.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("fileChange"),
    id: z18.string(),
    changes: z18.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  threadEventWebSearchItemSchema,
  threadEventWebFetchItemSchema,
  threadEventImageViewItemSchema,
  threadEventImageGenerationItemSchema,
  threadEventFileReadItemSchema,
  threadEventSearchItemSchema,
  z18.object({
    type: z18.literal("toolCall"),
    id: z18.string(),
    server: z18.string().optional(),
    tool: z18.string(),
    arguments: z18.record(z18.string(), z18.unknown()).optional(),
    status: threadEventItemStatusSchema,
    result: z18.unknown().optional(),
    error: z18.string().optional(),
    durationMs: z18.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("reasoning"),
    id: z18.string(),
    summary: z18.array(z18.string()),
    content: z18.array(z18.string()),
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("plan"),
    id: z18.string(),
    text: z18.string(),
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  threadEventPlanStepsItemSchema,
  z18.object({
    type: z18.literal("contextCompaction"),
    id: z18.string(),
    ...itemPresentationField,
    parentToolCallId: z18.string().optional()
  }),
  threadEventBackgroundTaskItemSchema,
  threadEventDelegationItemSchema,
  threadEventExtensionItemSchema
]);
function itemTextDeltaEventSchema(type) {
  return z18.object({
    type: z18.literal(type),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    itemId: z18.string(),
    delta: z18.string(),
    parentToolCallId: z18.string().optional()
  });
}
var unscopedProviderEventSchema = z18.discriminatedUnion("type", [
  z18.object({
    type: z18.literal("thread/started"),
    threadId: z18.string()
  }),
  z18.object({
    type: z18.literal("thread/identity"),
    threadId: z18.string(),
    providerThreadId: z18.string()
  }),
  z18.object({
    type: z18.literal("turn/started"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    parentToolCallId: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("turn/completed"),
    threadId: z18.string(),
    providerThreadId: z18.string().nullable(),
    status: threadEventTurnStatusSchema,
    error: z18.object({ message: z18.string() }).optional(),
    providerCheckpointId: z18.string().min(1).optional()
  }),
  z18.object({
    type: z18.literal("turn/input/accepted"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    clientRequestId: clientTurnRequestIdSchema,
    scope: threadEventScopeSchema
  }).strict(),
  z18.object({
    type: z18.literal("thread/name/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    threadName: z18.string(),
    source: z18.literal("agent").optional()
  }),
  z18.object({
    type: z18.literal("thread/compacted"),
    threadId: z18.string(),
    providerThreadId: z18.string()
  }),
  z18.object({
    type: z18.literal("thread/context/cleared"),
    threadId: z18.string(),
    providerThreadId: z18.string()
  }),
  z18.object({
    type: z18.literal("thread/goal/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    objective: z18.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z18.number().nullable(),
    tokensUsed: z18.number(),
    timeUsedSeconds: z18.number()
  }),
  z18.object({
    type: z18.literal("thread/goal/cleared"),
    threadId: z18.string(),
    providerThreadId: z18.string()
  }),
  z18.object({
    type: z18.literal("item/started"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    item: threadEventItemSchema
  }),
  z18.object({
    type: z18.literal("item/completed"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    item: threadEventItemSchema
  }),
  itemTextDeltaEventSchema("item/agentMessage/delta"),
  z18.object({
    type: z18.literal("item/commandExecution/outputDelta"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    itemId: z18.string(),
    delta: z18.string(),
    reset: z18.boolean().optional(),
    parentToolCallId: z18.string().optional()
  }),
  itemTextDeltaEventSchema("item/fileChange/outputDelta"),
  itemTextDeltaEventSchema("item/reasoning/summaryTextDelta"),
  itemTextDeltaEventSchema("item/reasoning/textDelta"),
  itemTextDeltaEventSchema("item/plan/delta"),
  z18.object({
    type: z18.literal("item/mcpToolCall/progress"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    itemId: z18.string(),
    message: z18.string().optional(),
    parentToolCallId: z18.string().optional()
  }),
  toolCallProgressEventSchema,
  z18.object({
    type: z18.literal("item/backgroundTask/progress"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z18.object({
    type: z18.literal("item/backgroundTask/completed"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z18.object({
    type: z18.literal("item/delegation/progress"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    item: threadEventDelegationItemSchema
  }),
  z18.object({
    type: z18.literal("item/delegation/completed"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    item: threadEventDelegationItemSchema
  }),
  z18.object({
    type: z18.literal("thread/tokenUsage/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    tokenUsage: threadEventTokenUsageSchema
  }),
  z18.object({
    type: z18.literal("thread/contextWindowUsage/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    contextWindowUsage: threadEventContextWindowUsageSchema
  }),
  z18.object({
    type: z18.literal("turn/plan/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    plan: z18.array(threadEventPlanStepSchema),
    explanation: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("turn/diff/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    diff: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("provider/error"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    message: z18.string(),
    detail: z18.string().optional(),
    willRetry: z18.boolean().optional(),
    errorInfo: providerErrorInfoSchema.optional()
  }),
  z18.object({
    type: z18.literal("provider/rateLimits/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    rateLimits: providerRateLimitStateSchema
  }),
  z18.object({
    type: z18.literal("provider.env-resolved"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    entries: z18.array(
      z18.object({
        name: z18.string(),
        source: z18.union([
          z18.literal("shell"),
          z18.object({ plugin: z18.string() }).strict(),
          z18.object({
            core: z18.enum([
              "machine-git",
              "machine-environment",
              "project-environment"
            ])
          }).strict()
        ]),
        value: z18.union([
          z18.string(),
          z18.object({ masked: z18.literal(true) }).strict()
        ]),
        reason: z18.string().optional()
      }).strict()
    )
  }),
  z18.object({
    type: z18.literal("thread/extensionState/updated"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    kind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z18.object({
    type: z18.literal("provider/warning"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    category: threadEventWarningCategorySchema,
    summary: z18.string().optional(),
    details: z18.string().optional()
  }),
  z18.object({
    type: z18.literal("provider/modelFallback"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    originalModel: z18.string().min(1),
    fallbackModel: z18.string().min(1),
    reason: z18.enum(["refusal", "provider"]),
    message: z18.string()
  }),
  z18.object({
    type: z18.literal("thread/execution/reported"),
    threadId: z18.string(),
    providerThreadId: z18.string(),
    execution: threadExecutionReportSchema
  }),
  providerUnhandledEventSchema
]);
var scopedEventDataSchema = z18.object({
  scope: threadEventScopeSchema
});
var providerEventSchema = unscopedProviderEventSchema.and(
  scopedEventDataSchema
);
var providerEventTypeValues = unscopedProviderEventSchema.options.map(
  (option) => option.shape.type.value
);
var unscopedSystemEventSchema = z18.discriminatedUnion("type", [
  z18.object({
    type: z18.literal("client/thread/start"),
    threadId: z18.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z18.object({
    type: z18.literal("client/turn/requested"),
    threadId: z18.string()
  }).merge(turnRequestEventDataSchema),
  z18.object({
    type: z18.literal("client/turn/rejected"),
    threadId: z18.string()
  }).merge(turnRequestRejectedEventDataSchema),
  z18.object({
    type: z18.literal("client/turn/start"),
    threadId: z18.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z18.object({
    type: z18.literal("system/error"),
    threadId: z18.string()
  }).merge(systemErrorEventDataSchema),
  z18.object({
    type: z18.literal("system/manager/user_message"),
    threadId: z18.string()
  }).merge(systemLegacyUserMessageEventDataSchema),
  z18.object({
    type: z18.literal("system/thread/interrupted"),
    threadId: z18.string()
  }).merge(systemThreadInterruptedEventDataSchema),
  z18.object({
    type: z18.literal("system/operation"),
    threadId: z18.string()
  }).merge(systemOperationEventDataSchema),
  z18.object({
    type: z18.literal("system/interaction/lifecycle"),
    threadId: z18.string()
  }).merge(systemInteractionLifecycleEventDataSchema),
  z18.object({
    type: z18.literal("system/permissionGrant/lifecycle"),
    threadId: z18.string()
  }).merge(systemPermissionGrantLifecycleEventDataSchema),
  z18.object({
    type: z18.literal("system/userQuestion/lifecycle"),
    threadId: z18.string()
  }).merge(systemUserQuestionLifecycleEventDataSchema),
  z18.object({
    type: z18.literal("system/thread-provisioning"),
    threadId: z18.string()
  }).merge(systemThreadProvisioningEventDataSchema),
  z18.object({
    type: z18.literal("system/provider-turn-watchdog"),
    threadId: z18.string()
  }).merge(systemProviderTurnWatchdogEventDataSchema)
]);
var systemEventSchema = unscopedSystemEventSchema.and(scopedEventDataSchema);
var threadEventSchema = z18.union([providerEventSchema, systemEventSchema]).superRefine((event, ctx) => {
  const result = validateThreadEventScope({
    type: event.type,
    scope: event.scope
  });
  if (!result.valid) {
    ctx.addIssue({
      code: z18.ZodIssueCode.custom,
      message: result.message ?? "Invalid thread event scope",
      path: ["scope"]
    });
    return;
  }
});
var threadEventTypeValues = [
  ...providerEventTypeValues,
  ...systemEventTypeValues
];
var threadEventTypeSet = new Set(threadEventTypeValues);
var threadEventTypeSchema = z18.string().refine(
  (value) => threadEventTypeSet.has(value),
  "Invalid thread event type"
);

// ../domain/src/number-utils.ts
function toPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}

// ../domain/src/thread-provider-state.ts
import { z as z19 } from "zod";
var THREAD_PROVIDER_COMMANDS_STATE_KIND = "bb/provider-commands";
var THREAD_SESSION_OPTIONS_STATE_KIND = "bb/session-options";
var threadProviderCommandSchema = z19.object({
  name: z19.string().min(1),
  description: z19.string(),
  inputHint: z19.string().min(1).optional()
});
var threadProviderCommandsStateSchema = z19.object({
  commands: z19.array(threadProviderCommandSchema).max(500)
});
var threadSessionOptionValueSchema = z19.object({
  id: z19.string().min(1),
  label: z19.string().min(1),
  description: z19.string().min(1).optional(),
  group: z19.string().min(1).optional()
});
var threadSessionOptionBaseShape = {
  id: z19.string().min(1),
  label: z19.string().min(1),
  description: z19.string().min(1).optional(),
  category: z19.string().min(1).optional()
};
var threadSessionOptionSchema = z19.discriminatedUnion("type", [
  z19.object({
    ...threadSessionOptionBaseShape,
    type: z19.literal("select"),
    value: z19.string(),
    values: z19.array(threadSessionOptionValueSchema).max(1e3)
  }),
  z19.object({
    ...threadSessionOptionBaseShape,
    type: z19.literal("boolean"),
    value: z19.boolean(),
    fixed: z19.boolean().optional()
  })
]);
var threadSessionOptionsStateSchema = z19.object({
  options: z19.array(threadSessionOptionSchema).max(64)
});
var threadSessionOptionSelectionsStateSchema = z19.object({
  selections: sessionOptionSelectionsSchema
});
var CORE_THREAD_STATE_SCHEMAS = {
  [THREAD_PROVIDER_COMMANDS_STATE_KIND]: threadProviderCommandsStateSchema,
  [THREAD_SESSION_OPTIONS_STATE_KIND]: threadSessionOptionsStateSchema
};

// ../domain/src/provider-fork.ts
import { z as z20 } from "zod";
var PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"];
var providerForkSchema = z20.enum(PROVIDER_FORK_VALUES);

// ../domain/src/provider-types.ts
import { z as z21 } from "zod";
var modelReasoningEffortSchema = z21.object({
  reasoningEffort: reasoningLevelSchema,
  label: z21.string().min(1).optional(),
  description: z21.string()
});
var modelServiceTierSchema = z21.object({
  id: serviceTierSchema,
  label: z21.string().min(1).optional(),
  description: z21.string().min(1).optional()
});
var availableModelSchema = z21.object({
  id: z21.string(),
  model: z21.string(),
  displayName: z21.string(),
  routeProviderId: z21.string().min(1).optional(),
  description: z21.string(),
  supportedReasoningEfforts: z21.array(modelReasoningEffortSchema),
  defaultReasoningEffort: reasoningLevelSchema,
  supportedServiceTiers: z21.array(modelServiceTierSchema).optional(),
  sessionOptions: z21.array(threadSessionOptionSchema).max(64).optional(),
  isDefault: z21.boolean()
});
var providerModelCatalogScopeSchema = z21.enum(["host", "workspace"]);
var providerCapabilitiesSchema = z21.object({
  supportsThreadArchive: z21.boolean(),
  supportsThreadRename: z21.boolean(),
  supportsServiceTier: z21.boolean(),
  supportsNativeUserQuestion: z21.boolean(),
  supportsFork: z21.boolean(),
  supportsSessionRewind: z21.boolean(),
  permissionModes: z21.array(permissionModeSchema).min(1),
  modelCatalogScope: providerModelCatalogScopeSchema,
  reportsTokenUsage: z21.boolean().optional(),
  supportsNativeTerminal: z21.boolean().optional()
});
var providerComposerCommandSchema = z21.object({
  trigger: promptMentionCommandTriggerSchema,
  name: z21.string().min(1).regex(/^[^\s/$]+$/u),
  trailingText: z21.string().regex(/^\s*$/u)
});
var providerComposerActionSchema = z21.discriminatedUnion("kind", [
  z21.object({
    kind: z21.literal("skills"),
    trigger: promptMentionCommandTriggerSchema
  }),
  z21.object({
    kind: z21.literal("plan"),
    command: providerComposerCommandSchema
  }),
  z21.object({
    kind: z21.literal("goal"),
    command: providerComposerCommandSchema
  })
]);
var providerStringsSchema = z21.object({
  signInHint: z21.string().min(1),
  expiredHint: z21.string().min(1),
  installUrl: z21.string().min(1),
  brandPrefix: z21.string().min(1).optional(),
  planModeCopy: z21.string().min(1).optional(),
  iconTint: z21.object({ light: z21.string().min(1), dark: z21.string().min(1) }).optional()
});
var providerOptionDescriptorSchema = z21.object({
  id: z21.string().min(1),
  label: z21.string().min(1),
  description: z21.string().min(1).optional()
});
var providerExtensionKindInfoSchema = z21.object({
  item: z21.boolean(),
  state: z21.boolean()
});
var providerExtensionKindsSchema = z21.record(
  extensionKindSchema,
  providerExtensionKindInfoSchema
);
var providerInfoSchema = z21.object({
  id: z21.string(),
  pluginId: z21.string().min(1),
  displayName: z21.string(),
  family: z21.string().min(1).optional(),
  icon: z21.object({ glyph: z21.string().min(1) }).optional(),
  logoUrl: z21.string().min(1).nullable(),
  maintenance: z21.object({
    health: z21.boolean(),
    usage: z21.boolean(),
    installation: z21.boolean()
  }),
  capabilities: providerCapabilitiesSchema,
  composerActions: z21.array(providerComposerActionSchema),
  completedTurnDisplay: completedTurnDisplaySchema,
  available: z21.boolean(),
  strings: providerStringsSchema.optional(),
  serviceTiers: z21.array(providerOptionDescriptorSchema).optional(),
  reasoningLevels: z21.array(providerOptionDescriptorSchema).optional(),
  extensionKinds: providerExtensionKindsSchema.optional()
});
var providerRecoveryKindValues = [
  "sessionArchived",
  "authRequired",
  "restartRecommended",
  "staleTurn",
  "rateLimited"
];
var providerRecoveryKindSchema = z21.enum(providerRecoveryKindValues);
var toolCallOutputItemSchema = z21.discriminatedUnion("type", [
  z21.object({
    type: z21.literal("inputText"),
    text: z21.string()
  }),
  z21.object({
    type: z21.literal("inputImage"),
    imageUrl: z21.string()
  })
]);
var toolCallRequestSchema = z21.object({
  requestId: z21.union([z21.string().min(1), z21.number()]),
  threadId: z21.string().min(1),
  providerThreadId: z21.string().min(1),
  turnId: z21.string().min(1),
  callId: z21.string().min(1),
  tool: z21.string().min(1),
  arguments: z21.unknown().optional()
});
var toolCallResponseSchema = z21.object({
  contentItems: z21.array(toolCallOutputItemSchema),
  success: z21.boolean()
});
var dynamicToolSchema = z21.object({
  name: z21.string(),
  description: z21.string(),
  inputSchema: z21.unknown(),
  presentation: threadEventItemPresentationSchema.optional(),
  /** A tool awaiting a user-owned interaction may outlive turn completion. */
  waitsForUserInput: z21.boolean().optional()
});

// ../domain/src/reasoning-efforts.ts
var NONE_REASONING_EFFORT = {
  reasoningEffort: "none",
  description: "No extended thinking"
};
var LOW_REASONING_EFFORT = {
  reasoningEffort: "low",
  description: "Low reasoning effort"
};
var MEDIUM_REASONING_EFFORT = {
  reasoningEffort: "medium",
  description: "Medium reasoning effort"
};
var HIGH_REASONING_EFFORT = {
  reasoningEffort: "high",
  description: "High reasoning effort"
};
var XHIGH_REASONING_EFFORT = {
  reasoningEffort: "xhigh",
  description: "Extra high reasoning effort"
};
var ULTRACODE_REASONING_EFFORT = {
  reasoningEffort: "ultracode",
  description: "Extra high reasoning effort plus multi-agent workflow orchestration"
};
var MAX_REASONING_EFFORT = {
  reasoningEffort: "max",
  description: "Maximum reasoning effort"
};
var ULTRA_REASONING_EFFORT = {
  reasoningEffort: "ultra",
  description: "Maximum reasoning with automatic task delegation"
};
var REASONING_EFFORT_BY_LEVEL = {
  none: NONE_REASONING_EFFORT,
  low: LOW_REASONING_EFFORT,
  medium: MEDIUM_REASONING_EFFORT,
  high: HIGH_REASONING_EFFORT,
  xhigh: XHIGH_REASONING_EFFORT,
  ultracode: ULTRACODE_REASONING_EFFORT,
  max: MAX_REASONING_EFFORT,
  ultra: ULTRA_REASONING_EFFORT
};
function reasoningEffortsForLevels(levels) {
  return levels.map(
    (level) => isStandardReasoningLevel(level) ? { ...REASONING_EFFORT_BY_LEVEL[level] } : { reasoningEffort: level, description: level }
  );
}

// ../provider-bridge-protocol/src/bridge-requests.ts
import { z as z22 } from "zod";
var BRIDGE_INBOUND_REQUEST_METHODS = {
  toolCall: "item/tool/call",
  interactionRequest: "interaction/request"
};
var toolCallRequestParamsSchema = z22.object({
  providerThreadId: z22.string().min(1),
  threadId: z22.string().min(1).optional(),
  turnId: z22.union([z22.string().min(1), z22.null()]),
  callId: z22.string().min(1),
  tool: z22.string().min(1),
  arguments: z22.unknown(),
  providerNativeIds: z22.boolean().optional()
}).passthrough();
var toolCallResultSchema = z22.object({
  success: z22.boolean(),
  contentItems: z22.array(
    z22.discriminatedUnion("type", [
      z22.object({ type: z22.literal("inputText"), text: z22.string() }),
      z22.object({
        type: z22.literal("inputImage"),
        imageUrl: z22.string().min(1)
      })
    ])
  )
}).passthrough();
var interactionRequestParamsSchema = z22.object({
  providerThreadId: z22.string().min(1),
  threadId: z22.string().min(1).optional(),
  turnId: z22.union([z22.string().min(1), z22.null()]),
  payload: pendingInteractionPayloadSchema,
  providerNativeIds: z22.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/bridge-kit/bridge-tool-calls.ts
var bridgeRequestEnvelopeSchema = z23.object({
  jsonrpc: z23.literal("2.0"),
  id: z23.union([z23.string(), z23.number()]),
  method: z23.string(),
  params: z23.record(z23.string(), z23.unknown()).optional()
});
var jsonRpcErrorSchema = z23.object({
  code: z23.number(),
  message: z23.string().optional(),
  data: z23.unknown().optional()
});
var jsonRpcSuccessResponseSchema = z23.object({
  jsonrpc: z23.literal("2.0"),
  id: z23.union([z23.string(), z23.number()]),
  result: z23.unknown()
});
var jsonRpcErrorResponseSchema = z23.object({
  jsonrpc: z23.literal("2.0"),
  id: z23.union([z23.string(), z23.number()]),
  error: jsonRpcErrorSchema
});
function isJsonRpcRequest(input) {
  return typeof input === "object" && input !== null && "method" in input && input.method !== void 0;
}
function decodeBridgeJsonRpcResponse(input) {
  if (isJsonRpcRequest(input)) return null;
  const error = jsonRpcErrorResponseSchema.safeParse(input);
  if (error.success) return error.data;
  const success = jsonRpcSuccessResponseSchema.safeParse(input);
  return success.success ? success.data : null;
}
var IMAGE_DATA_URL = /^data:(.+);base64,(.+)$/s;
function decodeImageDataUrl(imageUrl) {
  const match = IMAGE_DATA_URL.exec(imageUrl);
  if (match === null) {
    return null;
  }
  const [, mimeType, data] = match;
  if (data.length === 0) {
    return null;
  }
  return { data, mimeType };
}
function decodeToolCallResponsePayload(result) {
  const parsed = toolCallResultSchema.safeParse(result);
  if (!parsed.success) {
    return {
      content: "Invalid tool call response",
      contentBlocks: [{ type: "text", text: "Invalid tool call response" }],
      images: [],
      isError: true
    };
  }
  const texts = [];
  const contentBlocks = [];
  const images = [];
  for (const item of parsed.data.contentItems) {
    if (item.type === "inputText") {
      texts.push(item.text);
      if (item.text !== "") {
        contentBlocks.push({ type: "text", text: item.text });
      }
      continue;
    }
    const image = decodeImageDataUrl(item.imageUrl);
    if (image === null) {
      texts.push(item.imageUrl);
      contentBlocks.push({ type: "text", text: item.imageUrl });
      continue;
    }
    images.push(image);
    contentBlocks.push({ type: "image", ...image });
  }
  const text = texts.join("\n");
  const isError = !parsed.data.success;
  if (contentBlocks.length === 0) {
    const fallback = isError ? "Tool call failed" : "OK";
    return {
      content: fallback,
      contentBlocks: [{ type: "text", text: fallback }],
      images,
      isError
    };
  }
  return {
    content: text,
    contentBlocks,
    images,
    isError
  };
}
function buildBridgeToolCallContent(result) {
  if (result.contentBlocks !== void 0) {
    return result.contentBlocks;
  }
  const blocks = [];
  if (result.content !== "") {
    blocks.push({ type: "text", text: result.content });
  }
  for (const image of result.images ?? []) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  return blocks;
}

// ../provider-bridge-protocol/src/bridge-kit/json-rpc-envelope.ts
import { z as z24 } from "zod";
var recordSchema = z24.record(z24.string(), z24.unknown());
var jsonRpcEnvelopeSchema = z24.object({
  jsonrpc: z24.literal("2.0"),
  method: z24.string(),
  params: recordSchema.optional()
}).passthrough();
var sdkMessageEnvelopeSchema = z24.object({
  jsonrpc: z24.literal("2.0"),
  method: z24.literal("sdk/message"),
  params: z24.object({
    message: z24.unknown(),
    threadId: z24.string().optional(),
    parent_tool_use_id: z24.string().optional()
  }).passthrough()
}).passthrough();
var threadIdentityEnvelopeSchema = z24.object({
  jsonrpc: z24.literal("2.0"),
  method: z24.literal("thread/identity"),
  params: z24.object({
    threadId: z24.string().optional(),
    providerThreadId: z24.string().optional()
  }).passthrough()
}).passthrough();
var threadContextWindowUsageEnvelopeSchema = z24.object({
  jsonrpc: z24.literal("2.0"),
  method: z24.literal("thread/contextWindowUsage/updated"),
  params: z24.object({
    threadId: z24.string().optional(),
    contextWindowUsage: z24.object({
      usedTokens: z24.number().nullable(),
      modelContextWindow: z24.number().nullable(),
      estimated: z24.boolean()
    })
  }).passthrough()
}).passthrough();
var errorEnvelopeSchema = z24.object({
  jsonrpc: z24.literal("2.0"),
  method: z24.literal("error"),
  params: z24.object({
    message: z24.string().optional()
  }).passthrough().optional()
}).passthrough();

// ../provider-bridge-protocol/src/bridge-kit/mcp-elicitation.ts
var MCP_ELICITATION_MAX_ATTEMPTS = 3;
var UnsupportedElicitationError = class extends Error {
};
var CONFIRM_QUESTION_ID = "confirm";
var CONFIRM_ACCEPT_VALUE = "confirm:accept";
var CONFIRM_DECLINE_VALUE = "confirm:decline";
var TEXT_FORMATS = ["email", "uri", "date", "date-time"];
var ANNOTATION_KEYWORDS = ["title", "description", "default"];
var FORM_KEYWORDS = [
  "$schema",
  "type",
  "properties",
  "required",
  "additionalProperties"
];
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function ownValue(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : void 0;
}
function allowOnlyKeywords(record, keywords, context) {
  const unsupported = Object.keys(record).find(
    (key) => !keywords.includes(key) && !ANNOTATION_KEYWORDS.includes(key)
  );
  if (unsupported !== void 0) {
    throw new UnsupportedElicitationError(
      `${context} uses the unsupported keyword ${unsupported}`
    );
  }
}
function optionalText(record, key) {
  const value = ownValue(record, key);
  if (value === void 0) {
    return null;
  }
  if (typeof value !== "string") {
    throw new UnsupportedElicitationError(`"${key}" must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
function optionalNumber(record, key) {
  const value = ownValue(record, key);
  if (value === void 0) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UnsupportedElicitationError(`"${key}" must be a finite number`);
  }
  return value;
}
function optionsFromConstList(list) {
  if (!Array.isArray(list)) {
    throw new UnsupportedElicitationError("choices must be a list");
  }
  return list.map((entry) => {
    if (!isPlainObject(entry)) {
      throw new UnsupportedElicitationError("choices must be objects");
    }
    allowOnlyKeywords(entry, ["const"], "a choice");
    const value = ownValue(entry, "const");
    if (typeof value !== "string") {
      throw new UnsupportedElicitationError("choice values must be strings");
    }
    const title = optionalText(entry, "title");
    return { value, label: title ?? value };
  });
}
function optionsFromEnum(values, titles) {
  if (!Array.isArray(values)) {
    throw new UnsupportedElicitationError("enum must be a list");
  }
  if (titles !== void 0 && (!Array.isArray(titles) || titles.length !== values.length)) {
    throw new UnsupportedElicitationError("enumNames must match enum");
  }
  return values.map((value, index) => {
    if (typeof value !== "string") {
      throw new UnsupportedElicitationError("enum values must be strings");
    }
    const title = Array.isArray(titles) ? titles[index] : void 0;
    if (title !== void 0 && typeof title !== "string") {
      throw new UnsupportedElicitationError("enumNames must be strings");
    }
    const label = typeof title === "string" && title.trim() ? title.trim() : value;
    return { value, label };
  });
}
function checkedOptions(options) {
  if (options.length === 0) {
    throw new UnsupportedElicitationError("a choice field has no choices");
  }
  if (options.length > USER_QUESTION_MAX_OPTIONS) {
    throw new UnsupportedElicitationError(
      `a choice field has more than ${USER_QUESTION_MAX_OPTIONS} choices`
    );
  }
  if (options.some((option) => option.value.trim().length === 0)) {
    throw new UnsupportedElicitationError("choice values cannot be blank");
  }
  if (new Set(options.map((option) => option.value)).size !== options.length) {
    throw new UnsupportedElicitationError("choice values must be unique");
  }
  return options;
}
function parseFieldShape(property) {
  const type = ownValue(property, "type");
  const oneOf = ownValue(property, "oneOf");
  const anyOf = ownValue(property, "anyOf");
  const enumValues = ownValue(property, "enum");
  if (type === "boolean") {
    allowOnlyKeywords(property, ["type"], "a yes/no field");
    return { kind: "boolean" };
  }
  if (type === "number" || type === "integer") {
    allowOnlyKeywords(
      property,
      ["type", "minimum", "maximum"],
      "a number field"
    );
    return {
      kind: "number",
      integer: type === "integer",
      minimum: optionalNumber(property, "minimum"),
      maximum: optionalNumber(property, "maximum")
    };
  }
  if (type === "array") {
    allowOnlyKeywords(
      property,
      ["type", "items", "minItems", "maxItems", "uniqueItems"],
      "a list field"
    );
    const uniqueItems = ownValue(property, "uniqueItems");
    if (uniqueItems !== void 0 && typeof uniqueItems !== "boolean") {
      throw new UnsupportedElicitationError("uniqueItems must be a boolean");
    }
    const items = ownValue(property, "items");
    if (!isPlainObject(items)) {
      throw new UnsupportedElicitationError("a list field has no items");
    }
    allowOnlyKeywords(
      items,
      ["type", "enum", "anyOf", "oneOf"],
      "a list field's items"
    );
    const itemType = ownValue(items, "type");
    if (itemType !== void 0 && itemType !== "string") {
      throw new UnsupportedElicitationError("list items must be strings");
    }
    if (["enum", "anyOf", "oneOf"].filter(
      (key) => ownValue(items, key) !== void 0
    ).length > 1) {
      throw new UnsupportedElicitationError(
        "list items combine several choice lists"
      );
    }
    const itemChoices = ownValue(items, "anyOf") ?? ownValue(items, "oneOf");
    const options = itemChoices !== void 0 ? optionsFromConstList(itemChoices) : optionsFromEnum(ownValue(items, "enum"), void 0);
    return {
      kind: "multi",
      options: checkedOptions(options),
      minItems: optionalNumber(property, "minItems"),
      maxItems: optionalNumber(property, "maxItems")
    };
  }
  if (type === "string" || type === void 0) {
    if ([oneOf, anyOf, enumValues].filter((choices) => choices !== void 0).length > 1) {
      throw new UnsupportedElicitationError(
        "a field combines several choice lists"
      );
    }
    if (oneOf !== void 0 || anyOf !== void 0) {
      allowOnlyKeywords(property, ["type", "oneOf", "anyOf"], "a choice field");
      return {
        kind: "single",
        options: checkedOptions(optionsFromConstList(oneOf ?? anyOf))
      };
    }
    if (enumValues !== void 0) {
      allowOnlyKeywords(
        property,
        ["type", "enum", "enumNames"],
        "a choice field"
      );
      return {
        kind: "single",
        options: checkedOptions(
          optionsFromEnum(enumValues, ownValue(property, "enumNames"))
        )
      };
    }
    if (type === void 0) {
      throw new UnsupportedElicitationError("a field has no type");
    }
    allowOnlyKeywords(
      property,
      ["type", "minLength", "maxLength", "format"],
      "a text field"
    );
    const format2 = ownValue(property, "format");
    if (format2 !== void 0 && !TEXT_FORMATS.some((candidate) => candidate === format2)) {
      throw new UnsupportedElicitationError(
        `unsupported format ${String(format2)}`
      );
    }
    return {
      kind: "text",
      minLength: optionalNumber(property, "minLength"),
      maxLength: optionalNumber(property, "maxLength"),
      format: TEXT_FORMATS.find((candidate) => candidate === format2) ?? null
    };
  }
  throw new UnsupportedElicitationError(
    `unsupported field type ${String(type)}`
  );
}
function parseElicitationForm(requestedSchema) {
  if (!isPlainObject(requestedSchema)) {
    throw new UnsupportedElicitationError("the form has no schema");
  }
  allowOnlyKeywords(requestedSchema, FORM_KEYWORDS, "the form");
  const schemaType = ownValue(requestedSchema, "type");
  if (schemaType !== void 0 && schemaType !== "object") {
    throw new UnsupportedElicitationError("the form schema is not an object");
  }
  const properties = ownValue(requestedSchema, "properties") ?? {};
  if (!isPlainObject(properties)) {
    throw new UnsupportedElicitationError(
      "the form properties are not an object"
    );
  }
  const entries = Object.entries(properties);
  const requiredValue = ownValue(requestedSchema, "required") ?? [];
  if (!Array.isArray(requiredValue) || requiredValue.some(
    (key) => typeof key !== "string" || !Object.prototype.hasOwnProperty.call(properties, key)
  )) {
    throw new UnsupportedElicitationError(
      "the form requires a field it does not define"
    );
  }
  const required = new Set(requiredValue);
  if (entries.length > USER_QUESTION_MAX_QUESTIONS) {
    throw new UnsupportedElicitationError(
      `the form has more than ${USER_QUESTION_MAX_QUESTIONS} fields`
    );
  }
  const fields = entries.map(([key, property], index) => {
    if (!isPlainObject(property)) {
      throw new UnsupportedElicitationError(`field ${key} is not an object`);
    }
    return {
      ...parseFieldShape(property),
      key,
      questionId: `field-${index + 1}`,
      label: optionalText(property, "title") ?? key,
      description: optionalText(property, "description"),
      required: required.has(key)
    };
  });
  return { fields, confirmOnly: fields.length === 0 };
}
function describeNumberRange(field) {
  const noun = field.integer ? "a whole number" : "a number";
  if (field.minimum !== null && field.maximum !== null) {
    return `${noun} from ${field.minimum} to ${field.maximum}`;
  }
  if (field.minimum !== null) {
    return `${noun} of at least ${field.minimum}`;
  }
  if (field.maximum !== null) {
    return `${noun} of at most ${field.maximum}`;
  }
  return noun;
}
function describeTextRule(field) {
  const parts = [];
  if (field.format === "email") parts.push("an email address");
  if (field.format === "uri") parts.push("an http:// or https:// address");
  if (field.format === "date") parts.push("a date as YYYY-MM-DD");
  if (field.format === "date-time") {
    parts.push("a date and time as YYYY-MM-DDTHH:MM:SSZ");
  }
  if (field.minLength !== null && field.maxLength !== null) {
    parts.push(`${field.minLength} to ${field.maxLength} characters`);
  } else if (field.minLength !== null) {
    parts.push(`at least ${field.minLength} characters`);
  } else if (field.maxLength !== null) {
    parts.push(`at most ${field.maxLength} characters`);
  }
  return parts.length > 0 ? parts.join(", ") : null;
}
function fieldHint(field) {
  switch (field.kind) {
    case "number":
      return describeNumberRange(field);
    case "text":
      return describeTextRule(field);
    case "multi":
      return "choose one or more";
    default:
      return null;
  }
}
function skipValue(field) {
  return `${field.questionId}:skip`;
}
function optionValue(field, index) {
  return `${field.questionId}:option-${index + 1}`;
}
function fieldOptions(field) {
  switch (field.kind) {
    case "boolean":
      return [
        { value: "true", label: "Yes" },
        { value: "false", label: "No" }
      ];
    case "single":
    case "multi":
      return field.options;
    default:
      return [];
  }
}
function canSkip(field) {
  return !field.required && fieldOptions(field).length < USER_QUESTION_MAX_OPTIONS;
}
function questionFor(args) {
  const { field } = args;
  const hint = fieldHint(field);
  const parts = [
    args.intro,
    field.description === null ? field.label : `${field.label}: ${field.description}`,
    hint === null ? null : `(${hint})`,
    args.error === null ? null : `${args.error}.`
  ].filter((part) => part !== null);
  const options = fieldOptions(field).map((option, index) => ({
    value: optionValue(field, index),
    label: option.label
  }));
  if (canSkip(field)) {
    options.push({ value: skipValue(field), label: "Skip" });
  }
  const freeText = field.kind === "text" || field.kind === "number";
  return {
    id: field.questionId,
    prompt: parts.join(" "),
    shortLabel: field.label,
    multiSelect: field.kind === "multi",
    ...options.length > 0 ? { options } : {},
    allowFreeText: freeText
  };
}
function introFor(request) {
  return `The ${request.serverName} MCP server asks: ${request.message.trim()}`;
}
function buildPayload(args) {
  if (args.form.confirmOnly) {
    return {
      kind: "user_question",
      questions: [
        {
          id: CONFIRM_QUESTION_ID,
          prompt: introFor(args.request),
          shortLabel: args.request.serverName,
          multiSelect: false,
          options: [
            { value: CONFIRM_ACCEPT_VALUE, label: "Continue" },
            { value: CONFIRM_DECLINE_VALUE, label: "Decline" }
          ],
          allowFreeText: false
        }
      ]
    };
  }
  return {
    kind: "user_question",
    questions: args.form.fields.map(
      (field, index) => questionFor({
        field,
        intro: index === 0 ? introFor(args.request) : null,
        error: args.errors.get(field.questionId) ?? null
      })
    )
  };
}
function codePointLength(value) {
  return [...value].length;
}
var DECIMAL_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
var EMAIL = /^[a-z0-9_%+-]+(?:\.[a-z0-9_%+-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
var WEB_URL = /^https?:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?(?:\/(?:[a-z0-9\-._~!$&'()*+,;=:@]|%[0-9a-f]{2})*)*(?:\?(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?(?:#(?:[a-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9a-f]{2})*)?$/i;
var DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
var DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(?:Z|[+-](\d{2}):(\d{2}))$/i;
var DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function isValidDate(year, month, day) {
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (dayNumber < 1) {
    return false;
  }
  const leapYear = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const daysInMonth = monthNumber === 2 && leapYear ? 29 : DAYS_IN_MONTH[monthNumber - 1] ?? 0;
  return dayNumber <= daysInMonth;
}
function formatError(format2, value) {
  switch (format2) {
    case "email":
      return EMAIL.test(value) ? null : "Enter an email address";
    case "uri":
      return WEB_URL.test(value) ? null : "Enter a web address starting with http:// or https://";
    case "date": {
      const match = DATE.exec(value);
      return match !== null && isValidDate(match[1], match[2], match[3]) ? null : "Enter a date as YYYY-MM-DD";
    }
    case "date-time": {
      const match = DATE_TIME.exec(value);
      return match !== null && isValidDate(match[1], match[2], match[3]) && Number(match[4]) < 24 && Number(match[5]) < 60 && Number(match[6]) < 60 && Number(match[7] ?? 0) < 24 && Number(match[8] ?? 0) < 60 ? null : "Enter a date and time as YYYY-MM-DDTHH:MM:SSZ, or with an offset such as +02:00";
    }
  }
}
function selectedOptionIndexes(field, selected) {
  const options = fieldOptions(field);
  const indexes = [];
  for (const value of selected) {
    const index = options.findIndex(
      (_option, optionIndex) => optionValue(field, optionIndex) === value
    );
    if (index < 0) {
      return null;
    }
    indexes.push(index);
  }
  return indexes;
}
function readField(field, answer) {
  if (answer === void 0) {
    return field.required ? { kind: "error", message: `${field.label} needs an answer` } : { kind: "skip" };
  }
  const freeText = answer.freeText?.trim() ?? "";
  const skipped = answer.selected.includes(skipValue(field));
  if (skipped) {
    return answer.selected.length === 1 && freeText.length === 0 && canSkip(field) ? { kind: "skip" } : { kind: "error", message: `Choose Skip on its own for ${field.label}` };
  }
  switch (field.kind) {
    case "text": {
      if (answer.selected.length > 0 || freeText.length === 0) {
        return { kind: "error", message: `Type an answer for ${field.label}` };
      }
      const length = codePointLength(freeText);
      if (field.minLength !== null && length < field.minLength) {
        return {
          kind: "error",
          message: `${field.label} needs at least ${field.minLength} characters`
        };
      }
      if (field.maxLength !== null && length > field.maxLength) {
        return {
          kind: "error",
          message: `${field.label} allows at most ${field.maxLength} characters`
        };
      }
      const invalidFormat = field.format === null ? null : formatError(field.format, freeText);
      return invalidFormat === null ? { kind: "value", value: freeText } : { kind: "error", message: `${invalidFormat} for ${field.label}` };
    }
    case "number": {
      const number = Number(freeText);
      if (answer.selected.length > 0 || !DECIMAL_NUMBER.test(freeText) || !Number.isFinite(number) || field.integer && !Number.isSafeInteger(number) || field.minimum !== null && number < field.minimum || field.maximum !== null && number > field.maximum) {
        return {
          kind: "error",
          message: `${field.label} must be ${describeNumberRange(field)}`
        };
      }
      return { kind: "value", value: number };
    }
    case "boolean":
    case "single": {
      const indexes = selectedOptionIndexes(field, answer.selected);
      if (indexes === null || indexes.length !== 1 || freeText.length > 0) {
        return {
          kind: "error",
          message: `Choose one answer for ${field.label}`
        };
      }
      const index = indexes[0];
      if (field.kind === "boolean") {
        return { kind: "value", value: index === 0 };
      }
      return { kind: "value", value: field.options[index].value };
    }
    case "multi": {
      const indexes = selectedOptionIndexes(field, answer.selected);
      if (indexes === null || freeText.length > 0 || indexes.length === 0) {
        return {
          kind: "error",
          message: `Choose from the list for ${field.label}`
        };
      }
      if (field.minItems !== null && indexes.length < field.minItems) {
        return {
          kind: "error",
          message: `Choose at least ${field.minItems} for ${field.label}`
        };
      }
      if (field.maxItems !== null && indexes.length > field.maxItems) {
        return {
          kind: "error",
          message: `Choose at most ${field.maxItems} for ${field.label}`
        };
      }
      return {
        kind: "value",
        value: [...new Set(indexes)].map(
          (index) => field.options[index].value
        )
      };
    }
  }
}
function readForm(form, answers) {
  if (form.confirmOnly) {
    const selected = answers.get(CONFIRM_QUESTION_ID)?.selected ?? [];
    if (selected.length === 1 && selected[0] === CONFIRM_ACCEPT_VALUE) {
      return { kind: "accept", content: {} };
    }
    if (selected.length === 1 && selected[0] === CONFIRM_DECLINE_VALUE) {
      return { kind: "decline" };
    }
    return {
      kind: "retry",
      errors: /* @__PURE__ */ new Map([[CONFIRM_QUESTION_ID, "Choose Continue or Decline"]])
    };
  }
  const errors = /* @__PURE__ */ new Map();
  const content = [];
  for (const field of form.fields) {
    const reading = readField(field, answers.get(field.questionId));
    if (reading.kind === "error") {
      errors.set(field.questionId, reading.message);
    } else if (reading.kind === "value") {
      content.push([field.key, reading.value]);
    }
  }
  if (errors.size > 0) {
    return { kind: "retry", errors };
  }
  return { kind: "accept", content: Object.fromEntries(content) };
}
async function runMcpElicitation(args) {
  const { request } = args;
  if (request.mode !== void 0 && request.mode !== "form") {
    return {
      action: "decline",
      reason: `bb does not support ${request.mode} MCP elicitations`
    };
  }
  let form;
  try {
    form = parseElicitationForm(request.requestedSchema);
  } catch (error) {
    if (error instanceof UnsupportedElicitationError) {
      return {
        action: "decline",
        reason: `bb cannot show this MCP form: ${error.message}`
      };
    }
    throw error;
  }
  if (request.message.trim().length === 0) {
    return { action: "decline", reason: "the MCP form has no message" };
  }
  let errors = /* @__PURE__ */ new Map();
  for (let attempt = 1; attempt <= MCP_ELICITATION_MAX_ATTEMPTS; attempt += 1) {
    if (args.signal?.aborted) {
      return { action: "cancel", reason: "the request was cancelled" };
    }
    let resolution;
    try {
      resolution = await args.ask(buildPayload({ request, form, errors }));
    } catch (error) {
      return {
        action: "cancel",
        reason: error instanceof Error ? error.message : String(error)
      };
    }
    const parsed = userQuestionPendingInteractionResolutionSchema.safeParse(resolution);
    if (!parsed.success) {
      return { action: "cancel", reason: "the answer was not a form answer" };
    }
    const reading = readForm(
      form,
      new Map(Object.entries(parsed.data.answers))
    );
    if (reading.kind === "accept") {
      return { action: "accept", content: reading.content };
    }
    if (reading.kind === "decline") {
      return { action: "decline", reason: "the user declined" };
    }
    errors = reading.errors;
  }
  return {
    action: "cancel",
    reason: `the answers were still invalid after ${MCP_ELICITATION_MAX_ATTEMPTS} attempts`
  };
}

// ../provider-bridge-protocol/src/bridge-kit/mime-types.ts
import { extname } from "node:path";
function mimeTypeFromExtension(filePath) {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}

// ../provider-bridge-protocol/src/bridge-kit/pending-tool-call-tracker.ts
function createPendingToolCallTracker(options) {
  const pendingToolCalls = /* @__PURE__ */ new Map();
  let requestIdCounter = 0;
  return {
    forwardToolCall: (args) => {
      return new Promise((resolve2) => {
        requestIdCounter += 1;
        const requestId = requestIdCounter;
        pendingToolCalls.set(requestId, { resolve: resolve2, scope: args.scope });
        try {
          options.sendToolCall({
            jsonrpc: "2.0",
            id: requestId,
            method: "item/tool/call",
            params: {
              threadId: args.threadId,
              providerThreadId: args.providerThreadId,
              turnId: null,
              callId: `call-${requestId}`,
              tool: args.toolName,
              arguments: args.arguments
            }
          });
        } catch (error) {
          pendingToolCalls.delete(requestId);
          resolve2({
            content: error instanceof Error ? error.message : String(error),
            isError: true
          });
        }
      });
    },
    handleToolCallResponse: (response) => {
      const pending = pendingToolCalls.get(response.id);
      if (!pending) {
        return false;
      }
      pendingToolCalls.delete(response.id);
      if ("error" in response) {
        pending.resolve({
          content: response.error.message ?? "Tool call failed",
          isError: true
        });
      } else {
        pending.resolve(decodeToolCallResponsePayload(response.result));
      }
      return true;
    },
    resolvePendingToolCalls: (scope, message) => {
      for (const [requestId, pending] of pendingToolCalls) {
        if (pending.scope !== scope) {
          continue;
        }
        pendingToolCalls.delete(requestId);
        pending.resolve({ content: message, isError: true });
      }
    }
  };
}

// ../provider-bridge-protocol/src/bridge-kit/permission-policy.ts
function shouldAutoDenyInteractiveRequest(policy) {
  return policy.permissionEscalation === "deny";
}

// ../text-utils/src/utf16.ts
function isHighSurrogateAt(value, index) {
  const code = value.charCodeAt(index);
  return code >= 55296 && code <= 56319;
}
function isLowSurrogateAt(value, index) {
  const code = value.charCodeAt(index);
  return code >= 56320 && code <= 57343;
}
function sliceUtf16Head(value, maxChars) {
  let end = Math.min(value.length, Math.max(0, maxChars));
  if (isHighSurrogateAt(value, end - 1) && isLowSurrogateAt(value, end)) {
    end -= 1;
  }
  return value.slice(0, end);
}

// ../provider-bridge-protocol/src/bridge-kit/presentation.ts
var PRESENTATION_TITLE_MAX_LENGTH = 160;
function presentationTitle(text) {
  const firstLine2 = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine2.length === 0) {
    return void 0;
  }
  return firstLine2.length > PRESENTATION_TITLE_MAX_LENGTH ? `${sliceUtf16Head(firstLine2, PRESENTATION_TITLE_MAX_LENGTH - 1)}\u2026` : firstLine2;
}
function presentationDetail(text) {
  return text.length > THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH ? `${sliceUtf16Head(text, THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH - 1)}\u2026` : text;
}
function withTitle(presentation, title) {
  return title === void 0 ? presentation : { ...presentation, title };
}
function presentationFileName(path9) {
  const segments = path9.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path9;
}
var COMPACTION_PRESENTATION = {
  label: { pending: "Compacting context", completed: "Compacted context" },
  icon: { glyph: "Archive" }
};
var REASONING_PRESENTATION = {
  label: { pending: "Thinking", completed: "Thought" },
  icon: { glyph: "Brain" }
};
function fileReadPresentation(path9) {
  return withTitle(
    {
      label: { pending: "Reading file", completed: "Read file" },
      icon: { glyph: "FileText" }
    },
    presentationTitle(presentationFileName(path9))
  );
}
function searchPresentation(args) {
  return withTitle(
    args.mode === "content" ? {
      label: { pending: "Searching files", completed: "Searched files" },
      icon: { glyph: "Search" }
    } : {
      label: { pending: "Finding files", completed: "Found files" },
      icon: { glyph: "FolderOpen" }
    },
    presentationTitle(args.query)
  );
}
function webSearchPresentation(query) {
  return withTitle(
    {
      label: { pending: "Searching the web", completed: "Searched the web" },
      icon: { glyph: "Globe" }
    },
    query === void 0 ? void 0 : presentationTitle(query)
  );
}
function webFetchPresentation(url) {
  return withTitle(
    {
      label: { pending: "Fetching page", completed: "Fetched page" },
      icon: { glyph: "Browser" }
    },
    presentationTitle(url)
  );
}
function planStepsPresentation(steps) {
  const active = steps.find((step) => step.status === "active");
  return withTitle(
    {
      label: { pending: "Updating plan", completed: "Updated plan" },
      icon: { glyph: "ListTodo" },
      suppress: true
    },
    active === void 0 ? void 0 : presentationTitle(active.step)
  );
}
function toolPresentation(tool) {
  return {
    label: { pending: `Running ${tool}`, completed: `Ran ${tool}` },
    icon: { glyph: "Toolbox" }
  };
}

// ../provider-bridge-protocol/src/bridge-kit/provider-bridge-entry.ts
var PROVIDER_BRIDGE_EXPORT_NAME = "experimental_providerBridge";
function experimental_defineProviderBridge(definition) {
  return { experimental_apiVersion: 1, ...definition };
}

// ../process-utils/src/spawn.ts
import crossSpawn from "cross-spawn";
function spawnPortableProcess(request) {
  return crossSpawn(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide: true
  });
}

// ../process-utils/src/windows-process-tree.ts
import { execFile } from "node:child_process";
import path from "node:path";
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
function terminateWindowsProcessTrees(pids) {
  if (pids.length === 0) return Promise.resolve(true);
  return new Promise((resolve2) => {
    let timer;
    let killer;
    let settled = false;
    const finish = (terminated) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2(terminated);
    };
    try {
      killer = execFile(
        path.join(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe"
        ),
        [...pids.flatMap((pid) => ["/pid", String(pid)]), "/T", "/F"],
        { windowsHide: true },
        (error) => finish(error === null)
      );
      timer = setTimeout(() => {
        finish(false);
        try {
          killer?.kill("SIGKILL");
        } catch {
        }
      }, 2e3);
    } catch {
      finish(false);
    }
  });
}
function waitForRootExit(child) {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolve2, reject) => {
    const onExit2 = () => {
      clearTimeout(timer);
      resolve2();
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit2);
      reject(new Error(`Process did not exit after termination: ${child.pid}`));
    }, 1e3);
    child.once("exit", onExit2);
  });
}
async function stopWindowsProcessTree(child) {
  if (child.pid === void 0 || hasExited(child)) {
    return { treeTermination: "unverified" };
  }
  const terminated = await terminateWindowsProcessTrees([child.pid]);
  if (!hasExited(child)) child.kill("SIGKILL");
  await waitForRootExit(child);
  return { treeTermination: terminated ? "confirmed" : "unverified" };
}

// ../process-utils/src/process-group.ts
function supportsProcessGroups() {
  return process.platform !== "win32";
}
function killProcessGroup(args) {
  if (supportsProcessGroups() && args.child.pid !== void 0) {
    try {
      process.kill(-args.child.pid, args.signal);
      return;
    } catch {
    }
  }
  args.child.kill(args.signal);
}
function killPortableProcess(child, signal) {
  if (process.platform === "win32") {
    stopWindowsProcessTree(child).catch(() => void 0);
    return;
  }
  child.kill(signal);
}
function isProcessGroupAlive(child) {
  if (!supportsProcessGroups() || child.pid === void 0) {
    return false;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
var PROCESS_GROUP_EXIT_POLL_MS = 100;
function stopProcessGroupLeaderFirst(args) {
  const { child, timeoutMs, killGraceMs } = args;
  if (process.platform === "win32") return stopWindowsProcessTree(child);
  if (hasChildExited(child) && !isProcessGroupAlive(child)) {
    return Promise.resolve({ treeTermination: "confirmed" });
  }
  return new Promise((resolveStop) => {
    let settled = false;
    let hardTimer;
    let poll;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      child.off("exit", stopSurvivingMembers);
      clearTimeout(softTimer);
      if (hardTimer !== void 0) {
        clearTimeout(hardTimer);
      }
      if (poll !== void 0) {
        clearInterval(poll);
      }
      resolveStop({
        treeTermination: groupGone() ? "confirmed" : "unverified"
      });
    };
    const groupGone = () => hasChildExited(child) && !isProcessGroupAlive(child);
    const softTimer = setTimeout(() => {
      if (groupGone()) {
        finish();
        return;
      }
      killProcessGroup({ child, signal: "SIGKILL" });
      if (killGraceMs <= 0) {
        finish();
        return;
      }
      hardTimer = setTimeout(finish, killGraceMs);
    }, timeoutMs);
    const stopSurvivingMembers = () => {
      if (!isProcessGroupAlive(child)) {
        finish();
        return;
      }
      killProcessGroup({ child, signal: "SIGTERM" });
      poll = setInterval(() => {
        if (!isProcessGroupAlive(child)) {
          finish();
        }
      }, PROCESS_GROUP_EXIT_POLL_MS);
    };
    if (hasChildExited(child)) {
      stopSurvivingMembers();
      return;
    }
    child.once("exit", stopSurvivingMembers);
    child.kill("SIGTERM");
  });
}

// ../process-utils/src/managed-process.ts
function createProcessStop(child) {
  let stopping;
  return function stop({ gracePeriodMs } = { gracePeriodMs: 1e3 }) {
    stopping ??= (async () => {
      if (child.pid === void 0) {
        return { treeTermination: "confirmed" };
      }
      const result = await stopProcessGroupLeaderFirst({
        child,
        timeoutMs: gracePeriodMs,
        killGraceMs: 1e3
      });
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`Process did not exit after termination: ${child.pid}`);
      }
      return result;
    })();
    return stopping;
  };
}

// ../../node_modules/.pnpm/is-plain-obj@4.1.0/node_modules/is-plain-obj/index.js
function isPlainObject2(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (prototype === null || prototype === Object.prototype || Object.getPrototypeOf(prototype) === null) && !(Symbol.toStringTag in value) && !(Symbol.iterator in value);
}

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/file-url.js
import { fileURLToPath } from "node:url";
var safeNormalizeFileUrl = (file, name) => {
  const fileString = normalizeFileUrl(normalizeDenoExecPath(file));
  if (typeof fileString !== "string") {
    throw new TypeError(`${name} must be a string or a file URL: ${fileString}.`);
  }
  return fileString;
};
var normalizeDenoExecPath = (file) => isDenoExecPath(file) ? file.toString() : file;
var isDenoExecPath = (file) => typeof file !== "string" && file && Object.getPrototypeOf(file) === String.prototype;
var normalizeFileUrl = (file) => file instanceof URL ? fileURLToPath(file) : file;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/parameters.js
var normalizeParameters = (rawFile, rawArguments = [], rawOptions = {}) => {
  const filePath = safeNormalizeFileUrl(rawFile, "First argument");
  const [commandArguments, options] = isPlainObject2(rawArguments) ? [[], rawArguments] : [rawArguments, rawOptions];
  if (!Array.isArray(commandArguments)) {
    throw new TypeError(`Second argument must be either an array of arguments or an options object: ${commandArguments}`);
  }
  if (commandArguments.some((commandArgument) => typeof commandArgument === "object" && commandArgument !== null)) {
    throw new TypeError(`Second argument must be an array of strings: ${commandArguments}`);
  }
  const normalizedArguments = commandArguments.map(String);
  const nullByteArgument = normalizedArguments.find((normalizedArgument) => normalizedArgument.includes("\0"));
  if (nullByteArgument !== void 0) {
    throw new TypeError(`Arguments cannot contain null bytes ("\\0"): ${nullByteArgument}`);
  }
  if (!isPlainObject2(options)) {
    throw new TypeError(`Last argument must be an options object: ${options}`);
  }
  return [filePath, normalizedArguments, options];
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/template.js
import { ChildProcess } from "node:child_process";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/utils/uint-array.js
import { StringDecoder as StringDecoder3 } from "node:string_decoder";
var { toString: objectToString } = Object.prototype;
var isArrayBuffer = (value) => objectToString.call(value) === "[object ArrayBuffer]";
var isUint8Array = (value) => objectToString.call(value) === "[object Uint8Array]";
var bufferToUint8Array = (buffer) => new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
var textEncoder = new TextEncoder();
var stringToUint8Array = (string) => textEncoder.encode(string);
var textDecoder = new TextDecoder();
var uint8ArrayToString = (uint8Array) => textDecoder.decode(uint8Array);
var joinToString = (uint8ArraysOrStrings, encoding) => {
  const strings = uint8ArraysToStrings(uint8ArraysOrStrings, encoding);
  return strings.join("");
};
var uint8ArraysToStrings = (uint8ArraysOrStrings, encoding) => {
  if (encoding === "utf8" && uint8ArraysOrStrings.every((uint8ArrayOrString) => typeof uint8ArrayOrString === "string")) {
    return uint8ArraysOrStrings;
  }
  const decoder = new StringDecoder3(encoding);
  const strings = uint8ArraysOrStrings.map((uint8ArrayOrString) => typeof uint8ArrayOrString === "string" ? stringToUint8Array(uint8ArrayOrString) : uint8ArrayOrString).map((uint8Array) => decoder.write(uint8Array));
  const finalString = decoder.end();
  return finalString === "" ? strings : [...strings, finalString];
};
var joinToUint8Array = (uint8ArraysOrStrings) => {
  if (uint8ArraysOrStrings.length === 1 && isUint8Array(uint8ArraysOrStrings[0])) {
    return uint8ArraysOrStrings[0];
  }
  return concatUint8Arrays(stringsToUint8Arrays(uint8ArraysOrStrings));
};
var stringsToUint8Arrays = (uint8ArraysOrStrings) => uint8ArraysOrStrings.map((uint8ArrayOrString) => typeof uint8ArrayOrString === "string" ? stringToUint8Array(uint8ArrayOrString) : uint8ArrayOrString);
var concatUint8Arrays = (uint8Arrays) => {
  const result = new Uint8Array(getJoinLength(uint8Arrays));
  let index = 0;
  for (const uint8Array of uint8Arrays) {
    result.set(uint8Array, index);
    index += uint8Array.length;
  }
  return result;
};
var getJoinLength = (uint8Arrays) => {
  let joinLength = 0;
  for (const uint8Array of uint8Arrays) {
    joinLength += uint8Array.length;
  }
  return joinLength;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/template.js
var isTemplateString = (templates) => Array.isArray(templates) && Array.isArray(templates.raw);
var parseTemplates = (templates, expressions) => {
  let tokens = [];
  for (const [index, template] of templates.entries()) {
    tokens = parseTemplate({
      templates,
      expressions,
      tokens,
      index,
      template
    });
  }
  if (tokens.length === 0) {
    throw new TypeError("Template script must not be empty");
  }
  const [file, ...commandArguments] = tokens;
  return [file, commandArguments, {}];
};
var parseTemplate = ({ templates, expressions, tokens, index, template }) => {
  if (template === void 0) {
    throw new TypeError(`Invalid backslash sequence: ${templates.raw[index]}`);
  }
  const { nextTokens, leadingWhitespaces, trailingWhitespaces } = splitByWhitespaces(template, templates.raw[index]);
  const newTokens = concatTokens(tokens, nextTokens, leadingWhitespaces);
  if (index === expressions.length) {
    return newTokens;
  }
  const expression = expressions[index];
  const expressionTokens = Array.isArray(expression) ? expression.map((expression2) => parseExpression(expression2)) : [parseExpression(expression)];
  return concatTokens(newTokens, expressionTokens, trailingWhitespaces);
};
var splitByWhitespaces = (template, rawTemplate) => {
  if (rawTemplate.length === 0) {
    return { nextTokens: [], leadingWhitespaces: false, trailingWhitespaces: false };
  }
  const nextTokens = [];
  let templateStart = 0;
  const leadingWhitespaces = DELIMITERS.has(rawTemplate[0]);
  for (let templateIndex = 0, rawIndex = 0; templateIndex < template.length; templateIndex += 1, rawIndex += 1) {
    const rawCharacter = rawTemplate[rawIndex];
    if (DELIMITERS.has(rawCharacter)) {
      if (templateStart !== templateIndex) {
        nextTokens.push(template.slice(templateStart, templateIndex));
      }
      templateStart = templateIndex + 1;
    } else if (rawCharacter === "\\") {
      const nextRawCharacter = rawTemplate[rawIndex + 1];
      if (nextRawCharacter === "\n") {
        templateIndex -= 1;
        rawIndex += 1;
      } else if (nextRawCharacter === "u" && rawTemplate[rawIndex + 2] === "{") {
        rawIndex = rawTemplate.indexOf("}", rawIndex + 3);
      } else {
        rawIndex += ESCAPE_LENGTH[nextRawCharacter] ?? 1;
      }
    }
  }
  const trailingWhitespaces = templateStart === template.length;
  if (!trailingWhitespaces) {
    nextTokens.push(template.slice(templateStart));
  }
  return { nextTokens, leadingWhitespaces, trailingWhitespaces };
};
var DELIMITERS = /* @__PURE__ */ new Set([" ", "	", "\r", "\n"]);
var ESCAPE_LENGTH = { x: 3, u: 5 };
var concatTokens = (tokens, nextTokens, isSeparated) => isSeparated || tokens.length === 0 || nextTokens.length === 0 ? [...tokens, ...nextTokens] : [
  ...tokens.slice(0, -1),
  `${tokens.at(-1)}${nextTokens[0]}`,
  ...nextTokens.slice(1)
];
var parseExpression = (expression) => {
  const typeOfExpression = typeof expression;
  if (typeOfExpression === "string") {
    return expression;
  }
  if (typeOfExpression === "number") {
    return String(expression);
  }
  if (isPlainObject2(expression) && ("stdout" in expression || "isMaxBuffer" in expression)) {
    return getSubprocessResult(expression);
  }
  if (expression instanceof ChildProcess || Object.prototype.toString.call(expression) === "[object Promise]") {
    throw new TypeError("Unexpected subprocess in template expression. Please use ${await subprocess} instead of ${subprocess}.");
  }
  throw new TypeError(`Unexpected "${typeOfExpression}" in template expression`);
};
var getSubprocessResult = ({ stdout }) => {
  if (typeof stdout === "string") {
    return stdout;
  }
  if (isUint8Array(stdout)) {
    return uint8ArrayToString(stdout);
  }
  if (stdout === void 0) {
    throw new TypeError(`Missing result.stdout in template expression. This is probably due to the previous subprocess' "stdout" option.`);
  }
  throw new TypeError(`Unexpected "${typeof stdout}" stdout in template expression`);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/main-sync.js
import { spawnSync } from "node:child_process";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/specific.js
import { debuglog } from "node:util";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/utils/standard-stream.js
import process2 from "node:process";
var isStandardStream = (stream) => STANDARD_STREAMS.includes(stream);
var STANDARD_STREAMS = [process2.stdin, process2.stdout, process2.stderr];
var STANDARD_STREAMS_ALIASES = ["stdin", "stdout", "stderr"];
var getStreamName = (fdNumber) => STANDARD_STREAMS_ALIASES[fdNumber] ?? `stdio[${fdNumber}]`;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/specific.js
var normalizeFdSpecificOptions = (options) => {
  const optionsCopy = { ...options };
  for (const optionName of FD_SPECIFIC_OPTIONS) {
    optionsCopy[optionName] = normalizeFdSpecificOption(options, optionName);
  }
  return optionsCopy;
};
var normalizeFdSpecificOption = (options, optionName) => {
  const optionBaseArray = Array.from({ length: getStdioLength(options) + 1 });
  const optionArray = normalizeFdSpecificValue(options[optionName], optionBaseArray, optionName);
  return addDefaultValue(optionArray, optionName);
};
var getStdioLength = ({ stdio }) => Array.isArray(stdio) ? Math.max(stdio.length, STANDARD_STREAMS_ALIASES.length) : STANDARD_STREAMS_ALIASES.length;
var normalizeFdSpecificValue = (optionValue2, optionArray, optionName) => isPlainObject2(optionValue2) ? normalizeOptionObject(optionValue2, optionArray, optionName) : optionArray.fill(optionValue2);
var normalizeOptionObject = (optionValue2, optionArray, optionName) => {
  for (const fdName of Object.keys(optionValue2).sort(compareFdName)) {
    for (const fdNumber of parseFdName(fdName, optionName, optionArray)) {
      optionArray[fdNumber] = optionValue2[fdName];
    }
  }
  return optionArray;
};
var compareFdName = (fdNameA, fdNameB) => getFdNameOrder(fdNameA) < getFdNameOrder(fdNameB) ? 1 : -1;
var getFdNameOrder = (fdName) => {
  if (fdName === "stdout" || fdName === "stderr") {
    return 0;
  }
  return fdName === "all" ? 2 : 1;
};
var parseFdName = (fdName, optionName, optionArray) => {
  if (fdName === "ipc") {
    return [optionArray.length - 1];
  }
  const fdNumber = parseFd(fdName);
  if (fdNumber === void 0 || fdNumber === 0) {
    throw new TypeError(`"${optionName}.${fdName}" is invalid.
It must be "${optionName}.stdout", "${optionName}.stderr", "${optionName}.all", "${optionName}.ipc", or "${optionName}.fd3", "${optionName}.fd4" (and so on).`);
  }
  if (fdNumber >= optionArray.length) {
    throw new TypeError(`"${optionName}.${fdName}" is invalid: that file descriptor does not exist.
Please set the "stdio" option to ensure that file descriptor exists.`);
  }
  return fdNumber === "all" ? [1, 2] : [fdNumber];
};
var parseFd = (fdName) => {
  if (fdName === "all") {
    return fdName;
  }
  if (STANDARD_STREAMS_ALIASES.includes(fdName)) {
    return STANDARD_STREAMS_ALIASES.indexOf(fdName);
  }
  const regexpResult = FD_REGEXP.exec(fdName);
  if (regexpResult !== null) {
    return Number(regexpResult[1]);
  }
};
var FD_REGEXP = /^fd(\d+)$/;
var addDefaultValue = (optionArray, optionName) => optionArray.map((optionValue2) => optionValue2 === void 0 ? DEFAULT_OPTIONS[optionName] : optionValue2);
var verboseDefault = debuglog("execa").enabled ? "full" : "none";
var DEFAULT_OPTIONS = {
  lines: false,
  buffer: true,
  maxBuffer: 1e3 * 1e3 * 100,
  verbose: verboseDefault,
  stripFinalNewline: true
};
var FD_SPECIFIC_OPTIONS = ["lines", "buffer", "maxBuffer", "verbose", "stripFinalNewline"];
var getFdSpecificValue = (optionArray, fdNumber) => fdNumber === "ipc" ? optionArray.at(-1) : optionArray[fdNumber];

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/values.js
var isVerbose = ({ verbose }, fdNumber) => getFdVerbose(verbose, fdNumber) !== "none";
var isFullVerbose = ({ verbose }, fdNumber) => !["none", "short"].includes(getFdVerbose(verbose, fdNumber));
var getVerboseFunction = ({ verbose }, fdNumber) => {
  const fdVerbose = getFdVerbose(verbose, fdNumber);
  return isVerboseFunction(fdVerbose) ? fdVerbose : void 0;
};
var getFdVerbose = (verbose, fdNumber) => fdNumber === void 0 ? getFdGenericVerbose(verbose) : getFdSpecificValue(verbose, fdNumber);
var getFdGenericVerbose = (verbose) => verbose.find((fdVerbose) => isVerboseFunction(fdVerbose)) ?? VERBOSE_VALUES.findLast((fdVerbose) => verbose.includes(fdVerbose));
var isVerboseFunction = (fdVerbose) => typeof fdVerbose === "function";
var VERBOSE_VALUES = ["none", "short", "full"];

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/log.js
import { inspect } from "node:util";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/escape.js
import { platform } from "node:process";
import { stripVTControlCharacters } from "node:util";
var joinCommand = (filePath, rawArguments) => {
  const fileAndArguments = [filePath, ...rawArguments];
  const command = fileAndArguments.join(" ");
  const escapedCommand = fileAndArguments.map((fileAndArgument) => quoteString(escapeControlCharacters(fileAndArgument))).join(" ");
  return { command, escapedCommand };
};
var escapeLines = (lines) => stripVTControlCharacters(lines).split("\n").map((line) => escapeControlCharacters(line)).join("\n");
var escapeControlCharacters = (line) => line.replaceAll(SPECIAL_CHAR_REGEXP, (character) => escapeControlCharacter(character));
var escapeControlCharacter = (character) => {
  const commonEscape = COMMON_ESCAPES[character];
  if (commonEscape !== void 0) {
    return commonEscape;
  }
  const codepoint = character.codePointAt(0);
  const codepointHex = codepoint.toString(16);
  return codepoint <= ASTRAL_START ? `\\u${codepointHex.padStart(4, "0")}` : `\\U${codepointHex}`;
};
var getSpecialCharRegExp = () => {
  try {
    return new RegExp("\\p{Separator}|\\p{Other}", "gu");
  } catch {
    return /[\s\u0000-\u001F\u007F-\u009F\u00AD]/g;
  }
};
var SPECIAL_CHAR_REGEXP = getSpecialCharRegExp();
var COMMON_ESCAPES = {
  " ": " ",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "	": "\\t"
};
var ASTRAL_START = 65535;
var quoteString = (escapedArgument) => {
  if (NO_ESCAPE_REGEXP.test(escapedArgument)) {
    return escapedArgument;
  }
  return platform === "win32" ? `"${escapedArgument.replaceAll('"', '""')}"` : `'${escapedArgument.replaceAll("'", "'\\''")}'`;
};
var NO_ESCAPE_REGEXP = /^[\w./-]+$/;

// ../../node_modules/.pnpm/is-unicode-supported@2.1.0/node_modules/is-unicode-supported/index.js
import process3 from "node:process";
function isUnicodeSupported() {
  const { env } = process3;
  const { TERM, TERM_PROGRAM } = env;
  if (process3.platform !== "win32") {
    return TERM !== "linux";
  }
  return Boolean(env.WT_SESSION) || Boolean(env.TERMINUS_SUBLIME) || env.ConEmuTask === "{cmd::Cmder}" || TERM_PROGRAM === "Terminus-Sublime" || TERM_PROGRAM === "vscode" || TERM === "xterm-256color" || TERM === "alacritty" || TERM === "rxvt-unicode" || TERM === "rxvt-unicode-256color" || env.TERMINAL_EMULATOR === "JetBrains-JediTerm";
}

// ../../node_modules/.pnpm/figures@6.1.0/node_modules/figures/index.js
var common = {
  circleQuestionMark: "(?)",
  questionMarkPrefix: "(?)",
  square: "\u2588",
  squareDarkShade: "\u2593",
  squareMediumShade: "\u2592",
  squareLightShade: "\u2591",
  squareTop: "\u2580",
  squareBottom: "\u2584",
  squareLeft: "\u258C",
  squareRight: "\u2590",
  squareCenter: "\u25A0",
  bullet: "\u25CF",
  dot: "\u2024",
  ellipsis: "\u2026",
  pointerSmall: "\u203A",
  triangleUp: "\u25B2",
  triangleUpSmall: "\u25B4",
  triangleDown: "\u25BC",
  triangleDownSmall: "\u25BE",
  triangleLeftSmall: "\u25C2",
  triangleRightSmall: "\u25B8",
  home: "\u2302",
  heart: "\u2665",
  musicNote: "\u266A",
  musicNoteBeamed: "\u266B",
  arrowUp: "\u2191",
  arrowDown: "\u2193",
  arrowLeft: "\u2190",
  arrowRight: "\u2192",
  arrowLeftRight: "\u2194",
  arrowUpDown: "\u2195",
  almostEqual: "\u2248",
  notEqual: "\u2260",
  lessOrEqual: "\u2264",
  greaterOrEqual: "\u2265",
  identical: "\u2261",
  infinity: "\u221E",
  subscriptZero: "\u2080",
  subscriptOne: "\u2081",
  subscriptTwo: "\u2082",
  subscriptThree: "\u2083",
  subscriptFour: "\u2084",
  subscriptFive: "\u2085",
  subscriptSix: "\u2086",
  subscriptSeven: "\u2087",
  subscriptEight: "\u2088",
  subscriptNine: "\u2089",
  oneHalf: "\xBD",
  oneThird: "\u2153",
  oneQuarter: "\xBC",
  oneFifth: "\u2155",
  oneSixth: "\u2159",
  oneEighth: "\u215B",
  twoThirds: "\u2154",
  twoFifths: "\u2156",
  threeQuarters: "\xBE",
  threeFifths: "\u2157",
  threeEighths: "\u215C",
  fourFifths: "\u2158",
  fiveSixths: "\u215A",
  fiveEighths: "\u215D",
  sevenEighths: "\u215E",
  line: "\u2500",
  lineBold: "\u2501",
  lineDouble: "\u2550",
  lineDashed0: "\u2504",
  lineDashed1: "\u2505",
  lineDashed2: "\u2508",
  lineDashed3: "\u2509",
  lineDashed4: "\u254C",
  lineDashed5: "\u254D",
  lineDashed6: "\u2574",
  lineDashed7: "\u2576",
  lineDashed8: "\u2578",
  lineDashed9: "\u257A",
  lineDashed10: "\u257C",
  lineDashed11: "\u257E",
  lineDashed12: "\u2212",
  lineDashed13: "\u2013",
  lineDashed14: "\u2010",
  lineDashed15: "\u2043",
  lineVertical: "\u2502",
  lineVerticalBold: "\u2503",
  lineVerticalDouble: "\u2551",
  lineVerticalDashed0: "\u2506",
  lineVerticalDashed1: "\u2507",
  lineVerticalDashed2: "\u250A",
  lineVerticalDashed3: "\u250B",
  lineVerticalDashed4: "\u254E",
  lineVerticalDashed5: "\u254F",
  lineVerticalDashed6: "\u2575",
  lineVerticalDashed7: "\u2577",
  lineVerticalDashed8: "\u2579",
  lineVerticalDashed9: "\u257B",
  lineVerticalDashed10: "\u257D",
  lineVerticalDashed11: "\u257F",
  lineDownLeft: "\u2510",
  lineDownLeftArc: "\u256E",
  lineDownBoldLeftBold: "\u2513",
  lineDownBoldLeft: "\u2512",
  lineDownLeftBold: "\u2511",
  lineDownDoubleLeftDouble: "\u2557",
  lineDownDoubleLeft: "\u2556",
  lineDownLeftDouble: "\u2555",
  lineDownRight: "\u250C",
  lineDownRightArc: "\u256D",
  lineDownBoldRightBold: "\u250F",
  lineDownBoldRight: "\u250E",
  lineDownRightBold: "\u250D",
  lineDownDoubleRightDouble: "\u2554",
  lineDownDoubleRight: "\u2553",
  lineDownRightDouble: "\u2552",
  lineUpLeft: "\u2518",
  lineUpLeftArc: "\u256F",
  lineUpBoldLeftBold: "\u251B",
  lineUpBoldLeft: "\u251A",
  lineUpLeftBold: "\u2519",
  lineUpDoubleLeftDouble: "\u255D",
  lineUpDoubleLeft: "\u255C",
  lineUpLeftDouble: "\u255B",
  lineUpRight: "\u2514",
  lineUpRightArc: "\u2570",
  lineUpBoldRightBold: "\u2517",
  lineUpBoldRight: "\u2516",
  lineUpRightBold: "\u2515",
  lineUpDoubleRightDouble: "\u255A",
  lineUpDoubleRight: "\u2559",
  lineUpRightDouble: "\u2558",
  lineUpDownLeft: "\u2524",
  lineUpBoldDownBoldLeftBold: "\u252B",
  lineUpBoldDownBoldLeft: "\u2528",
  lineUpDownLeftBold: "\u2525",
  lineUpBoldDownLeftBold: "\u2529",
  lineUpDownBoldLeftBold: "\u252A",
  lineUpDownBoldLeft: "\u2527",
  lineUpBoldDownLeft: "\u2526",
  lineUpDoubleDownDoubleLeftDouble: "\u2563",
  lineUpDoubleDownDoubleLeft: "\u2562",
  lineUpDownLeftDouble: "\u2561",
  lineUpDownRight: "\u251C",
  lineUpBoldDownBoldRightBold: "\u2523",
  lineUpBoldDownBoldRight: "\u2520",
  lineUpDownRightBold: "\u251D",
  lineUpBoldDownRightBold: "\u2521",
  lineUpDownBoldRightBold: "\u2522",
  lineUpDownBoldRight: "\u251F",
  lineUpBoldDownRight: "\u251E",
  lineUpDoubleDownDoubleRightDouble: "\u2560",
  lineUpDoubleDownDoubleRight: "\u255F",
  lineUpDownRightDouble: "\u255E",
  lineDownLeftRight: "\u252C",
  lineDownBoldLeftBoldRightBold: "\u2533",
  lineDownLeftBoldRightBold: "\u252F",
  lineDownBoldLeftRight: "\u2530",
  lineDownBoldLeftBoldRight: "\u2531",
  lineDownBoldLeftRightBold: "\u2532",
  lineDownLeftRightBold: "\u252E",
  lineDownLeftBoldRight: "\u252D",
  lineDownDoubleLeftDoubleRightDouble: "\u2566",
  lineDownDoubleLeftRight: "\u2565",
  lineDownLeftDoubleRightDouble: "\u2564",
  lineUpLeftRight: "\u2534",
  lineUpBoldLeftBoldRightBold: "\u253B",
  lineUpLeftBoldRightBold: "\u2537",
  lineUpBoldLeftRight: "\u2538",
  lineUpBoldLeftBoldRight: "\u2539",
  lineUpBoldLeftRightBold: "\u253A",
  lineUpLeftRightBold: "\u2536",
  lineUpLeftBoldRight: "\u2535",
  lineUpDoubleLeftDoubleRightDouble: "\u2569",
  lineUpDoubleLeftRight: "\u2568",
  lineUpLeftDoubleRightDouble: "\u2567",
  lineUpDownLeftRight: "\u253C",
  lineUpBoldDownBoldLeftBoldRightBold: "\u254B",
  lineUpDownBoldLeftBoldRightBold: "\u2548",
  lineUpBoldDownLeftBoldRightBold: "\u2547",
  lineUpBoldDownBoldLeftRightBold: "\u254A",
  lineUpBoldDownBoldLeftBoldRight: "\u2549",
  lineUpBoldDownLeftRight: "\u2540",
  lineUpDownBoldLeftRight: "\u2541",
  lineUpDownLeftBoldRight: "\u253D",
  lineUpDownLeftRightBold: "\u253E",
  lineUpBoldDownBoldLeftRight: "\u2542",
  lineUpDownLeftBoldRightBold: "\u253F",
  lineUpBoldDownLeftBoldRight: "\u2543",
  lineUpBoldDownLeftRightBold: "\u2544",
  lineUpDownBoldLeftBoldRight: "\u2545",
  lineUpDownBoldLeftRightBold: "\u2546",
  lineUpDoubleDownDoubleLeftDoubleRightDouble: "\u256C",
  lineUpDoubleDownDoubleLeftRight: "\u256B",
  lineUpDownLeftDoubleRightDouble: "\u256A",
  lineCross: "\u2573",
  lineBackslash: "\u2572",
  lineSlash: "\u2571"
};
var specialMainSymbols = {
  tick: "\u2714",
  info: "\u2139",
  warning: "\u26A0",
  cross: "\u2718",
  squareSmall: "\u25FB",
  squareSmallFilled: "\u25FC",
  circle: "\u25EF",
  circleFilled: "\u25C9",
  circleDotted: "\u25CC",
  circleDouble: "\u25CE",
  circleCircle: "\u24DE",
  circleCross: "\u24E7",
  circlePipe: "\u24BE",
  radioOn: "\u25C9",
  radioOff: "\u25EF",
  checkboxOn: "\u2612",
  checkboxOff: "\u2610",
  checkboxCircleOn: "\u24E7",
  checkboxCircleOff: "\u24BE",
  pointer: "\u276F",
  triangleUpOutline: "\u25B3",
  triangleLeft: "\u25C0",
  triangleRight: "\u25B6",
  lozenge: "\u25C6",
  lozengeOutline: "\u25C7",
  hamburger: "\u2630",
  smiley: "\u32E1",
  mustache: "\u0DF4",
  star: "\u2605",
  play: "\u25B6",
  nodejs: "\u2B22",
  oneSeventh: "\u2150",
  oneNinth: "\u2151",
  oneTenth: "\u2152"
};
var specialFallbackSymbols = {
  tick: "\u221A",
  info: "i",
  warning: "\u203C",
  cross: "\xD7",
  squareSmall: "\u25A1",
  squareSmallFilled: "\u25A0",
  circle: "( )",
  circleFilled: "(*)",
  circleDotted: "( )",
  circleDouble: "( )",
  circleCircle: "(\u25CB)",
  circleCross: "(\xD7)",
  circlePipe: "(\u2502)",
  radioOn: "(*)",
  radioOff: "( )",
  checkboxOn: "[\xD7]",
  checkboxOff: "[ ]",
  checkboxCircleOn: "(\xD7)",
  checkboxCircleOff: "( )",
  pointer: ">",
  triangleUpOutline: "\u2206",
  triangleLeft: "\u25C4",
  triangleRight: "\u25BA",
  lozenge: "\u2666",
  lozengeOutline: "\u25CA",
  hamburger: "\u2261",
  smiley: "\u263A",
  mustache: "\u250C\u2500\u2510",
  star: "\u2736",
  play: "\u25BA",
  nodejs: "\u2666",
  oneSeventh: "1/7",
  oneNinth: "1/9",
  oneTenth: "1/10"
};
var mainSymbols = { ...common, ...specialMainSymbols };
var fallbackSymbols = { ...common, ...specialFallbackSymbols };
var shouldUseMain = isUnicodeSupported();
var figures = shouldUseMain ? mainSymbols : fallbackSymbols;
var figures_default = figures;
var replacements = Object.entries(specialMainSymbols);

// ../../node_modules/.pnpm/yoctocolors@2.2.0/node_modules/yoctocolors/base.js
import tty from "node:tty";
var hasColors = tty?.WriteStream?.prototype?.hasColors?.() ?? false;
var format = (open, close) => {
  if (!hasColors) {
    return (input) => input;
  }
  const openCode = `\x1B[${open}m`;
  const closeCode = `\x1B[${close}m`;
  return (input) => {
    const string = input + "";
    let index = string.indexOf(closeCode);
    if (index === -1) {
      return openCode + string + closeCode;
    }
    let result = openCode;
    let lastIndex = 0;
    const reopenOnNestedClose = close === 22;
    const replaceCode = (reopenOnNestedClose ? closeCode : "") + openCode;
    while (index !== -1) {
      result += string.slice(lastIndex, index) + replaceCode;
      lastIndex = index + closeCode.length;
      index = string.indexOf(closeCode, lastIndex);
    }
    result += string.slice(lastIndex) + closeCode;
    return result;
  };
};
var reset = format(0, 0);
var bold = format(1, 22);
var dim = format(2, 22);
var italic = format(3, 23);
var underline = format(4, 24);
var underlineDouble = format("4:2", 24);
var underlineCurly = format("4:3", 24);
var underlineDotted = format("4:4", 24);
var underlineDashed = format("4:5", 24);
var overline = format(53, 55);
var inverse = format(7, 27);
var hidden = format(8, 28);
var strikethrough = format(9, 29);
var black = format(30, 39);
var red = format(31, 39);
var green = format(32, 39);
var yellow = format(33, 39);
var blue = format(34, 39);
var magenta = format(35, 39);
var cyan = format(36, 39);
var white = format(37, 39);
var gray = format(90, 39);
var bgBlack = format(40, 49);
var bgRed = format(41, 49);
var bgGreen = format(42, 49);
var bgYellow = format(43, 49);
var bgBlue = format(44, 49);
var bgMagenta = format(45, 49);
var bgCyan = format(46, 49);
var bgWhite = format(47, 49);
var bgGray = format(100, 49);
var redBright = format(91, 39);
var greenBright = format(92, 39);
var yellowBright = format(93, 39);
var blueBright = format(94, 39);
var magentaBright = format(95, 39);
var cyanBright = format(96, 39);
var whiteBright = format(97, 39);
var bgRedBright = format(101, 49);
var bgGreenBright = format(102, 49);
var bgYellowBright = format(103, 49);
var bgBlueBright = format(104, 49);
var bgMagentaBright = format(105, 49);
var bgCyanBright = format(106, 49);
var bgWhiteBright = format(107, 49);
var underlineBlack = format("58;5;0", 59);
var underlineRed = format("58;5;1", 59);
var underlineGreen = format("58;5;2", 59);
var underlineYellow = format("58;5;3", 59);
var underlineBlue = format("58;5;4", 59);
var underlineMagenta = format("58;5;5", 59);
var underlineCyan = format("58;5;6", 59);
var underlineWhite = format("58;5;7", 59);
var underlineGray = format("58;5;8", 59);
var underlineRedBright = format("58;5;9", 59);
var underlineGreenBright = format("58;5;10", 59);
var underlineYellowBright = format("58;5;11", 59);
var underlineBlueBright = format("58;5;12", 59);
var underlineMagentaBright = format("58;5;13", 59);
var underlineCyanBright = format("58;5;14", 59);
var underlineWhiteBright = format("58;5;15", 59);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/default.js
var defaultVerboseFunction = ({
  type,
  message,
  timestamp,
  piped,
  commandId,
  result: { failed = false } = {},
  options: { reject = true }
}) => {
  const timestampString = serializeTimestamp(timestamp);
  const icon = ICONS[type]({ failed, reject, piped });
  const color = COLORS[type]({ reject });
  return `${gray(`[${timestampString}]`)} ${gray(`[${commandId}]`)} ${color(icon)} ${color(message)}`;
};
var serializeTimestamp = (timestamp) => `${padField(timestamp.getHours(), 2)}:${padField(timestamp.getMinutes(), 2)}:${padField(timestamp.getSeconds(), 2)}.${padField(timestamp.getMilliseconds(), 3)}`;
var padField = (field, padding) => String(field).padStart(padding, "0");
var getFinalIcon = ({ failed, reject }) => {
  if (!failed) {
    return figures_default.tick;
  }
  return reject ? figures_default.cross : figures_default.warning;
};
var ICONS = {
  command: ({ piped }) => piped ? "|" : "$",
  output: () => " ",
  ipc: () => "*",
  error: getFinalIcon,
  duration: getFinalIcon
};
var identity = (string) => string;
var COLORS = {
  command: () => bold,
  output: () => identity,
  ipc: () => identity,
  error: ({ reject }) => reject ? redBright : yellowBright,
  duration: () => gray
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/custom.js
var applyVerboseOnLines = (printedLines, verboseInfo, fdNumber) => {
  const verboseFunction = getVerboseFunction(verboseInfo, fdNumber);
  return printedLines.map(({ verboseLine, verboseObject }) => applyVerboseFunction(verboseLine, verboseObject, verboseFunction)).filter((printedLine) => printedLine !== void 0).map((printedLine) => appendNewline(printedLine)).join("");
};
var applyVerboseFunction = (verboseLine, verboseObject, verboseFunction) => {
  if (verboseFunction === void 0) {
    return verboseLine;
  }
  const printedLine = verboseFunction(verboseLine, verboseObject);
  if (typeof printedLine === "string") {
    return printedLine;
  }
};
var appendNewline = (printedLine) => printedLine.endsWith("\n") ? printedLine : `${printedLine}
`;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/log.js
var verboseLog = ({ type, verboseMessage, fdNumber, verboseInfo, result }) => {
  const verboseObject = getVerboseObject({ type, result, verboseInfo });
  const printedLines = getPrintedLines(verboseMessage, verboseObject);
  const finalLines = applyVerboseOnLines(printedLines, verboseInfo, fdNumber);
  if (finalLines !== "") {
    console.warn(finalLines.slice(0, -1));
  }
};
var getVerboseObject = ({
  type,
  result,
  verboseInfo: { escapedCommand, commandId, rawOptions: { piped = false, ...options } }
}) => ({
  type,
  escapedCommand,
  commandId: `${commandId}`,
  timestamp: /* @__PURE__ */ new Date(),
  piped,
  result,
  options
});
var getPrintedLines = (verboseMessage, verboseObject) => verboseMessage.split("\n").map((message) => getPrintedLine({ ...verboseObject, message }));
var getPrintedLine = (verboseObject) => {
  const verboseLine = defaultVerboseFunction(verboseObject);
  return { verboseLine, verboseObject };
};
var serializeVerboseMessage = (message) => {
  const messageString = typeof message === "string" ? message : inspect(message);
  const escapedMessage = escapeLines(messageString);
  return escapedMessage.replaceAll("	", " ".repeat(TAB_SIZE));
};
var TAB_SIZE = 2;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/start.js
var logCommand = (escapedCommand, verboseInfo) => {
  if (!isVerbose(verboseInfo)) {
    return;
  }
  verboseLog({
    type: "command",
    verboseMessage: escapedCommand,
    verboseInfo
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/info.js
var getVerboseInfo = (verbose, escapedCommand, rawOptions) => {
  validateVerbose(verbose);
  const commandId = getCommandId(verbose);
  return {
    verbose,
    escapedCommand,
    commandId,
    rawOptions
  };
};
var getCommandId = (verbose) => isVerbose({ verbose }) ? COMMAND_ID++ : void 0;
var COMMAND_ID = 0n;
var validateVerbose = (verbose) => {
  for (const fdVerbose of verbose) {
    if (fdVerbose === false) {
      throw new TypeError(`The "verbose: false" option was renamed to "verbose: 'none'".`);
    }
    if (fdVerbose === true) {
      throw new TypeError(`The "verbose: true" option was renamed to "verbose: 'short'".`);
    }
    if (!VERBOSE_VALUES.includes(fdVerbose) && !isVerboseFunction(fdVerbose)) {
      const allowedValues = VERBOSE_VALUES.map((allowedValue) => `'${allowedValue}'`).join(", ");
      throw new TypeError(`The "verbose" option must not be ${fdVerbose}. Allowed values are: ${allowedValues} or a function.`);
    }
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/duration.js
import { hrtime } from "node:process";
var getStartTime = () => hrtime.bigint();
var getDurationMs = (startTime) => Number(hrtime.bigint() - startTime) / 1e6;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/command.js
var handleCommand = (filePath, rawArguments, rawOptions) => {
  const startTime = getStartTime();
  const { command, escapedCommand } = joinCommand(filePath, rawArguments);
  const verbose = normalizeFdSpecificOption(rawOptions, "verbose");
  const verboseInfo = getVerboseInfo(verbose, escapedCommand, { ...rawOptions });
  logCommand(escapedCommand, verboseInfo);
  return {
    command,
    escapedCommand,
    startTime,
    verboseInfo
  };
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/options.js
import path6 from "node:path";
import process6 from "node:process";
import crossSpawn2 from "cross-spawn";

// ../../node_modules/.pnpm/npm-run-path@6.0.0/node_modules/npm-run-path/index.js
import process4 from "node:process";
import path3 from "node:path";

// ../../node_modules/.pnpm/path-key@4.0.0/node_modules/path-key/index.js
function pathKey(options = {}) {
  const {
    env = process.env,
    platform: platform2 = process.platform
  } = options;
  if (platform2 !== "win32") {
    return "PATH";
  }
  return Object.keys(env).reverse().find((key) => key.toUpperCase() === "PATH") || "Path";
}

// ../../node_modules/.pnpm/unicorn-magic@0.3.0/node_modules/unicorn-magic/node.js
import { promisify } from "node:util";
import { execFile as execFileCallback, execFileSync as execFileSyncOriginal } from "node:child_process";
import path2 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var execFileOriginal = promisify(execFileCallback);
function toPath(urlOrPath) {
  return urlOrPath instanceof URL ? fileURLToPath2(urlOrPath) : urlOrPath;
}
function traversePathUp(startPath) {
  return {
    *[Symbol.iterator]() {
      let currentPath = path2.resolve(toPath(startPath));
      let previousPath;
      while (previousPath !== currentPath) {
        yield currentPath;
        previousPath = currentPath;
        currentPath = path2.resolve(currentPath, "..");
      }
    }
  };
}
var TEN_MEGABYTES_IN_BYTES = 10 * 1024 * 1024;

// ../../node_modules/.pnpm/npm-run-path@6.0.0/node_modules/npm-run-path/index.js
var npmRunPath = ({
  cwd = process4.cwd(),
  path: pathOption = process4.env[pathKey()],
  preferLocal = true,
  execPath: execPath2 = process4.execPath,
  addExecPath = true
} = {}) => {
  const cwdPath = path3.resolve(toPath(cwd));
  const result = [];
  const pathParts = pathOption.split(path3.delimiter);
  if (preferLocal) {
    applyPreferLocal(result, pathParts, cwdPath);
  }
  if (addExecPath) {
    applyExecPath(result, pathParts, execPath2, cwdPath);
  }
  return pathOption === "" || pathOption === path3.delimiter ? `${result.join(path3.delimiter)}${pathOption}` : [...result, pathOption].join(path3.delimiter);
};
var applyPreferLocal = (result, pathParts, cwdPath) => {
  for (const directory of traversePathUp(cwdPath)) {
    const pathPart = path3.join(directory, "node_modules/.bin");
    if (!pathParts.includes(pathPart)) {
      result.push(pathPart);
    }
  }
};
var applyExecPath = (result, pathParts, execPath2, cwdPath) => {
  const pathPart = path3.resolve(cwdPath, toPath(execPath2), "..");
  if (!pathParts.includes(pathPart)) {
    result.push(pathPart);
  }
};
var npmRunPathEnv = ({ env = process4.env, ...options } = {}) => {
  env = { ...env };
  const pathName = pathKey({ env });
  options.path = env[pathName];
  env[pathName] = npmRunPath(options);
  return env;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/kill.js
import { setTimeout as setTimeout2 } from "node:timers/promises";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/final-error.js
var getFinalError = (originalError, message, isSync) => {
  const ErrorClass = isSync ? ExecaSyncError : ExecaError;
  const options = originalError instanceof DiscardedError ? {} : { cause: originalError };
  return new ErrorClass(message, options);
};
var DiscardedError = class extends Error {
};
var setErrorName = (ErrorClass, value) => {
  Object.defineProperty(ErrorClass.prototype, "name", {
    value,
    writable: true,
    enumerable: false,
    configurable: true
  });
  Object.defineProperty(ErrorClass.prototype, execaErrorSymbol, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: false
  });
};
var isExecaError = (error) => isErrorInstance(error) && execaErrorSymbol in error;
var execaErrorSymbol = /* @__PURE__ */ Symbol("isExecaError");
var isErrorInstance = (value) => Object.prototype.toString.call(value) === "[object Error]";
var ExecaError = class extends Error {
};
setErrorName(ExecaError, ExecaError.name);
var ExecaSyncError = class extends Error {
};
setErrorName(ExecaSyncError, ExecaSyncError.name);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/signal.js
import { constants as constants3 } from "node:os";

// ../../node_modules/.pnpm/human-signals@8.0.1/node_modules/human-signals/build/src/main.js
import { constants as constants2 } from "node:os";

// ../../node_modules/.pnpm/human-signals@8.0.1/node_modules/human-signals/build/src/realtime.js
var getRealtimeSignals = () => {
  const length = SIGRTMAX - SIGRTMIN + 1;
  return Array.from({ length }, getRealtimeSignal);
};
var getRealtimeSignal = (value, index) => ({
  name: `SIGRT${index + 1}`,
  number: SIGRTMIN + index,
  action: "terminate",
  description: "Application-specific signal (realtime)",
  standard: "posix"
});
var SIGRTMIN = 34;
var SIGRTMAX = 64;

// ../../node_modules/.pnpm/human-signals@8.0.1/node_modules/human-signals/build/src/signals.js
import { constants } from "node:os";

// ../../node_modules/.pnpm/human-signals@8.0.1/node_modules/human-signals/build/src/core.js
var SIGNALS = [
  {
    name: "SIGHUP",
    number: 1,
    action: "terminate",
    description: "Terminal closed",
    standard: "posix"
  },
  {
    name: "SIGINT",
    number: 2,
    action: "terminate",
    description: "User interruption with CTRL-C",
    standard: "ansi"
  },
  {
    name: "SIGQUIT",
    number: 3,
    action: "core",
    description: "User interruption with CTRL-\\",
    standard: "posix"
  },
  {
    name: "SIGILL",
    number: 4,
    action: "core",
    description: "Invalid machine instruction",
    standard: "ansi"
  },
  {
    name: "SIGTRAP",
    number: 5,
    action: "core",
    description: "Debugger breakpoint",
    standard: "posix"
  },
  {
    name: "SIGABRT",
    number: 6,
    action: "core",
    description: "Aborted",
    standard: "ansi"
  },
  {
    name: "SIGIOT",
    number: 6,
    action: "core",
    description: "Aborted",
    standard: "bsd"
  },
  {
    name: "SIGBUS",
    number: 7,
    action: "core",
    description: "Bus error due to misaligned, non-existing address or paging error",
    standard: "bsd"
  },
  {
    name: "SIGEMT",
    number: 7,
    action: "terminate",
    description: "Command should be emulated but is not implemented",
    standard: "other"
  },
  {
    name: "SIGFPE",
    number: 8,
    action: "core",
    description: "Floating point arithmetic error",
    standard: "ansi"
  },
  {
    name: "SIGKILL",
    number: 9,
    action: "terminate",
    description: "Forced termination",
    standard: "posix",
    forced: true
  },
  {
    name: "SIGUSR1",
    number: 10,
    action: "terminate",
    description: "Application-specific signal",
    standard: "posix"
  },
  {
    name: "SIGSEGV",
    number: 11,
    action: "core",
    description: "Segmentation fault",
    standard: "ansi"
  },
  {
    name: "SIGUSR2",
    number: 12,
    action: "terminate",
    description: "Application-specific signal",
    standard: "posix"
  },
  {
    name: "SIGPIPE",
    number: 13,
    action: "terminate",
    description: "Broken pipe or socket",
    standard: "posix"
  },
  {
    name: "SIGALRM",
    number: 14,
    action: "terminate",
    description: "Timeout or timer",
    standard: "posix"
  },
  {
    name: "SIGTERM",
    number: 15,
    action: "terminate",
    description: "Termination",
    standard: "ansi"
  },
  {
    name: "SIGSTKFLT",
    number: 16,
    action: "terminate",
    description: "Stack is empty or overflowed",
    standard: "other"
  },
  {
    name: "SIGCHLD",
    number: 17,
    action: "ignore",
    description: "Child process terminated, paused or unpaused",
    standard: "posix"
  },
  {
    name: "SIGCLD",
    number: 17,
    action: "ignore",
    description: "Child process terminated, paused or unpaused",
    standard: "other"
  },
  {
    name: "SIGCONT",
    number: 18,
    action: "unpause",
    description: "Unpaused",
    standard: "posix",
    forced: true
  },
  {
    name: "SIGSTOP",
    number: 19,
    action: "pause",
    description: "Paused",
    standard: "posix",
    forced: true
  },
  {
    name: "SIGTSTP",
    number: 20,
    action: "pause",
    description: 'Paused using CTRL-Z or "suspend"',
    standard: "posix"
  },
  {
    name: "SIGTTIN",
    number: 21,
    action: "pause",
    description: "Background process cannot read terminal input",
    standard: "posix"
  },
  {
    name: "SIGBREAK",
    number: 21,
    action: "terminate",
    description: "User interruption with CTRL-BREAK",
    standard: "other"
  },
  {
    name: "SIGTTOU",
    number: 22,
    action: "pause",
    description: "Background process cannot write to terminal output",
    standard: "posix"
  },
  {
    name: "SIGURG",
    number: 23,
    action: "ignore",
    description: "Socket received out-of-band data",
    standard: "bsd"
  },
  {
    name: "SIGXCPU",
    number: 24,
    action: "core",
    description: "Process timed out",
    standard: "bsd"
  },
  {
    name: "SIGXFSZ",
    number: 25,
    action: "core",
    description: "File too big",
    standard: "bsd"
  },
  {
    name: "SIGVTALRM",
    number: 26,
    action: "terminate",
    description: "Timeout or timer",
    standard: "bsd"
  },
  {
    name: "SIGPROF",
    number: 27,
    action: "terminate",
    description: "Timeout or timer",
    standard: "bsd"
  },
  {
    name: "SIGWINCH",
    number: 28,
    action: "ignore",
    description: "Terminal window size changed",
    standard: "bsd"
  },
  {
    name: "SIGIO",
    number: 29,
    action: "terminate",
    description: "I/O is available",
    standard: "other"
  },
  {
    name: "SIGPOLL",
    number: 29,
    action: "terminate",
    description: "Watched event",
    standard: "other"
  },
  {
    name: "SIGINFO",
    number: 29,
    action: "ignore",
    description: "Request for process information",
    standard: "other"
  },
  {
    name: "SIGPWR",
    number: 30,
    action: "terminate",
    description: "Device running out of power",
    standard: "systemv"
  },
  {
    name: "SIGSYS",
    number: 31,
    action: "core",
    description: "Invalid system call",
    standard: "other"
  },
  {
    name: "SIGUNUSED",
    number: 31,
    action: "terminate",
    description: "Invalid system call",
    standard: "other"
  }
];

// ../../node_modules/.pnpm/human-signals@8.0.1/node_modules/human-signals/build/src/signals.js
var getSignals = () => {
  const realtimeSignals = getRealtimeSignals();
  const signals2 = [...SIGNALS, ...realtimeSignals].map(normalizeSignal);
  return signals2;
};
var normalizeSignal = ({
  name,
  number: defaultNumber,
  description,
  action,
  forced = false,
  standard
}) => {
  const {
    signals: { [name]: constantSignal }
  } = constants;
  const supported = constantSignal !== void 0;
  const number = supported ? constantSignal : defaultNumber;
  return { name, number, description, supported, action, forced, standard };
};

// ../../node_modules/.pnpm/human-signals@8.0.1/node_modules/human-signals/build/src/main.js
var getSignalsByName = () => {
  const signals2 = getSignals();
  return Object.fromEntries(signals2.map(getSignalByName));
};
var getSignalByName = ({
  name,
  number,
  description,
  supported,
  action,
  forced,
  standard
}) => [name, { name, number, description, supported, action, forced, standard }];
var signalsByName = getSignalsByName();
var getSignalsByNumber = () => {
  const signals2 = getSignals();
  const length = SIGRTMAX + 1;
  const signalsA = Array.from(
    { length },
    (value, number) => getSignalByNumber(number, signals2)
  );
  return Object.assign({}, ...signalsA);
};
var getSignalByNumber = (number, signals2) => {
  const signal = findSignalByNumber(number, signals2);
  if (signal === void 0) {
    return {};
  }
  const { name, description, supported, action, forced, standard } = signal;
  return {
    [number]: {
      name,
      number,
      description,
      supported,
      action,
      forced,
      standard
    }
  };
};
var findSignalByNumber = (number, signals2) => {
  const signal = signals2.find(({ name }) => constants2.signals[name] === number);
  if (signal !== void 0) {
    return signal;
  }
  return signals2.find((signalA) => signalA.number === number);
};
var signalsByNumber = getSignalsByNumber();

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/signal.js
var normalizeKillSignal = (killSignal) => {
  const optionName = "option `killSignal`";
  if (killSignal === 0) {
    throw new TypeError(`Invalid ${optionName}: 0 cannot be used.`);
  }
  return normalizeSignal2(killSignal, optionName);
};
var normalizeSignalArgument = (signal) => signal === 0 ? signal : normalizeSignal2(signal, "`subprocess.kill()`'s argument");
var normalizeSignal2 = (signalNameOrInteger, optionName) => {
  if (Number.isInteger(signalNameOrInteger)) {
    return normalizeSignalInteger(signalNameOrInteger, optionName);
  }
  if (typeof signalNameOrInteger === "string") {
    return normalizeSignalName(signalNameOrInteger, optionName);
  }
  throw new TypeError(`Invalid ${optionName} ${String(signalNameOrInteger)}: it must be a string or an integer.
${getAvailableSignals()}`);
};
var normalizeSignalInteger = (signalInteger, optionName) => {
  if (signalsIntegerToName.has(signalInteger)) {
    return signalsIntegerToName.get(signalInteger);
  }
  throw new TypeError(`Invalid ${optionName} ${signalInteger}: this signal integer does not exist.
${getAvailableSignals()}`);
};
var getSignalsIntegerToName = () => new Map(Object.entries(constants3.signals).reverse().map(([signalName, signalInteger]) => [signalInteger, signalName]));
var signalsIntegerToName = getSignalsIntegerToName();
var normalizeSignalName = (signalName, optionName) => {
  if (signalName in constants3.signals) {
    return signalName;
  }
  if (signalName.toUpperCase() in constants3.signals) {
    throw new TypeError(`Invalid ${optionName} '${signalName}': please rename it to '${signalName.toUpperCase()}'.`);
  }
  throw new TypeError(`Invalid ${optionName} '${signalName}': this signal name does not exist.
${getAvailableSignals()}`);
};
var getAvailableSignals = () => `Available signal names: ${getAvailableSignalNames()}.
Available signal numbers: ${getAvailableSignalIntegers()}.`;
var getAvailableSignalNames = () => Object.keys(constants3.signals).sort().map((signalName) => `'${signalName}'`).join(", ");
var getAvailableSignalIntegers = () => [...new Set(Object.values(constants3.signals).sort((signalInteger, signalIntegerTwo) => signalInteger - signalIntegerTwo))].join(", ");
var getSignalDescription = (signal) => signalsByName[signal].description;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/kill.js
var normalizeForceKillAfterDelay = (forceKillAfterDelay) => {
  if (forceKillAfterDelay === false) {
    return forceKillAfterDelay;
  }
  if (forceKillAfterDelay === true) {
    return DEFAULT_FORCE_KILL_TIMEOUT;
  }
  if (!Number.isFinite(forceKillAfterDelay) || forceKillAfterDelay < 0) {
    throw new TypeError(`Expected the \`forceKillAfterDelay\` option to be a non-negative integer, got \`${forceKillAfterDelay}\` (${typeof forceKillAfterDelay})`);
  }
  return forceKillAfterDelay;
};
var DEFAULT_FORCE_KILL_TIMEOUT = 1e3 * 5;
var subprocessKill = ({ kill, options: { forceKillAfterDelay, killSignal }, onInternalError, context, controller }, signalOrError, errorArgument) => {
  const { signal, error } = parseKillArguments(signalOrError, errorArgument, killSignal);
  emitKillError(error, onInternalError);
  const killResult = kill(signal);
  setKillTimeout({
    kill,
    signal,
    forceKillAfterDelay,
    killSignal,
    killResult,
    context,
    controller
  });
  return killResult;
};
var parseKillArguments = (signalOrError, errorArgument, killSignal) => {
  const [signal = killSignal, error] = isErrorInstance(signalOrError) ? [void 0, signalOrError] : [signalOrError, errorArgument];
  if (typeof signal !== "string" && !Number.isInteger(signal)) {
    throw new TypeError(`The first argument must be an error instance or a signal name string/integer: ${String(signal)}`);
  }
  if (error !== void 0 && !isErrorInstance(error)) {
    throw new TypeError(`The second argument is optional. If specified, it must be an error instance: ${error}`);
  }
  return { signal: normalizeSignalArgument(signal), error };
};
var emitKillError = (error, onInternalError) => {
  if (error !== void 0) {
    onInternalError.reject(error);
  }
};
var setKillTimeout = async ({ kill, signal, forceKillAfterDelay, killSignal, killResult, context, controller }) => {
  if (signal === killSignal && killResult) {
    killOnTimeout({
      kill,
      forceKillAfterDelay,
      context,
      controllerSignal: controller.signal
    });
  }
};
var killOnTimeout = async ({ kill, forceKillAfterDelay, context, controllerSignal }) => {
  if (forceKillAfterDelay === false) {
    return;
  }
  try {
    await setTimeout2(forceKillAfterDelay, void 0, { signal: controllerSignal });
    if (kill("SIGKILL")) {
      context.isForcefullyTerminated ??= true;
    }
  } catch {
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/utils/abort-signal.js
import { once } from "node:events";
var onAbortedSignal = async (mainSignal, stopSignal) => {
  if (!mainSignal.aborted) {
    await once(mainSignal, "abort", { signal: stopSignal });
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/cancel.js
var validateCancelSignal = ({ cancelSignal }) => {
  if (cancelSignal !== void 0 && Object.prototype.toString.call(cancelSignal) !== "[object AbortSignal]") {
    throw new Error(`The \`cancelSignal\` option must be an AbortSignal: ${String(cancelSignal)}`);
  }
};
var throwOnCancel = ({ subprocess, cancelSignal, gracefulCancel, context, controller }) => cancelSignal === void 0 || gracefulCancel ? [] : [terminateOnCancel(subprocess, cancelSignal, context, controller)];
var terminateOnCancel = async (subprocess, cancelSignal, context, { signal }) => {
  await onAbortedSignal(cancelSignal, signal);
  context.terminationReason ??= "cancel";
  subprocess.kill();
  throw cancelSignal.reason;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/graceful.js
import { scheduler as scheduler2 } from "node:timers/promises";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/send.js
import { promisify as promisify2 } from "node:util";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/validation.js
var validateIpcMethod = ({ methodName, isSubprocess, ipc, isConnected: isConnected2 }) => {
  validateIpcOption(methodName, isSubprocess, ipc);
  validateConnection(methodName, isSubprocess, isConnected2);
};
var validateIpcOption = (methodName, isSubprocess, ipc) => {
  if (!ipc) {
    throw new Error(`${getMethodName(methodName, isSubprocess)} can only be used if the \`ipc\` option is \`true\`.`);
  }
};
var validateConnection = (methodName, isSubprocess, isConnected2) => {
  if (!isConnected2) {
    throw new Error(`${getMethodName(methodName, isSubprocess)} cannot be used: the ${getOtherProcessName(isSubprocess)} has already exited or disconnected.`);
  }
};
var throwOnEarlyDisconnect = (isSubprocess) => {
  throw new Error(`${getMethodName("getOneMessage", isSubprocess)} could not complete: the ${getOtherProcessName(isSubprocess)} exited or disconnected.`);
};
var throwOnStrictDeadlockError = (isSubprocess) => {
  throw new Error(`${getMethodName("sendMessage", isSubprocess)} failed: the ${getOtherProcessName(isSubprocess)} is sending a message too, instead of listening to incoming messages.
This can be fixed by both sending a message and listening to incoming messages at the same time:

const [receivedMessage] = await Promise.all([
	${getMethodName("getOneMessage", isSubprocess)},
	${getMethodName("sendMessage", isSubprocess, "message, {strict: true}")},
]);`);
};
var getStrictResponseError = (error, isSubprocess) => new Error(`${getMethodName("sendMessage", isSubprocess)} failed when sending an acknowledgment response to the ${getOtherProcessName(isSubprocess)}.`, { cause: error });
var throwOnMissingStrict = (isSubprocess) => {
  throw new Error(`${getMethodName("sendMessage", isSubprocess)} failed: the ${getOtherProcessName(isSubprocess)} is not listening to incoming messages.`);
};
var throwOnStrictDisconnect = (isSubprocess) => {
  throw new Error(`${getMethodName("sendMessage", isSubprocess)} failed: the ${getOtherProcessName(isSubprocess)} exited without listening to incoming messages.`);
};
var getAbortDisconnectError = () => new Error(`\`cancelSignal\` aborted: the ${getOtherProcessName(true)} disconnected.`);
var throwOnMissingParent = () => {
  throw new Error("`getCancelSignal()` cannot be used without setting the `cancelSignal` subprocess option.");
};
var handleEpipeError = ({ error, methodName, isSubprocess }) => {
  if (error.code === "EPIPE") {
    throw new Error(`${getMethodName(methodName, isSubprocess)} cannot be used: the ${getOtherProcessName(isSubprocess)} is disconnecting.`, { cause: error });
  }
};
var handleSerializationError = ({ error, methodName, isSubprocess, message }) => {
  if (isSerializationError(error)) {
    throw new Error(`${getMethodName(methodName, isSubprocess)}'s argument type is invalid: the message cannot be serialized: ${String(message)}.`, { cause: error });
  }
};
var isSerializationError = ({ code, message }) => SERIALIZATION_ERROR_CODES.has(code) || SERIALIZATION_ERROR_MESSAGES.some((serializationErrorMessage) => message.includes(serializationErrorMessage));
var SERIALIZATION_ERROR_CODES = /* @__PURE__ */ new Set([
  // Message is `undefined`
  "ERR_MISSING_ARGS",
  // Message is a function, a bigint, a symbol
  "ERR_INVALID_ARG_TYPE"
]);
var SERIALIZATION_ERROR_MESSAGES = [
  // Message is a promise or a proxy, with `serialization: 'advanced'`
  "could not be cloned",
  // Message has cycles, with `serialization: 'json'`
  "circular structure",
  // Message has cycles inside toJSON(), with `serialization: 'json'`
  "call stack size exceeded"
];
var getMethodName = (methodName, isSubprocess, parameters = "") => methodName === "cancelSignal" ? "`cancelSignal`'s `controller.abort()`" : `${getNamespaceName(isSubprocess)}${methodName}(${parameters})`;
var getNamespaceName = (isSubprocess) => isSubprocess ? "" : "subprocess.";
var getOtherProcessName = (isSubprocess) => isSubprocess ? "parent process" : "subprocess";
var disconnect = (anyProcess) => {
  if (anyProcess.connected) {
    anyProcess.disconnect();
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/utils/deferred.js
var createDeferred = () => {
  const methods = {};
  const promise = new Promise((resolve2, reject) => {
    Object.assign(methods, { resolve: resolve2, reject });
  });
  return Object.assign(promise, methods);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/fd-options.js
var getToStream = (destination, to = "stdin") => {
  const isWritable = true;
  const { options, fileDescriptors } = SUBPROCESS_OPTIONS.get(destination);
  const fdNumber = getFdNumber(fileDescriptors, to, isWritable);
  const destinationStream = destination.stdio[fdNumber];
  if (destinationStream === null) {
    throw new TypeError(getInvalidStdioOptionMessage(fdNumber, to, options, isWritable));
  }
  return destinationStream;
};
var getFromStream = (source, from = "stdout") => {
  const isWritable = false;
  const { options, fileDescriptors } = SUBPROCESS_OPTIONS.get(source);
  const fdNumber = getFdNumber(fileDescriptors, from, isWritable);
  const sourceStream = fdNumber === "all" ? source.all : source.stdio[fdNumber];
  if (sourceStream === null || sourceStream === void 0) {
    throw new TypeError(getInvalidStdioOptionMessage(fdNumber, from, options, isWritable));
  }
  return sourceStream;
};
var SUBPROCESS_OPTIONS = /* @__PURE__ */ new WeakMap();
var getFdNumber = (fileDescriptors, fdName, isWritable) => {
  const fdNumber = parseFdNumber(fdName, isWritable);
  validateFdNumber(fdNumber, fdName, isWritable, fileDescriptors);
  return fdNumber;
};
var parseFdNumber = (fdName, isWritable) => {
  const fdNumber = parseFd(fdName);
  if (fdNumber !== void 0) {
    return fdNumber;
  }
  const { validOptions, defaultValue } = isWritable ? { validOptions: '"stdin"', defaultValue: "stdin" } : { validOptions: '"stdout", "stderr", "all"', defaultValue: "stdout" };
  throw new TypeError(`"${getOptionName(isWritable)}" must not be "${fdName}".
It must be ${validOptions} or "fd3", "fd4" (and so on).
It is optional and defaults to "${defaultValue}".`);
};
var validateFdNumber = (fdNumber, fdName, isWritable, fileDescriptors) => {
  const fileDescriptor = fileDescriptors[getUsedDescriptor(fdNumber)];
  if (fileDescriptor === void 0) {
    throw new TypeError(`"${getOptionName(isWritable)}" must not be ${fdName}. That file descriptor does not exist.
Please set the "stdio" option to ensure that file descriptor exists.`);
  }
  if (fileDescriptor.direction === "input" && !isWritable) {
    throw new TypeError(`"${getOptionName(isWritable)}" must not be ${fdName}. It must be a readable stream, not writable.`);
  }
  if (fileDescriptor.direction !== "input" && isWritable) {
    throw new TypeError(`"${getOptionName(isWritable)}" must not be ${fdName}. It must be a writable stream, not readable.`);
  }
};
var getInvalidStdioOptionMessage = (fdNumber, fdName, options, isWritable) => {
  if (fdNumber === "all" && !options.all) {
    return `The "all" option must be true to use "from: 'all'".`;
  }
  const { optionName, optionValue: optionValue2 } = getInvalidStdioOption(fdNumber, options);
  return `The "${optionName}: ${serializeOptionValue(optionValue2)}" option is incompatible with using "${getOptionName(isWritable)}: ${serializeOptionValue(fdName)}".
Please set this option with "pipe" instead.`;
};
var getInvalidStdioOption = (fdNumber, { stdin, stdout, stderr, stdio }) => {
  const usedDescriptor = getUsedDescriptor(fdNumber);
  if (usedDescriptor === 0 && stdin !== void 0) {
    return { optionName: "stdin", optionValue: stdin };
  }
  if (usedDescriptor === 1 && stdout !== void 0) {
    return { optionName: "stdout", optionValue: stdout };
  }
  if (usedDescriptor === 2 && stderr !== void 0) {
    return { optionName: "stderr", optionValue: stderr };
  }
  return { optionName: `stdio[${usedDescriptor}]`, optionValue: stdio[usedDescriptor] };
};
var getUsedDescriptor = (fdNumber) => fdNumber === "all" ? 1 : fdNumber;
var getOptionName = (isWritable) => isWritable ? "to" : "from";
var serializeOptionValue = (value) => {
  if (typeof value === "string") {
    return `'${value}'`;
  }
  return typeof value === "number" ? `${value}` : "Stream";
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/strict.js
import { once as once3 } from "node:events";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/utils/max-listeners.js
import { addAbortListener } from "node:events";
var incrementMaxListeners = (eventEmitter, maxListenersIncrement, signal) => {
  const maxListeners = eventEmitter.getMaxListeners();
  if (maxListeners === 0 || maxListeners === Number.POSITIVE_INFINITY) {
    return;
  }
  eventEmitter.setMaxListeners(maxListeners + maxListenersIncrement);
  addAbortListener(signal, () => {
    eventEmitter.setMaxListeners(eventEmitter.getMaxListeners() - maxListenersIncrement);
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/forward.js
import { EventEmitter } from "node:events";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/incoming.js
import { once as once2 } from "node:events";
import { scheduler } from "node:timers/promises";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/reference.js
var addReference = (channel, reference) => {
  if (reference) {
    addReferenceCount(channel);
  }
};
var addReferenceCount = (channel) => {
  channel.refCounted();
};
var removeReference = (channel, reference) => {
  if (reference) {
    removeReferenceCount(channel);
  }
};
var removeReferenceCount = (channel) => {
  channel.unrefCounted();
};
var undoAddedReferences = (channel, isSubprocess) => {
  if (isSubprocess) {
    removeReferenceCount(channel);
    removeReferenceCount(channel);
  }
};
var redoAddedReferences = (channel, isSubprocess) => {
  if (isSubprocess) {
    addReferenceCount(channel);
    addReferenceCount(channel);
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/incoming.js
var onMessage = async ({ anyProcess, channel, isSubprocess, ipcEmitter }, wrappedMessage) => {
  if (handleStrictResponse(wrappedMessage) || handleAbort(wrappedMessage)) {
    return;
  }
  if (!INCOMING_MESSAGES.has(anyProcess)) {
    INCOMING_MESSAGES.set(anyProcess, []);
  }
  const incomingMessages = INCOMING_MESSAGES.get(anyProcess);
  incomingMessages.push(wrappedMessage);
  if (incomingMessages.length > 1) {
    return;
  }
  while (incomingMessages.length > 0) {
    await waitForOutgoingMessages(anyProcess, ipcEmitter, wrappedMessage);
    await scheduler.yield();
    const message = await handleStrictRequest({
      wrappedMessage: incomingMessages[0],
      anyProcess,
      channel,
      isSubprocess,
      ipcEmitter
    });
    incomingMessages.shift();
    ipcEmitter.emit("message", message);
    ipcEmitter.emit("message:done");
  }
};
var onDisconnect = async ({ anyProcess, channel, isSubprocess, ipcEmitter, boundOnMessage }) => {
  abortOnDisconnect();
  const incomingMessages = INCOMING_MESSAGES.get(anyProcess);
  while (incomingMessages?.length > 0) {
    await once2(ipcEmitter, "message:done");
  }
  anyProcess.removeListener("message", boundOnMessage);
  redoAddedReferences(channel, isSubprocess);
  ipcEmitter.connected = false;
  ipcEmitter.emit("disconnect");
};
var INCOMING_MESSAGES = /* @__PURE__ */ new WeakMap();

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/forward.js
var getIpcEmitter = (anyProcess, channel, isSubprocess) => {
  if (IPC_EMITTERS.has(anyProcess)) {
    return IPC_EMITTERS.get(anyProcess);
  }
  const ipcEmitter = new EventEmitter();
  ipcEmitter.connected = true;
  IPC_EMITTERS.set(anyProcess, ipcEmitter);
  forwardEvents({
    ipcEmitter,
    anyProcess,
    channel,
    isSubprocess
  });
  return ipcEmitter;
};
var IPC_EMITTERS = /* @__PURE__ */ new WeakMap();
var forwardEvents = ({ ipcEmitter, anyProcess, channel, isSubprocess }) => {
  const boundOnMessage = onMessage.bind(void 0, {
    anyProcess,
    channel,
    isSubprocess,
    ipcEmitter
  });
  anyProcess.on("message", boundOnMessage);
  anyProcess.once("disconnect", onDisconnect.bind(void 0, {
    anyProcess,
    channel,
    isSubprocess,
    ipcEmitter,
    boundOnMessage
  }));
  undoAddedReferences(channel, isSubprocess);
};
var isConnected = (anyProcess) => {
  const ipcEmitter = IPC_EMITTERS.get(anyProcess);
  return ipcEmitter === void 0 ? anyProcess.channel !== null : ipcEmitter.connected;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/strict.js
var handleSendStrict = ({ anyProcess, channel, isSubprocess, message, strict }) => {
  if (!strict) {
    return message;
  }
  const ipcEmitter = getIpcEmitter(anyProcess, channel, isSubprocess);
  const hasListeners = hasMessageListeners(anyProcess, ipcEmitter);
  return {
    id: count++,
    type: REQUEST_TYPE,
    message,
    hasListeners
  };
};
var count = 0n;
var validateStrictDeadlock = (outgoingMessages, wrappedMessage) => {
  if (wrappedMessage?.type !== REQUEST_TYPE || wrappedMessage.hasListeners) {
    return;
  }
  for (const { id } of outgoingMessages) {
    if (id !== void 0) {
      STRICT_RESPONSES[id].resolve({ isDeadlock: true, hasListeners: false });
    }
  }
};
var handleStrictRequest = async ({ wrappedMessage, anyProcess, channel, isSubprocess, ipcEmitter }) => {
  if (wrappedMessage?.type !== REQUEST_TYPE || !anyProcess.connected) {
    return wrappedMessage;
  }
  const { id, message } = wrappedMessage;
  const response = { id, type: RESPONSE_TYPE, message: hasMessageListeners(anyProcess, ipcEmitter) };
  try {
    await sendMessage({
      anyProcess,
      channel,
      isSubprocess,
      ipc: true
    }, response);
  } catch (error) {
    ipcEmitter.emit("strict:error", error);
  }
  return message;
};
var handleStrictResponse = (wrappedMessage) => {
  if (wrappedMessage?.type !== RESPONSE_TYPE) {
    return false;
  }
  const { id, message: hasListeners } = wrappedMessage;
  STRICT_RESPONSES[id]?.resolve({ isDeadlock: false, hasListeners });
  return true;
};
var waitForStrictResponse = async (wrappedMessage, anyProcess, isSubprocess) => {
  if (wrappedMessage?.type !== REQUEST_TYPE) {
    return;
  }
  const deferred = createDeferred();
  STRICT_RESPONSES[wrappedMessage.id] = deferred;
  const controller = new AbortController();
  try {
    const { isDeadlock, hasListeners } = await Promise.race([
      deferred,
      throwOnDisconnect(anyProcess, isSubprocess, controller)
    ]);
    if (isDeadlock) {
      throwOnStrictDeadlockError(isSubprocess);
    }
    if (!hasListeners) {
      throwOnMissingStrict(isSubprocess);
    }
  } finally {
    controller.abort();
    delete STRICT_RESPONSES[wrappedMessage.id];
  }
};
var STRICT_RESPONSES = {};
var throwOnDisconnect = async (anyProcess, isSubprocess, { signal }) => {
  incrementMaxListeners(anyProcess, 1, signal);
  await once3(anyProcess, "disconnect", { signal });
  throwOnStrictDisconnect(isSubprocess);
};
var REQUEST_TYPE = "execa:ipc:request";
var RESPONSE_TYPE = "execa:ipc:response";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/outgoing.js
var startSendMessage = (anyProcess, wrappedMessage, strict) => {
  if (!OUTGOING_MESSAGES.has(anyProcess)) {
    OUTGOING_MESSAGES.set(anyProcess, /* @__PURE__ */ new Set());
  }
  const outgoingMessages = OUTGOING_MESSAGES.get(anyProcess);
  const onMessageSent = createDeferred();
  const id = strict ? wrappedMessage.id : void 0;
  const outgoingMessage = { onMessageSent, id };
  outgoingMessages.add(outgoingMessage);
  return { outgoingMessages, outgoingMessage };
};
var endSendMessage = ({ outgoingMessages, outgoingMessage }) => {
  outgoingMessages.delete(outgoingMessage);
  outgoingMessage.onMessageSent.resolve();
};
var waitForOutgoingMessages = async (anyProcess, ipcEmitter, wrappedMessage) => {
  while (!hasMessageListeners(anyProcess, ipcEmitter) && OUTGOING_MESSAGES.get(anyProcess)?.size > 0) {
    const outgoingMessages = [...OUTGOING_MESSAGES.get(anyProcess)];
    validateStrictDeadlock(outgoingMessages, wrappedMessage);
    await Promise.all(outgoingMessages.map(({ onMessageSent }) => onMessageSent));
  }
};
var OUTGOING_MESSAGES = /* @__PURE__ */ new WeakMap();
var hasMessageListeners = (anyProcess, ipcEmitter) => ipcEmitter.listenerCount("message") > getMinListenerCount(anyProcess);
var getMinListenerCount = (anyProcess) => SUBPROCESS_OPTIONS.has(anyProcess) && !getFdSpecificValue(SUBPROCESS_OPTIONS.get(anyProcess).options.buffer, "ipc") ? 1 : 0;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/send.js
var sendMessage = ({ anyProcess, channel, isSubprocess, ipc }, message, { strict = false } = {}) => {
  const methodName = "sendMessage";
  validateIpcMethod({
    methodName,
    isSubprocess,
    ipc,
    isConnected: anyProcess.connected
  });
  return sendMessageAsync({
    anyProcess,
    channel,
    methodName,
    isSubprocess,
    message,
    strict
  });
};
var sendMessageAsync = async ({ anyProcess, channel, methodName, isSubprocess, message, strict }) => {
  const wrappedMessage = handleSendStrict({
    anyProcess,
    channel,
    isSubprocess,
    message,
    strict
  });
  const outgoingMessagesState = startSendMessage(anyProcess, wrappedMessage, strict);
  try {
    await sendOneMessage({
      anyProcess,
      methodName,
      isSubprocess,
      wrappedMessage,
      message
    });
  } catch (error) {
    disconnect(anyProcess);
    throw error;
  } finally {
    endSendMessage(outgoingMessagesState);
  }
};
var sendOneMessage = async ({ anyProcess, methodName, isSubprocess, wrappedMessage, message }) => {
  const sendMethod = getSendMethod(anyProcess);
  try {
    await Promise.all([
      waitForStrictResponse(wrappedMessage, anyProcess, isSubprocess),
      sendMethod(wrappedMessage)
    ]);
  } catch (error) {
    handleEpipeError({ error, methodName, isSubprocess });
    handleSerializationError({
      error,
      methodName,
      isSubprocess,
      message
    });
    throw error;
  }
};
var getSendMethod = (anyProcess) => {
  if (PROCESS_SEND_METHODS.has(anyProcess)) {
    return PROCESS_SEND_METHODS.get(anyProcess);
  }
  const sendMethod = promisify2(anyProcess.send.bind(anyProcess));
  PROCESS_SEND_METHODS.set(anyProcess, sendMethod);
  return sendMethod;
};
var PROCESS_SEND_METHODS = /* @__PURE__ */ new WeakMap();

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/graceful.js
var sendAbort = (subprocess, message) => {
  const methodName = "cancelSignal";
  validateConnection(methodName, false, subprocess.connected);
  return sendOneMessage({
    anyProcess: subprocess,
    methodName,
    isSubprocess: false,
    wrappedMessage: { type: GRACEFUL_CANCEL_TYPE, message },
    message
  });
};
var getCancelSignal = async ({ anyProcess, channel, isSubprocess, ipc }) => {
  await startIpc({
    anyProcess,
    channel,
    isSubprocess,
    ipc
  });
  return cancelController.signal;
};
var startIpc = async ({ anyProcess, channel, isSubprocess, ipc }) => {
  if (cancelListening) {
    return;
  }
  cancelListening = true;
  if (!ipc) {
    throwOnMissingParent();
    return;
  }
  if (channel === null) {
    abortOnDisconnect();
    return;
  }
  getIpcEmitter(anyProcess, channel, isSubprocess);
  await scheduler2.yield();
};
var cancelListening = false;
var handleAbort = (wrappedMessage) => {
  if (wrappedMessage?.type !== GRACEFUL_CANCEL_TYPE) {
    return false;
  }
  cancelController.abort(wrappedMessage.message);
  return true;
};
var GRACEFUL_CANCEL_TYPE = "execa:ipc:cancel";
var abortOnDisconnect = () => {
  cancelController.abort(getAbortDisconnectError());
};
var cancelController = new AbortController();

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/graceful.js
var validateGracefulCancel = ({ gracefulCancel, cancelSignal, ipc, serialization }) => {
  if (!gracefulCancel) {
    return;
  }
  if (cancelSignal === void 0) {
    throw new Error("The `cancelSignal` option must be defined when setting the `gracefulCancel` option.");
  }
  if (!ipc) {
    throw new Error("The `ipc` option cannot be false when setting the `gracefulCancel` option.");
  }
  if (serialization === "json") {
    throw new Error("The `serialization` option cannot be 'json' when setting the `gracefulCancel` option.");
  }
};
var throwOnGracefulCancel = ({
  subprocess,
  cancelSignal,
  gracefulCancel,
  forceKillAfterDelay,
  context,
  controller
}) => gracefulCancel ? [sendOnAbort({
  subprocess,
  cancelSignal,
  forceKillAfterDelay,
  context,
  controller
})] : [];
var sendOnAbort = async ({ subprocess, cancelSignal, forceKillAfterDelay, context, controller: { signal } }) => {
  await onAbortedSignal(cancelSignal, signal);
  const reason = getReason(cancelSignal);
  await sendAbort(subprocess, reason);
  killOnTimeout({
    kill: subprocess.kill,
    forceKillAfterDelay,
    context,
    controllerSignal: signal
  });
  context.terminationReason ??= "gracefulCancel";
  throw cancelSignal.reason;
};
var getReason = ({ reason }) => {
  if (!(reason instanceof DOMException)) {
    return reason;
  }
  const error = new Error(reason.message);
  Object.defineProperty(error, "stack", {
    value: reason.stack,
    enumerable: false,
    configurable: true,
    writable: true
  });
  return error;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/timeout.js
import { setTimeout as setTimeout3 } from "node:timers/promises";
var validateTimeout = ({ timeout }) => {
  if (timeout !== void 0 && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new TypeError(`Expected the \`timeout\` option to be a non-negative integer, got \`${timeout}\` (${typeof timeout})`);
  }
};
var throwOnTimeout = (subprocess, timeout, context, controller) => timeout === 0 || timeout === void 0 ? [] : [killAfterTimeout(subprocess, timeout, context, controller)];
var killAfterTimeout = async (subprocess, timeout, context, { signal }) => {
  await setTimeout3(timeout, void 0, { signal });
  context.terminationReason ??= "timeout";
  subprocess.kill();
  throw new DiscardedError();
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/node.js
import { execPath, execArgv } from "node:process";
import path4 from "node:path";
var mapNode = ({ options }) => {
  if (options.node === false) {
    throw new TypeError('The "node" option cannot be false with `execaNode()`.');
  }
  return { options: { ...options, node: true } };
};
var handleNodeOption = (file, commandArguments, {
  node: shouldHandleNode = false,
  nodePath = execPath,
  nodeOptions = execArgv.filter((nodeOption) => !nodeOption.startsWith("--inspect")),
  cwd,
  execPath: formerNodePath,
  ...options
}) => {
  if (formerNodePath !== void 0) {
    throw new TypeError('The "execPath" option has been removed. Please use the "nodePath" option instead.');
  }
  const normalizedNodePath = safeNormalizeFileUrl(nodePath, 'The "nodePath" option');
  const resolvedNodePath = path4.resolve(cwd, normalizedNodePath);
  const newOptions = {
    ...options,
    nodePath: resolvedNodePath,
    node: shouldHandleNode,
    cwd
  };
  if (!shouldHandleNode) {
    return [file, commandArguments, newOptions];
  }
  if (path4.basename(file, ".exe") === "node") {
    throw new TypeError('When the "node" option is true, the first argument does not need to be "node".');
  }
  return [
    resolvedNodePath,
    [...nodeOptions, file, ...commandArguments],
    { ipc: true, ...newOptions, shell: false }
  ];
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/ipc-input.js
import { serialize } from "node:v8";
var validateIpcInputOption = ({ ipcInput, ipc, serialization }) => {
  if (ipcInput === void 0) {
    return;
  }
  if (!ipc) {
    throw new Error("The `ipcInput` option cannot be set unless the `ipc` option is `true`.");
  }
  validateIpcInput[serialization](ipcInput);
};
var validateAdvancedInput = (ipcInput) => {
  try {
    serialize(ipcInput);
  } catch (error) {
    throw new Error("The `ipcInput` option is not serializable with a structured clone.", { cause: error });
  }
};
var validateJsonInput = (ipcInput) => {
  try {
    JSON.stringify(ipcInput);
  } catch (error) {
    throw new Error("The `ipcInput` option is not serializable with JSON.", { cause: error });
  }
};
var validateIpcInput = {
  advanced: validateAdvancedInput,
  json: validateJsonInput
};
var sendIpcInput = async (subprocess, ipcInput) => {
  if (ipcInput === void 0) {
    return;
  }
  await subprocess.sendMessage(ipcInput);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/encoding-option.js
var validateEncoding = ({ encoding }) => {
  if (ENCODINGS.has(encoding)) {
    return;
  }
  const correctEncoding = getCorrectEncoding(encoding);
  if (correctEncoding !== void 0) {
    throw new TypeError(`Invalid option \`encoding: ${serializeEncoding(encoding)}\`.
Please rename it to ${serializeEncoding(correctEncoding)}.`);
  }
  const correctEncodings = [...ENCODINGS].map((correctEncoding2) => serializeEncoding(correctEncoding2)).join(", ");
  throw new TypeError(`Invalid option \`encoding: ${serializeEncoding(encoding)}\`.
Please rename it to one of: ${correctEncodings}.`);
};
var TEXT_ENCODINGS = /* @__PURE__ */ new Set(["utf8", "utf16le"]);
var BINARY_ENCODINGS = /* @__PURE__ */ new Set(["buffer", "hex", "base64", "base64url", "latin1", "ascii"]);
var ENCODINGS = /* @__PURE__ */ new Set([...TEXT_ENCODINGS, ...BINARY_ENCODINGS]);
var getCorrectEncoding = (encoding) => {
  if (encoding === null) {
    return "buffer";
  }
  if (typeof encoding !== "string") {
    return;
  }
  const lowerEncoding = encoding.toLowerCase();
  if (lowerEncoding in ENCODING_ALIASES) {
    return ENCODING_ALIASES[lowerEncoding];
  }
  if (ENCODINGS.has(lowerEncoding)) {
    return lowerEncoding;
  }
};
var ENCODING_ALIASES = {
  // eslint-disable-next-line unicorn/text-encoding-identifier-case
  "utf-8": "utf8",
  "utf-16le": "utf16le",
  "ucs-2": "utf16le",
  ucs2: "utf16le",
  binary: "latin1"
};
var serializeEncoding = (encoding) => typeof encoding === "string" ? `"${encoding}"` : String(encoding);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/cwd.js
import { statSync } from "node:fs";
import path5 from "node:path";
import process5 from "node:process";
var normalizeCwd = (cwd = getDefaultCwd()) => {
  const cwdString = safeNormalizeFileUrl(cwd, 'The "cwd" option');
  return path5.resolve(cwdString);
};
var getDefaultCwd = () => {
  try {
    return process5.cwd();
  } catch (error) {
    error.message = `The current directory does not exist.
${error.message}`;
    throw error;
  }
};
var fixCwdError = (originalMessage, cwd) => {
  if (cwd === getDefaultCwd()) {
    return originalMessage;
  }
  let cwdStat;
  try {
    cwdStat = statSync(cwd);
  } catch (error) {
    return `The "cwd" option is invalid: ${cwd}.
${error.message}
${originalMessage}`;
  }
  if (!cwdStat.isDirectory()) {
    return `The "cwd" option is not a directory: ${cwd}.
${originalMessage}`;
  }
  return originalMessage;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/options.js
var normalizeOptions = (filePath, rawArguments, rawOptions) => {
  rawOptions.cwd = normalizeCwd(rawOptions.cwd);
  const [processedFile, processedArguments, processedOptions] = handleNodeOption(filePath, rawArguments, rawOptions);
  const { command: file, args: commandArguments, options: initialOptions } = crossSpawn2._parse(processedFile, processedArguments, processedOptions);
  const fdOptions = normalizeFdSpecificOptions(initialOptions);
  const options = addDefaultOptions(fdOptions);
  validateTimeout(options);
  validateEncoding(options);
  validateIpcInputOption(options);
  validateCancelSignal(options);
  validateGracefulCancel(options);
  options.shell = normalizeFileUrl(options.shell);
  options.env = getEnv(options);
  options.killSignal = normalizeKillSignal(options.killSignal);
  options.forceKillAfterDelay = normalizeForceKillAfterDelay(options.forceKillAfterDelay);
  options.lines = options.lines.map((lines, fdNumber) => lines && !BINARY_ENCODINGS.has(options.encoding) && options.buffer[fdNumber]);
  if (process6.platform === "win32" && path6.basename(file, ".exe") === "cmd") {
    commandArguments.unshift("/q");
  }
  return { file, commandArguments, options };
};
var addDefaultOptions = ({
  extendEnv = true,
  preferLocal = false,
  cwd,
  localDir: localDirectory = cwd,
  encoding = "utf8",
  reject = true,
  cleanup = true,
  all = false,
  windowsHide = true,
  killSignal = "SIGTERM",
  forceKillAfterDelay = true,
  gracefulCancel = false,
  ipcInput,
  ipc = ipcInput !== void 0 || gracefulCancel,
  serialization = "advanced",
  ...options
}) => ({
  ...options,
  extendEnv,
  preferLocal,
  cwd,
  localDirectory,
  encoding,
  reject,
  cleanup,
  all,
  windowsHide,
  killSignal,
  forceKillAfterDelay,
  gracefulCancel,
  ipcInput,
  ipc,
  serialization
});
var getEnv = ({ env: envOption, extendEnv, preferLocal, node, localDirectory, nodePath }) => {
  const env = extendEnv ? { ...process6.env, ...envOption } : envOption;
  if (preferLocal || node) {
    return npmRunPathEnv({
      env,
      cwd: localDirectory,
      execPath: nodePath,
      preferLocal,
      addExecPath: node
    });
  }
  return env;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/arguments/shell.js
var concatenateShell = (file, commandArguments, options) => options.shell && commandArguments.length > 0 ? [[file, ...commandArguments].join(" "), [], options] : [file, commandArguments, options];

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/message.js
import { inspect as inspect2 } from "node:util";

// ../../node_modules/.pnpm/strip-final-newline@4.0.0/node_modules/strip-final-newline/index.js
function stripFinalNewline(input) {
  if (typeof input === "string") {
    return stripFinalNewlineString(input);
  }
  if (!(ArrayBuffer.isView(input) && input.BYTES_PER_ELEMENT === 1)) {
    throw new Error("Input must be a string or a Uint8Array");
  }
  return stripFinalNewlineBinary(input);
}
var stripFinalNewlineString = (input) => input.at(-1) === LF ? input.slice(0, input.at(-2) === CR ? -2 : -1) : input;
var stripFinalNewlineBinary = (input) => input.at(-1) === LF_BINARY ? input.subarray(0, input.at(-2) === CR_BINARY ? -2 : -1) : input;
var LF = "\n";
var LF_BINARY = LF.codePointAt(0);
var CR = "\r";
var CR_BINARY = CR.codePointAt(0);

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/index.js
import { on } from "node:events";
import { finished } from "node:stream/promises";

// ../../node_modules/.pnpm/is-stream@4.0.1/node_modules/is-stream/index.js
function isStream(stream, { checkOpen = true } = {}) {
  return stream !== null && typeof stream === "object" && (stream.writable || stream.readable || !checkOpen || stream.writable === void 0 && stream.readable === void 0) && typeof stream.pipe === "function";
}
function isWritableStream(stream, { checkOpen = true } = {}) {
  return isStream(stream, { checkOpen }) && (stream.writable || !checkOpen) && typeof stream.write === "function" && typeof stream.end === "function" && typeof stream.writable === "boolean" && typeof stream.writableObjectMode === "boolean" && typeof stream.destroy === "function" && typeof stream.destroyed === "boolean";
}
function isReadableStream(stream, { checkOpen = true } = {}) {
  return isStream(stream, { checkOpen }) && (stream.readable || !checkOpen) && typeof stream.read === "function" && typeof stream.readable === "boolean" && typeof stream.readableObjectMode === "boolean" && typeof stream.destroy === "function" && typeof stream.destroyed === "boolean";
}
function isDuplexStream(stream, options) {
  return isWritableStream(stream, options) && isReadableStream(stream, options);
}

// ../../node_modules/.pnpm/@sec-ant+readable-stream@0.4.1/node_modules/@sec-ant/readable-stream/dist/ponyfill/asyncIterator.js
var a = Object.getPrototypeOf(
  Object.getPrototypeOf(
    /* istanbul ignore next */
    async function* () {
    }
  ).prototype
);
var c = class {
  #t;
  #n;
  #r = false;
  #e = void 0;
  constructor(e, t) {
    this.#t = e, this.#n = t;
  }
  next() {
    const e = () => this.#s();
    return this.#e = this.#e ? this.#e.then(e, e) : e(), this.#e;
  }
  return(e) {
    const t = () => this.#i(e);
    return this.#e ? this.#e.then(t, t) : t();
  }
  async #s() {
    if (this.#r)
      return {
        done: true,
        value: void 0
      };
    let e;
    try {
      e = await this.#t.read();
    } catch (t) {
      throw this.#e = void 0, this.#r = true, this.#t.releaseLock(), t;
    }
    return e.done && (this.#e = void 0, this.#r = true, this.#t.releaseLock()), e;
  }
  async #i(e) {
    if (this.#r)
      return {
        done: true,
        value: e
      };
    if (this.#r = true, !this.#n) {
      const t = this.#t.cancel(e);
      return this.#t.releaseLock(), await t, {
        done: true,
        value: e
      };
    }
    return this.#t.releaseLock(), {
      done: true,
      value: e
    };
  }
};
var n = /* @__PURE__ */ Symbol();
function i() {
  return this[n].next();
}
Object.defineProperty(i, "name", { value: "next" });
function o(r) {
  return this[n].return(r);
}
Object.defineProperty(o, "name", { value: "return" });
var u = Object.create(a, {
  next: {
    enumerable: true,
    configurable: true,
    writable: true,
    value: i
  },
  return: {
    enumerable: true,
    configurable: true,
    writable: true,
    value: o
  }
});
function h({ preventCancel: r = false } = {}) {
  const e = this.getReader(), t = new c(
    e,
    r
  ), s = Object.create(u);
  return s[n] = t, s;
}

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/stream.js
var getAsyncIterable = (stream) => {
  if (isReadableStream(stream, { checkOpen: false }) && nodeImports.on !== void 0) {
    return getStreamIterable(stream);
  }
  if (typeof stream?.[Symbol.asyncIterator] === "function") {
    return stream;
  }
  if (toString.call(stream) === "[object ReadableStream]") {
    return h.call(stream);
  }
  throw new TypeError("The first argument must be a Readable, a ReadableStream, or an async iterable.");
};
var { toString } = Object.prototype;
var getStreamIterable = async function* (stream) {
  const controller = new AbortController();
  const state = {};
  handleStreamEnd(stream, controller, state);
  try {
    for await (const [chunk] of nodeImports.on(stream, "data", { signal: controller.signal })) {
      yield chunk;
    }
  } catch (error) {
    if (state.error !== void 0) {
      throw state.error;
    } else if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    stream.destroy();
  }
};
var handleStreamEnd = async (stream, controller, state) => {
  try {
    await nodeImports.finished(stream, {
      cleanup: true,
      readable: true,
      writable: false,
      error: false
    });
  } catch (error) {
    state.error = error;
  } finally {
    controller.abort();
  }
};
var nodeImports = {};

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/contents.js
var getStreamContents = async (stream, { init, convertChunk, getSize, truncateChunk, addChunk, getFinalChunk, finalize }, { maxBuffer = Number.POSITIVE_INFINITY } = {}) => {
  const asyncIterable = getAsyncIterable(stream);
  const state = init();
  state.length = 0;
  try {
    for await (const chunk of asyncIterable) {
      const chunkType = getChunkType(chunk);
      const convertedChunk = convertChunk[chunkType](chunk, state);
      appendChunk({
        convertedChunk,
        state,
        getSize,
        truncateChunk,
        addChunk,
        maxBuffer
      });
    }
    appendFinalChunk({
      state,
      convertChunk,
      getSize,
      truncateChunk,
      addChunk,
      getFinalChunk,
      maxBuffer
    });
    return finalize(state);
  } catch (error) {
    const normalizedError = typeof error === "object" && error !== null ? error : new Error(error);
    normalizedError.bufferedData = finalize(state);
    throw normalizedError;
  }
};
var appendFinalChunk = ({ state, getSize, truncateChunk, addChunk, getFinalChunk, maxBuffer }) => {
  const convertedChunk = getFinalChunk(state);
  if (convertedChunk !== void 0) {
    appendChunk({
      convertedChunk,
      state,
      getSize,
      truncateChunk,
      addChunk,
      maxBuffer
    });
  }
};
var appendChunk = ({ convertedChunk, state, getSize, truncateChunk, addChunk, maxBuffer }) => {
  const chunkSize = getSize(convertedChunk);
  const newLength = state.length + chunkSize;
  if (newLength <= maxBuffer) {
    addNewChunk(convertedChunk, state, addChunk, newLength);
    return;
  }
  const truncatedChunk = truncateChunk(convertedChunk, maxBuffer - state.length);
  if (truncatedChunk !== void 0) {
    addNewChunk(truncatedChunk, state, addChunk, maxBuffer);
  }
  throw new MaxBufferError();
};
var addNewChunk = (convertedChunk, state, addChunk, newLength) => {
  state.contents = addChunk(convertedChunk, state, newLength);
  state.length = newLength;
};
var getChunkType = (chunk) => {
  const typeOfChunk = typeof chunk;
  if (typeOfChunk === "string") {
    return "string";
  }
  if (typeOfChunk !== "object" || chunk === null) {
    return "others";
  }
  if (globalThis.Buffer?.isBuffer(chunk)) {
    return "buffer";
  }
  const prototypeName = objectToString2.call(chunk);
  if (prototypeName === "[object ArrayBuffer]") {
    return "arrayBuffer";
  }
  if (prototypeName === "[object DataView]") {
    return "dataView";
  }
  if (Number.isInteger(chunk.byteLength) && Number.isInteger(chunk.byteOffset) && objectToString2.call(chunk.buffer) === "[object ArrayBuffer]") {
    return "typedArray";
  }
  return "others";
};
var { toString: objectToString2 } = Object.prototype;
var MaxBufferError = class extends Error {
  name = "MaxBufferError";
  constructor() {
    super("maxBuffer exceeded");
  }
};

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/utils.js
var identity2 = (value) => value;
var noop = () => void 0;
var getContentsProperty = ({ contents }) => contents;
var throwObjectStream = (chunk) => {
  throw new Error(`Streams in object mode are not supported: ${String(chunk)}`);
};
var getLengthProperty = (convertedChunk) => convertedChunk.length;

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/array.js
async function getStreamAsArray(stream, options) {
  return getStreamContents(stream, arrayMethods, options);
}
var initArray = () => ({ contents: [] });
var increment = () => 1;
var addArrayChunk = (convertedChunk, { contents }) => {
  contents.push(convertedChunk);
  return contents;
};
var arrayMethods = {
  init: initArray,
  convertChunk: {
    string: identity2,
    buffer: identity2,
    arrayBuffer: identity2,
    dataView: identity2,
    typedArray: identity2,
    others: identity2
  },
  getSize: increment,
  truncateChunk: noop,
  addChunk: addArrayChunk,
  getFinalChunk: noop,
  finalize: getContentsProperty
};

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/array-buffer.js
async function getStreamAsArrayBuffer(stream, options) {
  return getStreamContents(stream, arrayBufferMethods, options);
}
var initArrayBuffer = () => ({ contents: new ArrayBuffer(0) });
var useTextEncoder = (chunk) => textEncoder2.encode(chunk);
var textEncoder2 = new TextEncoder();
var useUint8Array = (chunk) => new Uint8Array(chunk);
var useUint8ArrayWithOffset = (chunk) => new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
var truncateArrayBufferChunk = (convertedChunk, chunkSize) => convertedChunk.slice(0, chunkSize);
var addArrayBufferChunk = (convertedChunk, { contents, length: previousLength }, length) => {
  const newContents = hasArrayBufferResize() ? resizeArrayBuffer(contents, length) : resizeArrayBufferSlow(contents, length);
  new Uint8Array(newContents).set(convertedChunk, previousLength);
  return newContents;
};
var resizeArrayBufferSlow = (contents, length) => {
  if (length <= contents.byteLength) {
    return contents;
  }
  const arrayBuffer = new ArrayBuffer(getNewContentsLength(length));
  new Uint8Array(arrayBuffer).set(new Uint8Array(contents), 0);
  return arrayBuffer;
};
var resizeArrayBuffer = (contents, length) => {
  if (length <= contents.maxByteLength) {
    contents.resize(length);
    return contents;
  }
  const arrayBuffer = new ArrayBuffer(length, { maxByteLength: getNewContentsLength(length) });
  new Uint8Array(arrayBuffer).set(new Uint8Array(contents), 0);
  return arrayBuffer;
};
var getNewContentsLength = (length) => SCALE_FACTOR ** Math.ceil(Math.log(length) / Math.log(SCALE_FACTOR));
var SCALE_FACTOR = 2;
var finalizeArrayBuffer = ({ contents, length }) => hasArrayBufferResize() ? contents : contents.slice(0, length);
var hasArrayBufferResize = () => "resize" in ArrayBuffer.prototype;
var arrayBufferMethods = {
  init: initArrayBuffer,
  convertChunk: {
    string: useTextEncoder,
    buffer: useUint8Array,
    arrayBuffer: useUint8Array,
    dataView: useUint8ArrayWithOffset,
    typedArray: useUint8ArrayWithOffset,
    others: throwObjectStream
  },
  getSize: getLengthProperty,
  truncateChunk: truncateArrayBufferChunk,
  addChunk: addArrayBufferChunk,
  getFinalChunk: noop,
  finalize: finalizeArrayBuffer
};

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/string.js
async function getStreamAsString(stream, options) {
  return getStreamContents(stream, stringMethods, options);
}
var initString = () => ({ contents: "", textDecoder: new TextDecoder() });
var useTextDecoder = (chunk, { textDecoder: textDecoder2 }) => textDecoder2.decode(chunk, { stream: true });
var addStringChunk = (convertedChunk, { contents }) => contents + convertedChunk;
var truncateStringChunk = (convertedChunk, chunkSize) => convertedChunk.slice(0, chunkSize);
var getFinalStringChunk = ({ textDecoder: textDecoder2 }) => {
  const finalChunk = textDecoder2.decode();
  return finalChunk === "" ? void 0 : finalChunk;
};
var stringMethods = {
  init: initString,
  convertChunk: {
    string: identity2,
    buffer: useTextDecoder,
    arrayBuffer: useTextDecoder,
    dataView: useTextDecoder,
    typedArray: useTextDecoder,
    others: throwObjectStream
  },
  getSize: getLengthProperty,
  truncateChunk: truncateStringChunk,
  addChunk: addStringChunk,
  getFinalChunk: getFinalStringChunk,
  finalize: getContentsProperty
};

// ../../node_modules/.pnpm/get-stream@9.0.1/node_modules/get-stream/source/index.js
Object.assign(nodeImports, { on, finished });

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/max-buffer.js
var handleMaxBuffer = ({ error, stream, readableObjectMode, lines, encoding, fdNumber }) => {
  if (!(error instanceof MaxBufferError)) {
    throw error;
  }
  if (fdNumber === "all") {
    return error;
  }
  const unit = getMaxBufferUnit(readableObjectMode, lines, encoding);
  error.maxBufferInfo = { fdNumber, unit };
  stream.destroy();
  throw error;
};
var getMaxBufferUnit = (readableObjectMode, lines, encoding) => {
  if (readableObjectMode) {
    return "objects";
  }
  if (lines) {
    return "lines";
  }
  if (encoding === "buffer") {
    return "bytes";
  }
  return "characters";
};
var checkIpcMaxBuffer = (subprocess, ipcOutput, maxBuffer) => {
  if (ipcOutput.length !== maxBuffer) {
    return;
  }
  const error = new MaxBufferError();
  error.maxBufferInfo = { fdNumber: "ipc" };
  throw error;
};
var getMaxBufferMessage = (error, maxBuffer) => {
  const { streamName, threshold, unit } = getMaxBufferInfo(error, maxBuffer);
  return `Command's ${streamName} was larger than ${threshold} ${unit}`;
};
var getMaxBufferInfo = (error, maxBuffer) => {
  if (error?.maxBufferInfo === void 0) {
    return { streamName: "output", threshold: maxBuffer[1], unit: "bytes" };
  }
  const { maxBufferInfo: { fdNumber, unit } } = error;
  delete error.maxBufferInfo;
  const threshold = getFdSpecificValue(maxBuffer, fdNumber);
  if (fdNumber === "ipc") {
    return { streamName: "IPC output", threshold, unit: "messages" };
  }
  return { streamName: getStreamName(fdNumber), threshold, unit };
};
var isMaxBufferSync = (resultError, output, maxBuffer) => resultError?.code === "ENOBUFS" && output !== null && output.some((result) => result !== null && result.length > getMaxBufferSync(maxBuffer));
var truncateMaxBufferSync = (result, isMaxBuffer, maxBuffer) => {
  if (!isMaxBuffer) {
    return result;
  }
  const maxBufferValue = getMaxBufferSync(maxBuffer);
  return result.length > maxBufferValue ? result.slice(0, maxBufferValue) : result;
};
var getMaxBufferSync = ([, stdoutMaxBuffer]) => stdoutMaxBuffer;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/message.js
var createMessages = ({
  stdio,
  all,
  ipcOutput,
  originalError,
  signal,
  signalDescription,
  exitCode,
  escapedCommand,
  timedOut,
  isCanceled,
  isGracefullyCanceled,
  isMaxBuffer,
  isForcefullyTerminated,
  forceKillAfterDelay,
  killSignal,
  maxBuffer,
  timeout,
  cwd
}) => {
  const errorCode = originalError?.code;
  const prefix = getErrorPrefix({
    originalError,
    timedOut,
    timeout,
    isMaxBuffer,
    maxBuffer,
    errorCode,
    signal,
    signalDescription,
    exitCode,
    isCanceled,
    isGracefullyCanceled,
    isForcefullyTerminated,
    forceKillAfterDelay,
    killSignal
  });
  const originalMessage = getOriginalMessage(originalError, cwd);
  const suffix = originalMessage === void 0 ? "" : `
${originalMessage}`;
  const shortMessage = `${prefix}: ${escapedCommand}${suffix}`;
  const messageStdio = all === void 0 ? [stdio[2], stdio[1]] : [all];
  const message = [
    shortMessage,
    ...messageStdio,
    ...stdio.slice(3),
    ipcOutput.map((ipcMessage) => serializeIpcMessage(ipcMessage)).join("\n")
  ].map((messagePart) => escapeLines(stripFinalNewline(serializeMessagePart(messagePart)))).filter(Boolean).join("\n\n");
  return { originalMessage, shortMessage, message };
};
var getErrorPrefix = ({
  originalError,
  timedOut,
  timeout,
  isMaxBuffer,
  maxBuffer,
  errorCode,
  signal,
  signalDescription,
  exitCode,
  isCanceled,
  isGracefullyCanceled,
  isForcefullyTerminated,
  forceKillAfterDelay,
  killSignal
}) => {
  const forcefulSuffix = getForcefulSuffix(isForcefullyTerminated, forceKillAfterDelay);
  if (timedOut) {
    return `Command timed out after ${timeout} milliseconds${forcefulSuffix}`;
  }
  if (isGracefullyCanceled) {
    if (signal === void 0) {
      return `Command was gracefully canceled with exit code ${exitCode}`;
    }
    return isForcefullyTerminated ? `Command was gracefully canceled${forcefulSuffix}` : `Command was gracefully canceled with ${signal} (${signalDescription})`;
  }
  if (isCanceled) {
    return `Command was canceled${forcefulSuffix}`;
  }
  if (isMaxBuffer) {
    return `${getMaxBufferMessage(originalError, maxBuffer)}${forcefulSuffix}`;
  }
  if (errorCode !== void 0) {
    return `Command failed with ${errorCode}${forcefulSuffix}`;
  }
  if (isForcefullyTerminated) {
    return `Command was killed with ${killSignal} (${getSignalDescription(killSignal)})${forcefulSuffix}`;
  }
  if (signal !== void 0) {
    return `Command was killed with ${signal} (${signalDescription})`;
  }
  if (exitCode !== void 0) {
    return `Command failed with exit code ${exitCode}`;
  }
  return "Command failed";
};
var getForcefulSuffix = (isForcefullyTerminated, forceKillAfterDelay) => isForcefullyTerminated ? ` and was forcefully terminated after ${forceKillAfterDelay} milliseconds` : "";
var getOriginalMessage = (originalError, cwd) => {
  if (originalError instanceof DiscardedError) {
    return;
  }
  const originalMessage = isExecaError(originalError) ? originalError.originalMessage : String(originalError?.message ?? originalError);
  const escapedOriginalMessage = escapeLines(fixCwdError(originalMessage, cwd));
  return escapedOriginalMessage === "" ? void 0 : escapedOriginalMessage;
};
var serializeIpcMessage = (ipcMessage) => typeof ipcMessage === "string" ? ipcMessage : inspect2(ipcMessage);
var serializeMessagePart = (messagePart) => Array.isArray(messagePart) ? messagePart.map((messageItem) => stripFinalNewline(serializeMessageItem(messageItem))).filter(Boolean).join("\n") : serializeMessageItem(messagePart);
var serializeMessageItem = (messageItem) => {
  if (typeof messageItem === "string") {
    return messageItem;
  }
  if (isUint8Array(messageItem)) {
    return uint8ArrayToString(messageItem);
  }
  return "";
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/result.js
var makeSuccessResult = ({
  command,
  escapedCommand,
  stdio,
  all,
  ipcOutput,
  options: { cwd },
  startTime
}) => omitUndefinedProperties({
  command,
  escapedCommand,
  cwd,
  durationMs: getDurationMs(startTime),
  failed: false,
  timedOut: false,
  isCanceled: false,
  isGracefullyCanceled: false,
  isTerminated: false,
  isMaxBuffer: false,
  isForcefullyTerminated: false,
  exitCode: 0,
  stdout: stdio[1],
  stderr: stdio[2],
  all,
  stdio,
  ipcOutput,
  pipedFrom: []
});
var makeEarlyError = ({
  error,
  command,
  escapedCommand,
  fileDescriptors,
  options,
  startTime,
  isSync
}) => makeError({
  error,
  command,
  escapedCommand,
  startTime,
  timedOut: false,
  isCanceled: false,
  isGracefullyCanceled: false,
  isMaxBuffer: false,
  isForcefullyTerminated: false,
  stdio: Array.from({ length: fileDescriptors.length }),
  ipcOutput: [],
  options,
  isSync
});
var makeError = ({
  error: originalError,
  command,
  escapedCommand,
  startTime,
  timedOut,
  isCanceled,
  isGracefullyCanceled,
  isMaxBuffer,
  isForcefullyTerminated,
  exitCode: rawExitCode,
  signal: rawSignal,
  stdio,
  all,
  ipcOutput,
  options: {
    timeoutDuration,
    timeout = timeoutDuration,
    forceKillAfterDelay,
    killSignal,
    cwd,
    maxBuffer
  },
  isSync
}) => {
  const { exitCode, signal, signalDescription } = normalizeExitPayload(rawExitCode, rawSignal);
  const { originalMessage, shortMessage, message } = createMessages({
    stdio,
    all,
    ipcOutput,
    originalError,
    signal,
    signalDescription,
    exitCode,
    escapedCommand,
    timedOut,
    isCanceled,
    isGracefullyCanceled,
    isMaxBuffer,
    isForcefullyTerminated,
    forceKillAfterDelay,
    killSignal,
    maxBuffer,
    timeout,
    cwd
  });
  const error = getFinalError(originalError, message, isSync);
  Object.assign(error, getErrorProperties({
    error,
    command,
    escapedCommand,
    startTime,
    timedOut,
    isCanceled,
    isGracefullyCanceled,
    isMaxBuffer,
    isForcefullyTerminated,
    exitCode,
    signal,
    signalDescription,
    stdio,
    all,
    ipcOutput,
    cwd,
    originalMessage,
    shortMessage
  }));
  return error;
};
var getErrorProperties = ({
  error,
  command,
  escapedCommand,
  startTime,
  timedOut,
  isCanceled,
  isGracefullyCanceled,
  isMaxBuffer,
  isForcefullyTerminated,
  exitCode,
  signal,
  signalDescription,
  stdio,
  all,
  ipcOutput,
  cwd,
  originalMessage,
  shortMessage
}) => omitUndefinedProperties({
  shortMessage,
  originalMessage,
  command,
  escapedCommand,
  cwd,
  durationMs: getDurationMs(startTime),
  failed: true,
  timedOut,
  isCanceled,
  isGracefullyCanceled,
  isTerminated: signal !== void 0,
  isMaxBuffer,
  isForcefullyTerminated,
  exitCode,
  signal,
  signalDescription,
  code: error.cause?.code,
  stdout: stdio[1],
  stderr: stdio[2],
  all,
  stdio,
  ipcOutput,
  pipedFrom: []
});
var omitUndefinedProperties = (result) => Object.fromEntries(Object.entries(result).filter(([, value]) => value !== void 0));
var normalizeExitPayload = (rawExitCode, rawSignal) => {
  const exitCode = rawExitCode === null ? void 0 : rawExitCode;
  const signal = rawSignal === null ? void 0 : rawSignal;
  const signalDescription = signal === void 0 ? void 0 : getSignalDescription(rawSignal);
  return { exitCode, signal, signalDescription };
};

// ../../node_modules/.pnpm/parse-ms@4.0.0/node_modules/parse-ms/index.js
var toZeroIfInfinity = (value) => Number.isFinite(value) ? value : 0;
function parseNumber(milliseconds) {
  return {
    days: Math.trunc(milliseconds / 864e5),
    hours: Math.trunc(milliseconds / 36e5 % 24),
    minutes: Math.trunc(milliseconds / 6e4 % 60),
    seconds: Math.trunc(milliseconds / 1e3 % 60),
    milliseconds: Math.trunc(milliseconds % 1e3),
    microseconds: Math.trunc(toZeroIfInfinity(milliseconds * 1e3) % 1e3),
    nanoseconds: Math.trunc(toZeroIfInfinity(milliseconds * 1e6) % 1e3)
  };
}
function parseBigint(milliseconds) {
  return {
    days: milliseconds / 86400000n,
    hours: milliseconds / 3600000n % 24n,
    minutes: milliseconds / 60000n % 60n,
    seconds: milliseconds / 1000n % 60n,
    milliseconds: milliseconds % 1000n,
    microseconds: 0n,
    nanoseconds: 0n
  };
}
function parseMilliseconds(milliseconds) {
  switch (typeof milliseconds) {
    case "number": {
      if (Number.isFinite(milliseconds)) {
        return parseNumber(milliseconds);
      }
      break;
    }
    case "bigint": {
      return parseBigint(milliseconds);
    }
  }
  throw new TypeError("Expected a finite number or bigint");
}

// ../../node_modules/.pnpm/pretty-ms@9.3.1/node_modules/pretty-ms/index.js
var isZero = (value) => value === 0 || value === 0n;
var pluralize = (word, count2) => count2 === 1 || count2 === 1n ? word : `${word}s`;
var SECOND_ROUNDING_EPSILON = 1e-7;
var ONE_DAY_IN_MILLISECONDS = 24n * 60n * 60n * 1000n;
function prettyMilliseconds(milliseconds, options) {
  const isBigInt = typeof milliseconds === "bigint";
  if (!isBigInt && !Number.isFinite(milliseconds)) {
    throw new TypeError("Expected a finite number or bigint");
  }
  options = { ...options };
  const sign = milliseconds < 0 ? "-" : "";
  milliseconds = milliseconds < 0 ? -milliseconds : milliseconds;
  if (options.colonNotation) {
    options.compact = false;
    options.formatSubMilliseconds = false;
    options.separateMilliseconds = false;
    options.verbose = false;
  }
  if (options.compact) {
    options.unitCount = 1;
    options.secondsDecimalDigits = 0;
    options.millisecondsDecimalDigits = 0;
  }
  let result = [];
  const floorDecimals = (value, decimalDigits) => {
    const flooredInterimValue = Math.floor(value * 10 ** decimalDigits + SECOND_ROUNDING_EPSILON);
    const flooredValue = Math.round(flooredInterimValue) / 10 ** decimalDigits;
    return flooredValue.toFixed(decimalDigits);
  };
  const add = (value, long, short, valueString) => {
    if ((result.length === 0 || !options.colonNotation) && isZero(value) && !(options.colonNotation && short === "m")) {
      return;
    }
    valueString ??= String(value);
    if (options.colonNotation) {
      const wholeDigits = valueString.includes(".") ? valueString.split(".")[0].length : valueString.length;
      const minLength = result.length > 0 ? 2 : 1;
      valueString = "0".repeat(Math.max(0, minLength - wholeDigits)) + valueString;
    } else {
      valueString += options.verbose ? " " + pluralize(long, value) : short;
    }
    result.push(valueString);
  };
  const parsed = parseMilliseconds(milliseconds);
  const days = BigInt(parsed.days);
  if (options.hideYearAndDays) {
    add(BigInt(days) * 24n + BigInt(parsed.hours), "hour", "h");
  } else {
    if (options.hideYear) {
      add(days, "day", "d");
    } else {
      add(days / 365n, "year", "y");
      add(days % 365n, "day", "d");
    }
    add(Number(parsed.hours), "hour", "h");
  }
  add(Number(parsed.minutes), "minute", "m");
  if (!options.hideSeconds) {
    if (options.separateMilliseconds || options.formatSubMilliseconds || !options.colonNotation && milliseconds < 1e3 && !options.subSecondsAsDecimals) {
      const seconds = Number(parsed.seconds);
      const milliseconds2 = Number(parsed.milliseconds);
      const microseconds = Number(parsed.microseconds);
      const nanoseconds = Number(parsed.nanoseconds);
      add(seconds, "second", "s");
      if (options.formatSubMilliseconds) {
        add(milliseconds2, "millisecond", "ms");
        add(microseconds, "microsecond", "\xB5s");
        add(nanoseconds, "nanosecond", "ns");
      } else {
        const millisecondsAndBelow = milliseconds2 + microseconds / 1e3 + nanoseconds / 1e6;
        const millisecondsDecimalDigits = typeof options.millisecondsDecimalDigits === "number" ? options.millisecondsDecimalDigits : 0;
        const roundedMilliseconds = millisecondsAndBelow >= 1 ? Math.round(millisecondsAndBelow) : Math.ceil(millisecondsAndBelow);
        const maximumMilliseconds = 1e3 - 10 ** -millisecondsDecimalDigits;
        const millisecondsString = millisecondsDecimalDigits ? Math.min(millisecondsAndBelow, maximumMilliseconds).toFixed(millisecondsDecimalDigits) : Math.min(roundedMilliseconds, maximumMilliseconds);
        add(
          Number.parseFloat(millisecondsString),
          "millisecond",
          "ms",
          millisecondsString
        );
      }
    } else {
      const seconds = (isBigInt ? Number(milliseconds % ONE_DAY_IN_MILLISECONDS) : milliseconds) / 1e3 % 60;
      const secondsDecimalDigits = typeof options.secondsDecimalDigits === "number" ? options.secondsDecimalDigits : 1;
      const secondsFixed = floorDecimals(seconds, secondsDecimalDigits);
      const secondsString = options.keepDecimalsOnWholeSeconds ? secondsFixed : secondsFixed.replace(/\.0+$/, "");
      add(Number.parseFloat(secondsString), "second", "s", secondsString);
    }
  }
  if (result.length === 0) {
    return sign + "0" + (options.verbose ? " milliseconds" : "ms");
  }
  const separator = options.colonNotation ? ":" : " ";
  if (typeof options.unitCount === "number") {
    result = result.slice(0, Math.max(options.unitCount, 1));
  }
  return sign + result.join(separator);
}

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/error.js
var logError = (result, verboseInfo) => {
  if (result.failed) {
    verboseLog({
      type: "error",
      verboseMessage: result.shortMessage,
      verboseInfo,
      result
    });
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/complete.js
var logResult = (result, verboseInfo) => {
  if (!isVerbose(verboseInfo)) {
    return;
  }
  logError(result, verboseInfo);
  logDuration(result, verboseInfo);
};
var logDuration = (result, verboseInfo) => {
  const verboseMessage = `(done in ${prettyMilliseconds(result.durationMs)})`;
  verboseLog({
    type: "duration",
    verboseMessage,
    verboseInfo,
    result
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/reject.js
var handleResult = (result, verboseInfo, { reject }) => {
  logResult(result, verboseInfo);
  if (result.failed && reject) {
    throw result;
  }
  return result;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/handle-sync.js
import { readFileSync as readFileSync2 } from "node:fs";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/type.js
var getStdioItemType = (value, optionName) => {
  if (isAsyncGenerator(value)) {
    return "asyncGenerator";
  }
  if (isSyncGenerator(value)) {
    return "generator";
  }
  if (isUrl(value)) {
    return "fileUrl";
  }
  if (isFilePathObject(value)) {
    return "filePath";
  }
  if (isWebStream(value)) {
    return "webStream";
  }
  if (isStream(value, { checkOpen: false })) {
    return "native";
  }
  if (isUint8Array(value)) {
    return "uint8Array";
  }
  if (isAsyncIterableObject(value)) {
    return "asyncIterable";
  }
  if (isIterableObject(value)) {
    return "iterable";
  }
  if (isTransformStream(value)) {
    return getTransformStreamType({ transform: value }, optionName);
  }
  if (isTransformOptions(value)) {
    return getTransformObjectType(value, optionName);
  }
  return "native";
};
var getTransformObjectType = (value, optionName) => {
  if (isDuplexStream(value.transform, { checkOpen: false })) {
    return getDuplexType(value, optionName);
  }
  if (isTransformStream(value.transform)) {
    return getTransformStreamType(value, optionName);
  }
  return getGeneratorObjectType(value, optionName);
};
var getDuplexType = (value, optionName) => {
  validateNonGeneratorType(value, optionName, "Duplex stream");
  return "duplex";
};
var getTransformStreamType = (value, optionName) => {
  validateNonGeneratorType(value, optionName, "web TransformStream");
  return "webTransform";
};
var validateNonGeneratorType = ({ final, binary, objectMode }, optionName, typeName) => {
  checkUndefinedOption(final, `${optionName}.final`, typeName);
  checkUndefinedOption(binary, `${optionName}.binary`, typeName);
  checkBooleanOption(objectMode, `${optionName}.objectMode`);
};
var checkUndefinedOption = (value, optionName, typeName) => {
  if (value !== void 0) {
    throw new TypeError(`The \`${optionName}\` option can only be defined when using a generator, not a ${typeName}.`);
  }
};
var getGeneratorObjectType = ({ transform, final, binary, objectMode }, optionName) => {
  if (transform !== void 0 && !isGenerator(transform)) {
    throw new TypeError(`The \`${optionName}.transform\` option must be a generator, a Duplex stream or a web TransformStream.`);
  }
  if (isDuplexStream(final, { checkOpen: false })) {
    throw new TypeError(`The \`${optionName}.final\` option must not be a Duplex stream.`);
  }
  if (isTransformStream(final)) {
    throw new TypeError(`The \`${optionName}.final\` option must not be a web TransformStream.`);
  }
  if (final !== void 0 && !isGenerator(final)) {
    throw new TypeError(`The \`${optionName}.final\` option must be a generator.`);
  }
  checkBooleanOption(binary, `${optionName}.binary`);
  checkBooleanOption(objectMode, `${optionName}.objectMode`);
  return isAsyncGenerator(transform) || isAsyncGenerator(final) ? "asyncGenerator" : "generator";
};
var checkBooleanOption = (value, optionName) => {
  if (value !== void 0 && typeof value !== "boolean") {
    throw new TypeError(`The \`${optionName}\` option must use a boolean.`);
  }
};
var isGenerator = (value) => isAsyncGenerator(value) || isSyncGenerator(value);
var isAsyncGenerator = (value) => Object.prototype.toString.call(value) === "[object AsyncGeneratorFunction]";
var isSyncGenerator = (value) => Object.prototype.toString.call(value) === "[object GeneratorFunction]";
var isTransformOptions = (value) => isPlainObject2(value) && (value.transform !== void 0 || value.final !== void 0);
var isUrl = (value) => Object.prototype.toString.call(value) === "[object URL]";
var isRegularUrl = (value) => isUrl(value) && value.protocol !== "file:";
var isFilePathObject = (value) => isPlainObject2(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => FILE_PATH_KEYS.has(key)) && isFilePathString(value.file);
var FILE_PATH_KEYS = /* @__PURE__ */ new Set(["file", "append"]);
var isFilePathString = (file) => typeof file === "string";
var isUnknownStdioString = (type, value) => type === "native" && typeof value === "string" && !KNOWN_STDIO_STRINGS.has(value);
var KNOWN_STDIO_STRINGS = /* @__PURE__ */ new Set(["ipc", "ignore", "inherit", "overlapped", "pipe"]);
var isReadableStream2 = (value) => Object.prototype.toString.call(value) === "[object ReadableStream]";
var isWritableStream2 = (value) => Object.prototype.toString.call(value) === "[object WritableStream]";
var isWebStream = (value) => isReadableStream2(value) || isWritableStream2(value);
var isTransformStream = (value) => isReadableStream2(value?.readable) && isWritableStream2(value?.writable);
var isAsyncIterableObject = (value) => isObject(value) && typeof value[Symbol.asyncIterator] === "function";
var isIterableObject = (value) => isObject(value) && typeof value[Symbol.iterator] === "function";
var isObject = (value) => typeof value === "object" && value !== null;
var TRANSFORM_TYPES = /* @__PURE__ */ new Set(["generator", "asyncGenerator", "duplex", "webTransform"]);
var FILE_TYPES = /* @__PURE__ */ new Set(["fileUrl", "filePath", "fileNumber"]);
var SPECIAL_DUPLICATE_TYPES_SYNC = /* @__PURE__ */ new Set(["fileUrl", "filePath"]);
var SPECIAL_DUPLICATE_TYPES = /* @__PURE__ */ new Set([...SPECIAL_DUPLICATE_TYPES_SYNC, "webStream", "nodeStream"]);
var FORBID_DUPLICATE_TYPES = /* @__PURE__ */ new Set(["webTransform", "duplex"]);
var TYPE_TO_MESSAGE = {
  generator: "a generator",
  asyncGenerator: "an async generator",
  fileUrl: "a file URL",
  filePath: "a file path string",
  fileNumber: "a file descriptor number",
  webStream: "a web stream",
  nodeStream: "a Node.js stream",
  webTransform: "a web TransformStream",
  duplex: "a Duplex stream",
  native: "any value",
  iterable: "an iterable",
  asyncIterable: "an async iterable",
  string: "a string",
  uint8Array: "a Uint8Array"
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/object-mode.js
var getTransformObjectModes = (objectMode, index, newTransforms, direction) => direction === "output" ? getOutputObjectModes(objectMode, index, newTransforms) : getInputObjectModes(objectMode, index, newTransforms);
var getOutputObjectModes = (objectMode, index, newTransforms) => {
  const writableObjectMode = index !== 0 && newTransforms[index - 1].value.readableObjectMode;
  const readableObjectMode = objectMode ?? writableObjectMode;
  return { writableObjectMode, readableObjectMode };
};
var getInputObjectModes = (objectMode, index, newTransforms) => {
  const writableObjectMode = index === 0 ? objectMode === true : newTransforms[index - 1].value.readableObjectMode;
  const readableObjectMode = index !== newTransforms.length - 1 && (objectMode ?? writableObjectMode);
  return { writableObjectMode, readableObjectMode };
};
var getFdObjectMode = (stdioItems, direction) => {
  const lastTransform = stdioItems.findLast(({ type }) => TRANSFORM_TYPES.has(type));
  if (lastTransform === void 0) {
    return false;
  }
  return direction === "input" ? lastTransform.value.writableObjectMode : lastTransform.value.readableObjectMode;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/normalize.js
var normalizeTransforms = (stdioItems, optionName, direction, options) => [
  ...stdioItems.filter(({ type }) => !TRANSFORM_TYPES.has(type)),
  ...getTransforms(stdioItems, optionName, direction, options)
];
var getTransforms = (stdioItems, optionName, direction, { encoding }) => {
  const transforms = stdioItems.filter(({ type }) => TRANSFORM_TYPES.has(type));
  const newTransforms = Array.from({ length: transforms.length });
  for (const [index, stdioItem] of Object.entries(transforms)) {
    newTransforms[index] = normalizeTransform({
      stdioItem,
      index: Number(index),
      newTransforms,
      optionName,
      direction,
      encoding
    });
  }
  return sortTransforms(newTransforms, direction);
};
var normalizeTransform = ({ stdioItem, stdioItem: { type }, index, newTransforms, optionName, direction, encoding }) => {
  if (type === "duplex") {
    return normalizeDuplex({ stdioItem, optionName });
  }
  if (type === "webTransform") {
    return normalizeTransformStream({
      stdioItem,
      index,
      newTransforms,
      direction
    });
  }
  return normalizeGenerator({
    stdioItem,
    index,
    newTransforms,
    direction,
    encoding
  });
};
var normalizeDuplex = ({
  stdioItem,
  stdioItem: {
    value: {
      transform,
      transform: { writableObjectMode, readableObjectMode },
      objectMode = readableObjectMode
    }
  },
  optionName
}) => {
  if (objectMode && !readableObjectMode) {
    throw new TypeError(`The \`${optionName}.objectMode\` option can only be \`true\` if \`new Duplex({objectMode: true})\` is used.`);
  }
  if (!objectMode && readableObjectMode) {
    throw new TypeError(`The \`${optionName}.objectMode\` option cannot be \`false\` if \`new Duplex({objectMode: true})\` is used.`);
  }
  return {
    ...stdioItem,
    value: { transform, writableObjectMode, readableObjectMode }
  };
};
var normalizeTransformStream = ({ stdioItem, stdioItem: { value }, index, newTransforms, direction }) => {
  const { transform, objectMode } = isPlainObject2(value) ? value : { transform: value };
  const { writableObjectMode, readableObjectMode } = getTransformObjectModes(objectMode, index, newTransforms, direction);
  return {
    ...stdioItem,
    value: { transform, writableObjectMode, readableObjectMode }
  };
};
var normalizeGenerator = ({ stdioItem, stdioItem: { value }, index, newTransforms, direction, encoding }) => {
  const {
    transform,
    final,
    binary: binaryOption = false,
    preserveNewlines = false,
    objectMode
  } = isPlainObject2(value) ? value : { transform: value };
  const binary = binaryOption || BINARY_ENCODINGS.has(encoding);
  const { writableObjectMode, readableObjectMode } = getTransformObjectModes(objectMode, index, newTransforms, direction);
  return {
    ...stdioItem,
    value: {
      transform,
      final,
      binary,
      preserveNewlines,
      writableObjectMode,
      readableObjectMode
    }
  };
};
var sortTransforms = (newTransforms, direction) => direction === "input" ? newTransforms.reverse() : newTransforms;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/direction.js
import process7 from "node:process";
var getStreamDirection = (stdioItems, fdNumber, optionName) => {
  const directions = stdioItems.map((stdioItem) => getStdioItemDirection(stdioItem, fdNumber));
  if (directions.includes("input") && directions.includes("output")) {
    throw new TypeError(`The \`${optionName}\` option must not be an array of both readable and writable values.`);
  }
  return directions.find(Boolean) ?? DEFAULT_DIRECTION;
};
var getStdioItemDirection = ({ type, value }, fdNumber) => KNOWN_DIRECTIONS[fdNumber] ?? guessStreamDirection[type](value);
var KNOWN_DIRECTIONS = ["input", "output", "output"];
var anyDirection = () => void 0;
var alwaysInput = () => "input";
var guessStreamDirection = {
  generator: anyDirection,
  asyncGenerator: anyDirection,
  fileUrl: anyDirection,
  filePath: anyDirection,
  iterable: alwaysInput,
  asyncIterable: alwaysInput,
  uint8Array: alwaysInput,
  webStream: (value) => isWritableStream2(value) ? "output" : "input",
  nodeStream(value) {
    if (!isReadableStream(value, { checkOpen: false })) {
      return "output";
    }
    return isWritableStream(value, { checkOpen: false }) ? void 0 : "input";
  },
  webTransform: anyDirection,
  duplex: anyDirection,
  native(value) {
    const standardStreamDirection = getStandardStreamDirection(value);
    if (standardStreamDirection !== void 0) {
      return standardStreamDirection;
    }
    if (isStream(value, { checkOpen: false })) {
      return guessStreamDirection.nodeStream(value);
    }
  }
};
var getStandardStreamDirection = (value) => {
  if ([0, process7.stdin].includes(value)) {
    return "input";
  }
  if ([1, 2, process7.stdout, process7.stderr].includes(value)) {
    return "output";
  }
};
var DEFAULT_DIRECTION = "output";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/array.js
var normalizeIpcStdioArray = (stdioArray, ipc) => ipc && !stdioArray.includes("ipc") ? [...stdioArray, "ipc"] : stdioArray;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/stdio-option.js
var normalizeStdioOption = ({ stdio, ipc, buffer, ...options }, verboseInfo, isSync) => {
  const stdioArray = getStdioArray(stdio, options).map((stdioOption, fdNumber) => addDefaultValue2(stdioOption, fdNumber));
  return isSync ? normalizeStdioSync(stdioArray, buffer, verboseInfo) : normalizeIpcStdioArray(stdioArray, ipc);
};
var getStdioArray = (stdio, options) => {
  if (stdio === void 0) {
    return STANDARD_STREAMS_ALIASES.map((alias) => options[alias]);
  }
  if (hasAlias(options)) {
    throw new Error(`It's not possible to provide \`stdio\` in combination with one of ${STANDARD_STREAMS_ALIASES.map((alias) => `\`${alias}\``).join(", ")}`);
  }
  if (typeof stdio === "string") {
    return [stdio, stdio, stdio];
  }
  if (!Array.isArray(stdio)) {
    throw new TypeError(`Expected \`stdio\` to be of type \`string\` or \`Array\`, got \`${typeof stdio}\``);
  }
  const length = Math.max(stdio.length, STANDARD_STREAMS_ALIASES.length);
  return Array.from({ length }, (_, fdNumber) => stdio[fdNumber]);
};
var hasAlias = (options) => STANDARD_STREAMS_ALIASES.some((alias) => options[alias] !== void 0);
var addDefaultValue2 = (stdioOption, fdNumber) => {
  if (Array.isArray(stdioOption)) {
    return stdioOption.map((item) => addDefaultValue2(item, fdNumber));
  }
  if (stdioOption === null || stdioOption === void 0) {
    return fdNumber >= STANDARD_STREAMS_ALIASES.length ? "ignore" : "pipe";
  }
  return stdioOption;
};
var normalizeStdioSync = (stdioArray, buffer, verboseInfo) => stdioArray.map((stdioOption, fdNumber) => !buffer[fdNumber] && fdNumber !== 0 && !isFullVerbose(verboseInfo, fdNumber) && isOutputPipeOnly(stdioOption) ? "ignore" : stdioOption);
var isOutputPipeOnly = (stdioOption) => stdioOption === "pipe" || Array.isArray(stdioOption) && stdioOption.every((item) => item === "pipe");

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/native.js
import { readFileSync } from "node:fs";
import tty2 from "node:tty";
var handleNativeStream = ({ stdioItem, stdioItem: { type }, isStdioArray, fdNumber, direction, isSync }) => {
  if (!isStdioArray || type !== "native") {
    return stdioItem;
  }
  return isSync ? handleNativeStreamSync({ stdioItem, fdNumber, direction }) : handleNativeStreamAsync({ stdioItem, fdNumber });
};
var handleNativeStreamSync = ({ stdioItem, stdioItem: { value, optionName }, fdNumber, direction }) => {
  const targetFd = getTargetFd({
    value,
    optionName,
    fdNumber,
    direction
  });
  if (targetFd !== void 0) {
    return targetFd;
  }
  if (isStream(value, { checkOpen: false })) {
    throw new TypeError(`The \`${optionName}: Stream\` option cannot both be an array and include a stream with synchronous methods.`);
  }
  return stdioItem;
};
var getTargetFd = ({ value, optionName, fdNumber, direction }) => {
  const targetFdNumber = getTargetFdNumber(value, fdNumber);
  if (targetFdNumber === void 0) {
    return;
  }
  if (direction === "output") {
    return { type: "fileNumber", value: targetFdNumber, optionName };
  }
  if (tty2.isatty(targetFdNumber)) {
    throw new TypeError(`The \`${optionName}: ${serializeOptionValue(value)}\` option is invalid: it cannot be a TTY with synchronous methods.`);
  }
  return { type: "uint8Array", value: bufferToUint8Array(readFileSync(targetFdNumber)), optionName };
};
var getTargetFdNumber = (value, fdNumber) => {
  if (value === "inherit") {
    return fdNumber;
  }
  if (typeof value === "number") {
    return value;
  }
  const standardStreamIndex = STANDARD_STREAMS.indexOf(value);
  if (standardStreamIndex !== -1) {
    return standardStreamIndex;
  }
};
var handleNativeStreamAsync = ({ stdioItem, stdioItem: { value, optionName }, fdNumber }) => {
  if (value === "inherit") {
    return { type: "nodeStream", value: getStandardStream(fdNumber, value, optionName), optionName };
  }
  if (typeof value === "number") {
    return { type: "nodeStream", value: getStandardStream(value, value, optionName), optionName };
  }
  if (isStream(value, { checkOpen: false })) {
    return { type: "nodeStream", value, optionName };
  }
  return stdioItem;
};
var getStandardStream = (fdNumber, value, optionName) => {
  const standardStream = STANDARD_STREAMS[fdNumber];
  if (standardStream === void 0) {
    throw new TypeError(`The \`${optionName}: ${value}\` option is invalid: no such standard stream.`);
  }
  return standardStream;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/input-option.js
var handleInputOptions = ({ input, inputFile }, fdNumber) => fdNumber === 0 ? [
  ...handleInputOption(input),
  ...handleInputFileOption(inputFile)
] : [];
var handleInputOption = (input) => input === void 0 ? [] : [{
  type: getInputType(input),
  value: input,
  optionName: "input"
}];
var getInputType = (input) => {
  if (isReadableStream(input, { checkOpen: false })) {
    return "nodeStream";
  }
  if (typeof input === "string") {
    return "string";
  }
  if (isUint8Array(input)) {
    return "uint8Array";
  }
  throw new Error("The `input` option must be a string, a Uint8Array or a Node.js Readable stream.");
};
var handleInputFileOption = (inputFile) => inputFile === void 0 ? [] : [{
  ...getInputFileType(inputFile),
  optionName: "inputFile"
}];
var getInputFileType = (inputFile) => {
  if (isUrl(inputFile)) {
    return { type: "fileUrl", value: inputFile };
  }
  if (isFilePathString(inputFile)) {
    return { type: "filePath", value: { file: inputFile } };
  }
  throw new Error("The `inputFile` option must be a file path string or a file URL.");
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/duplicate.js
var filterDuplicates = (stdioItems) => stdioItems.filter((stdioItemOne, indexOne) => stdioItems.every((stdioItemTwo, indexTwo) => stdioItemOne.value !== stdioItemTwo.value || indexOne >= indexTwo || stdioItemOne.type === "generator" || stdioItemOne.type === "asyncGenerator"));
var getDuplicateStream = ({ stdioItem: { type, value, optionName }, direction, fileDescriptors, isSync }) => {
  const otherStdioItems = getOtherStdioItems(fileDescriptors, type);
  if (otherStdioItems.length === 0) {
    return;
  }
  if (isSync) {
    validateDuplicateStreamSync({
      otherStdioItems,
      type,
      value,
      optionName,
      direction
    });
    return;
  }
  if (SPECIAL_DUPLICATE_TYPES.has(type)) {
    return getDuplicateStreamInstance({
      otherStdioItems,
      type,
      value,
      optionName,
      direction
    });
  }
  if (FORBID_DUPLICATE_TYPES.has(type)) {
    validateDuplicateTransform({
      otherStdioItems,
      type,
      value,
      optionName
    });
  }
};
var getOtherStdioItems = (fileDescriptors, type) => fileDescriptors.flatMap(({ direction, stdioItems }) => stdioItems.filter((stdioItem) => stdioItem.type === type).map(((stdioItem) => ({ ...stdioItem, direction }))));
var validateDuplicateStreamSync = ({ otherStdioItems, type, value, optionName, direction }) => {
  if (SPECIAL_DUPLICATE_TYPES_SYNC.has(type)) {
    getDuplicateStreamInstance({
      otherStdioItems,
      type,
      value,
      optionName,
      direction
    });
  }
};
var getDuplicateStreamInstance = ({ otherStdioItems, type, value, optionName, direction }) => {
  const duplicateStdioItems = otherStdioItems.filter((stdioItem) => hasSameValue(stdioItem, value));
  if (duplicateStdioItems.length === 0) {
    return;
  }
  const differentStdioItem = duplicateStdioItems.find((stdioItem) => stdioItem.direction !== direction);
  throwOnDuplicateStream(differentStdioItem, optionName, type);
  return direction === "output" ? duplicateStdioItems[0].stream : void 0;
};
var hasSameValue = ({ type, value }, secondValue) => {
  if (type === "filePath") {
    return value.file === secondValue.file;
  }
  if (type === "fileUrl") {
    return value.href === secondValue.href;
  }
  return value === secondValue;
};
var validateDuplicateTransform = ({ otherStdioItems, type, value, optionName }) => {
  const duplicateStdioItem = otherStdioItems.find(({ value: { transform } }) => transform === value.transform);
  throwOnDuplicateStream(duplicateStdioItem, optionName, type);
};
var throwOnDuplicateStream = (stdioItem, optionName, type) => {
  if (stdioItem !== void 0) {
    throw new TypeError(`The \`${stdioItem.optionName}\` and \`${optionName}\` options must not target ${TYPE_TO_MESSAGE[type]} that is the same.`);
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/handle.js
var handleStdio = (addProperties3, options, verboseInfo, isSync) => {
  const stdio = normalizeStdioOption(options, verboseInfo, isSync);
  const initialFileDescriptors = stdio.map((stdioOption, fdNumber) => getFileDescriptor({
    stdioOption,
    fdNumber,
    options,
    isSync
  }));
  const fileDescriptors = getFinalFileDescriptors({
    initialFileDescriptors,
    addProperties: addProperties3,
    options,
    isSync
  });
  options.stdio = fileDescriptors.map(({ stdioItems }) => forwardStdio(stdioItems));
  return fileDescriptors;
};
var getFileDescriptor = ({ stdioOption, fdNumber, options, isSync }) => {
  const optionName = getStreamName(fdNumber);
  const { stdioItems: initialStdioItems, isStdioArray } = initializeStdioItems({
    stdioOption,
    fdNumber,
    options,
    optionName
  });
  const direction = getStreamDirection(initialStdioItems, fdNumber, optionName);
  const stdioItems = initialStdioItems.map((stdioItem) => handleNativeStream({
    stdioItem,
    isStdioArray,
    fdNumber,
    direction,
    isSync
  }));
  const normalizedStdioItems = normalizeTransforms(stdioItems, optionName, direction, options);
  const objectMode = getFdObjectMode(normalizedStdioItems, direction);
  validateFileObjectMode(normalizedStdioItems, objectMode);
  return { direction, objectMode, stdioItems: normalizedStdioItems };
};
var initializeStdioItems = ({ stdioOption, fdNumber, options, optionName }) => {
  const values = Array.isArray(stdioOption) ? stdioOption : [stdioOption];
  const initialStdioItems = [
    ...values.map((value) => initializeStdioItem(value, optionName)),
    ...handleInputOptions(options, fdNumber)
  ];
  const stdioItems = filterDuplicates(initialStdioItems);
  const isStdioArray = stdioItems.length > 1;
  validateStdioArray(stdioItems, isStdioArray, optionName);
  validateStreams(stdioItems);
  return { stdioItems, isStdioArray };
};
var initializeStdioItem = (value, optionName) => ({
  type: getStdioItemType(value, optionName),
  value,
  optionName
});
var validateStdioArray = (stdioItems, isStdioArray, optionName) => {
  if (stdioItems.length === 0) {
    throw new TypeError(`The \`${optionName}\` option must not be an empty array.`);
  }
  if (!isStdioArray) {
    return;
  }
  for (const { value, optionName: optionName2 } of stdioItems) {
    if (INVALID_STDIO_ARRAY_OPTIONS.has(value)) {
      throw new Error(`The \`${optionName2}\` option must not include \`${value}\`.`);
    }
  }
};
var INVALID_STDIO_ARRAY_OPTIONS = /* @__PURE__ */ new Set(["ignore", "ipc"]);
var validateStreams = (stdioItems) => {
  for (const stdioItem of stdioItems) {
    validateFileStdio(stdioItem);
  }
};
var validateFileStdio = ({ type, value, optionName }) => {
  if (isRegularUrl(value)) {
    throw new TypeError(`The \`${optionName}: URL\` option must use the \`file:\` scheme.
For example, you can use the \`pathToFileURL()\` method of the \`url\` core module.`);
  }
  if (isUnknownStdioString(type, value)) {
    throw new TypeError(`The \`${optionName}: { file: '...' }\` option must be used instead of \`${optionName}: '...'\`.`);
  }
};
var validateFileObjectMode = (stdioItems, objectMode) => {
  if (!objectMode) {
    return;
  }
  const fileStdioItem = stdioItems.find(({ type }) => FILE_TYPES.has(type));
  if (fileStdioItem !== void 0) {
    throw new TypeError(`The \`${fileStdioItem.optionName}\` option cannot use both files and transforms in objectMode.`);
  }
};
var getFinalFileDescriptors = ({ initialFileDescriptors, addProperties: addProperties3, options, isSync }) => {
  const fileDescriptors = [];
  try {
    for (const fileDescriptor of initialFileDescriptors) {
      fileDescriptors.push(getFinalFileDescriptor({
        fileDescriptor,
        fileDescriptors,
        addProperties: addProperties3,
        options,
        isSync
      }));
    }
    return fileDescriptors;
  } catch (error) {
    cleanupCustomStreams(fileDescriptors);
    throw error;
  }
};
var getFinalFileDescriptor = ({
  fileDescriptor: { direction, objectMode, stdioItems },
  fileDescriptors,
  addProperties: addProperties3,
  options,
  isSync
}) => {
  const finalStdioItems = stdioItems.map((stdioItem) => addStreamProperties({
    stdioItem,
    addProperties: addProperties3,
    direction,
    options,
    fileDescriptors,
    isSync
  }));
  return { direction, objectMode, stdioItems: finalStdioItems };
};
var addStreamProperties = ({ stdioItem, addProperties: addProperties3, direction, options, fileDescriptors, isSync }) => {
  const duplicateStream = getDuplicateStream({
    stdioItem,
    direction,
    fileDescriptors,
    isSync
  });
  if (duplicateStream !== void 0) {
    return { ...stdioItem, stream: duplicateStream };
  }
  return {
    ...stdioItem,
    ...addProperties3[direction][stdioItem.type](stdioItem, options)
  };
};
var cleanupCustomStreams = (fileDescriptors) => {
  for (const { stdioItems } of fileDescriptors) {
    for (const { stream } of stdioItems) {
      if (stream !== void 0 && !isStandardStream(stream)) {
        stream.destroy();
      }
    }
  }
};
var forwardStdio = (stdioItems) => {
  if (stdioItems.length > 1) {
    return stdioItems.some(({ value: value2 }) => value2 === "overlapped") ? "overlapped" : "pipe";
  }
  const [{ type, value }] = stdioItems;
  return type === "native" ? value : "pipe";
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/handle-sync.js
var handleStdioSync = (options, verboseInfo) => handleStdio(addPropertiesSync, options, verboseInfo, true);
var forbiddenIfSync = ({ type, optionName }) => {
  throwInvalidSyncValue(optionName, TYPE_TO_MESSAGE[type]);
};
var forbiddenNativeIfSync = ({ optionName, value }) => {
  if (value === "ipc" || value === "overlapped") {
    throwInvalidSyncValue(optionName, `"${value}"`);
  }
  return {};
};
var throwInvalidSyncValue = (optionName, value) => {
  throw new TypeError(`The \`${optionName}\` option cannot be ${value} with synchronous methods.`);
};
var addProperties = {
  generator() {
  },
  asyncGenerator: forbiddenIfSync,
  webStream: forbiddenIfSync,
  nodeStream: forbiddenIfSync,
  webTransform: forbiddenIfSync,
  duplex: forbiddenIfSync,
  asyncIterable: forbiddenIfSync,
  native: forbiddenNativeIfSync
};
var addPropertiesSync = {
  input: {
    ...addProperties,
    fileUrl: ({ value }) => ({ contents: [bufferToUint8Array(readFileSync2(value))] }),
    filePath: ({ value: { file } }) => ({ contents: [bufferToUint8Array(readFileSync2(file))] }),
    fileNumber: forbiddenIfSync,
    iterable: ({ value }) => ({ contents: [...value] }),
    string: ({ value }) => ({ contents: [value] }),
    uint8Array: ({ value }) => ({ contents: [value] })
  },
  output: {
    ...addProperties,
    fileUrl: ({ value }) => ({ path: value }),
    filePath: ({ value: { file, append } }) => ({ path: file, append }),
    fileNumber: ({ value }) => ({ path: value }),
    iterable: forbiddenIfSync,
    string: forbiddenIfSync,
    uint8Array: forbiddenIfSync
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/strip-newline.js
var stripNewline = (value, { stripFinalNewline: stripFinalNewline2 }, fdNumber) => getStripFinalNewline(stripFinalNewline2, fdNumber) && value !== void 0 && !Array.isArray(value) ? stripFinalNewline(value) : value;
var getStripFinalNewline = (stripFinalNewline2, fdNumber) => fdNumber === "all" ? stripFinalNewline2[1] || stripFinalNewline2[2] : stripFinalNewline2[fdNumber];

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/generator.js
import { Transform, getDefaultHighWaterMark } from "node:stream";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/split.js
var getSplitLinesGenerator = (binary, preserveNewlines, skipped, state) => binary || skipped ? void 0 : initializeSplitLines(preserveNewlines, state);
var splitLinesSync = (chunk, preserveNewlines, objectMode) => objectMode ? chunk.flatMap((item) => splitLinesItemSync(item, preserveNewlines)) : splitLinesItemSync(chunk, preserveNewlines);
var splitLinesItemSync = (chunk, preserveNewlines) => {
  const { transform, final } = initializeSplitLines(preserveNewlines, {});
  return [...transform(chunk), ...final()];
};
var initializeSplitLines = (preserveNewlines, state) => {
  state.previousChunks = "";
  return {
    transform: splitGenerator.bind(void 0, state, preserveNewlines),
    final: linesFinal.bind(void 0, state)
  };
};
var splitGenerator = function* (state, preserveNewlines, chunk) {
  if (typeof chunk !== "string") {
    yield chunk;
    return;
  }
  let { previousChunks } = state;
  let start = -1;
  for (let end = 0; end < chunk.length; end += 1) {
    if (chunk[end] === "\n") {
      const newlineLength = getNewlineLength(chunk, end, preserveNewlines, state);
      let line = chunk.slice(start + 1, end + 1 - newlineLength);
      if (previousChunks.length > 0) {
        line = concatString(previousChunks, line);
        previousChunks = "";
      }
      yield line;
      start = end;
    }
  }
  if (start !== chunk.length - 1) {
    previousChunks = concatString(previousChunks, chunk.slice(start + 1));
  }
  state.previousChunks = previousChunks;
};
var getNewlineLength = (chunk, end, preserveNewlines, state) => {
  if (preserveNewlines) {
    return 0;
  }
  state.isWindowsNewline = end !== 0 && chunk[end - 1] === "\r";
  return state.isWindowsNewline ? 2 : 1;
};
var linesFinal = function* ({ previousChunks }) {
  if (previousChunks.length > 0) {
    yield previousChunks;
  }
};
var getAppendNewlineGenerator = ({ binary, preserveNewlines, readableObjectMode, state }) => binary || preserveNewlines || readableObjectMode ? void 0 : { transform: appendNewlineGenerator.bind(void 0, state) };
var appendNewlineGenerator = function* ({ isWindowsNewline = false }, chunk) {
  const { unixNewline, windowsNewline, LF: LF2, concatBytes } = typeof chunk === "string" ? linesStringInfo : linesUint8ArrayInfo;
  if (chunk.at(-1) === LF2) {
    yield chunk;
    return;
  }
  const newline = isWindowsNewline ? windowsNewline : unixNewline;
  yield concatBytes(chunk, newline);
};
var concatString = (firstChunk, secondChunk) => `${firstChunk}${secondChunk}`;
var linesStringInfo = {
  windowsNewline: "\r\n",
  unixNewline: "\n",
  LF: "\n",
  concatBytes: concatString
};
var concatUint8Array = (firstChunk, secondChunk) => {
  const chunk = new Uint8Array(firstChunk.length + secondChunk.length);
  chunk.set(firstChunk, 0);
  chunk.set(secondChunk, firstChunk.length);
  return chunk;
};
var linesUint8ArrayInfo = {
  windowsNewline: new Uint8Array([13, 10]),
  unixNewline: new Uint8Array([10]),
  LF: 10,
  concatBytes: concatUint8Array
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/validate.js
import { Buffer as Buffer2 } from "node:buffer";
var getValidateTransformInput = (writableObjectMode, optionName) => writableObjectMode ? void 0 : validateStringTransformInput.bind(void 0, optionName);
var validateStringTransformInput = function* (optionName, chunk) {
  if (typeof chunk !== "string" && !isUint8Array(chunk) && !Buffer2.isBuffer(chunk)) {
    throw new TypeError(`The \`${optionName}\` option's transform must use "objectMode: true" to receive as input: ${typeof chunk}.`);
  }
  yield chunk;
};
var getValidateTransformReturn = (readableObjectMode, optionName) => readableObjectMode ? validateObjectTransformReturn.bind(void 0, optionName) : validateStringTransformReturn.bind(void 0, optionName);
var validateObjectTransformReturn = function* (optionName, chunk) {
  validateEmptyReturn(optionName, chunk);
  yield chunk;
};
var validateStringTransformReturn = function* (optionName, chunk) {
  validateEmptyReturn(optionName, chunk);
  if (typeof chunk !== "string" && !isUint8Array(chunk)) {
    throw new TypeError(`The \`${optionName}\` option's function must yield a string or an Uint8Array, not ${typeof chunk}.`);
  }
  yield chunk;
};
var validateEmptyReturn = (optionName, chunk) => {
  if (chunk === null || chunk === void 0) {
    throw new TypeError(`The \`${optionName}\` option's function must not call \`yield ${chunk}\`.
Instead, \`yield\` should either be called with a value, or not be called at all. For example:
  if (condition) { yield value; }`);
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/encoding-transform.js
import { Buffer as Buffer3 } from "node:buffer";
import { StringDecoder as StringDecoder4 } from "node:string_decoder";
var getEncodingTransformGenerator = (binary, encoding, skipped) => {
  if (skipped) {
    return;
  }
  if (binary) {
    return { transform: encodingUint8ArrayGenerator.bind(void 0, new TextEncoder()) };
  }
  const stringDecoder = new StringDecoder4(encoding);
  return {
    transform: encodingStringGenerator.bind(void 0, stringDecoder),
    final: encodingStringFinal.bind(void 0, stringDecoder)
  };
};
var encodingUint8ArrayGenerator = function* (textEncoder3, chunk) {
  if (Buffer3.isBuffer(chunk)) {
    yield bufferToUint8Array(chunk);
  } else if (typeof chunk === "string") {
    yield textEncoder3.encode(chunk);
  } else {
    yield chunk;
  }
};
var encodingStringGenerator = function* (stringDecoder, chunk) {
  yield isUint8Array(chunk) ? stringDecoder.write(chunk) : chunk;
};
var encodingStringFinal = function* (stringDecoder) {
  const lastChunk = stringDecoder.end();
  if (lastChunk !== "") {
    yield lastChunk;
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/run-async.js
import { callbackify } from "node:util";
var pushChunks = callbackify(async (getChunks, state, getChunksArguments, transformStream) => {
  state.currentIterable = getChunks(...getChunksArguments);
  try {
    for await (const chunk of state.currentIterable) {
      transformStream.push(chunk);
    }
  } finally {
    delete state.currentIterable;
  }
});
var transformChunk = async function* (chunk, generators, index) {
  if (index === generators.length) {
    yield chunk;
    return;
  }
  const { transform = identityGenerator } = generators[index];
  for await (const transformedChunk of transform(chunk)) {
    yield* transformChunk(transformedChunk, generators, index + 1);
  }
};
var finalChunks = async function* (generators) {
  for (const [index, { final }] of Object.entries(generators)) {
    yield* generatorFinalChunks(final, Number(index), generators);
  }
};
var generatorFinalChunks = async function* (final, index, generators) {
  if (final === void 0) {
    return;
  }
  for await (const finalChunk of final()) {
    yield* transformChunk(finalChunk, generators, index + 1);
  }
};
var destroyTransform = callbackify(async ({ currentIterable }, error) => {
  if (currentIterable !== void 0) {
    await (error ? currentIterable.throw(error) : currentIterable.return());
    return;
  }
  if (error) {
    throw error;
  }
});
var identityGenerator = function* (chunk) {
  yield chunk;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/run-sync.js
var pushChunksSync = (getChunksSync, getChunksArguments, transformStream, done) => {
  try {
    for (const chunk of getChunksSync(...getChunksArguments)) {
      transformStream.push(chunk);
    }
    done();
  } catch (error) {
    done(error);
  }
};
var runTransformSync = (generators, chunks) => [
  ...chunks.flatMap((chunk) => [...transformChunkSync(chunk, generators, 0)]),
  ...finalChunksSync(generators)
];
var transformChunkSync = function* (chunk, generators, index) {
  if (index === generators.length) {
    yield chunk;
    return;
  }
  const { transform = identityGenerator2 } = generators[index];
  for (const transformedChunk of transform(chunk)) {
    yield* transformChunkSync(transformedChunk, generators, index + 1);
  }
};
var finalChunksSync = function* (generators) {
  for (const [index, { final }] of Object.entries(generators)) {
    yield* generatorFinalChunksSync(final, Number(index), generators);
  }
};
var generatorFinalChunksSync = function* (final, index, generators) {
  if (final === void 0) {
    return;
  }
  for (const finalChunk of final()) {
    yield* transformChunkSync(finalChunk, generators, index + 1);
  }
};
var identityGenerator2 = function* (chunk) {
  yield chunk;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/transform/generator.js
var generatorToStream = ({
  value,
  value: { transform, final, writableObjectMode, readableObjectMode },
  optionName
}, { encoding }) => {
  const state = {};
  const generators = addInternalGenerators(value, encoding, optionName);
  const transformAsync = isAsyncGenerator(transform);
  const finalAsync = isAsyncGenerator(final);
  const transformMethod = transformAsync ? pushChunks.bind(void 0, transformChunk, state) : pushChunksSync.bind(void 0, transformChunkSync);
  const finalMethod = transformAsync || finalAsync ? pushChunks.bind(void 0, finalChunks, state) : pushChunksSync.bind(void 0, finalChunksSync);
  const destroyMethod = transformAsync || finalAsync ? destroyTransform.bind(void 0, state) : void 0;
  const stream = new Transform({
    writableObjectMode,
    writableHighWaterMark: getDefaultHighWaterMark(writableObjectMode),
    readableObjectMode,
    readableHighWaterMark: getDefaultHighWaterMark(readableObjectMode),
    transform(chunk, encoding2, done) {
      transformMethod([chunk, generators, 0], this, done);
    },
    flush(done) {
      finalMethod([generators], this, done);
    },
    destroy: destroyMethod
  });
  return { stream };
};
var runGeneratorsSync = (chunks, stdioItems, encoding, isInput) => {
  const generators = stdioItems.filter(({ type }) => type === "generator");
  const reversedGenerators = isInput ? generators.reverse() : generators;
  for (const { value, optionName } of reversedGenerators) {
    const generators2 = addInternalGenerators(value, encoding, optionName);
    chunks = runTransformSync(generators2, chunks);
  }
  return chunks;
};
var addInternalGenerators = ({ transform, final, binary, writableObjectMode, readableObjectMode, preserveNewlines }, encoding, optionName) => {
  const state = {};
  return [
    { transform: getValidateTransformInput(writableObjectMode, optionName) },
    getEncodingTransformGenerator(binary, encoding, writableObjectMode),
    getSplitLinesGenerator(binary, preserveNewlines, writableObjectMode, state),
    { transform, final },
    { transform: getValidateTransformReturn(readableObjectMode, optionName) },
    getAppendNewlineGenerator({
      binary,
      preserveNewlines,
      readableObjectMode,
      state
    })
  ].filter(Boolean);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/input-sync.js
var addInputOptionsSync = (fileDescriptors, options) => {
  for (const fdNumber of getInputFdNumbers(fileDescriptors)) {
    addInputOptionSync(fileDescriptors, fdNumber, options);
  }
};
var getInputFdNumbers = (fileDescriptors) => new Set(Object.entries(fileDescriptors).filter(([, { direction }]) => direction === "input").map(([fdNumber]) => Number(fdNumber)));
var addInputOptionSync = (fileDescriptors, fdNumber, options) => {
  const { stdioItems } = fileDescriptors[fdNumber];
  const allStdioItems = stdioItems.filter(({ contents }) => contents !== void 0);
  if (allStdioItems.length === 0) {
    return;
  }
  if (fdNumber !== 0) {
    const [{ type, optionName }] = allStdioItems;
    throw new TypeError(`Only the \`stdin\` option, not \`${optionName}\`, can be ${TYPE_TO_MESSAGE[type]} with synchronous methods.`);
  }
  const allContents = allStdioItems.map(({ contents }) => contents);
  const transformedContents = allContents.map((contents) => applySingleInputGeneratorsSync(contents, stdioItems));
  options.input = joinToUint8Array(transformedContents);
};
var applySingleInputGeneratorsSync = (contents, stdioItems) => {
  const newContents = runGeneratorsSync(contents, stdioItems, "utf8", true);
  validateSerializable(newContents);
  return joinToUint8Array(newContents);
};
var validateSerializable = (newContents) => {
  const invalidItem = newContents.find((item) => typeof item !== "string" && !isUint8Array(item));
  if (invalidItem !== void 0) {
    throw new TypeError(`The \`stdin\` option is invalid: when passing objects as input, a transform must be used to serialize them to strings or Uint8Arrays: ${invalidItem}.`);
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/output-sync.js
import { writeFileSync, appendFileSync } from "node:fs";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/output.js
var shouldLogOutput = ({ stdioItems, encoding, verboseInfo, fdNumber }) => fdNumber !== "all" && isFullVerbose(verboseInfo, fdNumber) && !BINARY_ENCODINGS.has(encoding) && fdUsesVerbose(fdNumber) && (stdioItems.some(({ type, value }) => type === "native" && PIPED_STDIO_VALUES.has(value)) || stdioItems.every(({ type }) => TRANSFORM_TYPES.has(type)));
var fdUsesVerbose = (fdNumber) => fdNumber === 1 || fdNumber === 2;
var PIPED_STDIO_VALUES = /* @__PURE__ */ new Set(["pipe", "overlapped"]);
var logLines = async (linesIterable, stream, fdNumber, verboseInfo) => {
  for await (const line of linesIterable) {
    if (!isPipingStream(stream)) {
      logLine(line, fdNumber, verboseInfo);
    }
  }
};
var logLinesSync = (linesArray, fdNumber, verboseInfo) => {
  for (const line of linesArray) {
    logLine(line, fdNumber, verboseInfo);
  }
};
var isPipingStream = (stream) => stream._readableState.pipes.length > 0;
var logLine = (line, fdNumber, verboseInfo) => {
  const verboseMessage = serializeVerboseMessage(line);
  verboseLog({
    type: "output",
    verboseMessage,
    fdNumber,
    verboseInfo
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/output-sync.js
var transformOutputSync = ({ fileDescriptors, syncResult: { output }, options, isMaxBuffer, verboseInfo }) => {
  if (output === null) {
    return { output: Array.from({ length: 3 }) };
  }
  const state = {};
  const outputFiles = /* @__PURE__ */ new Set([]);
  const transformedOutput = output.map((result, fdNumber) => transformOutputResultSync({
    result,
    fileDescriptors,
    fdNumber,
    state,
    outputFiles,
    isMaxBuffer,
    verboseInfo
  }, options));
  return { output: transformedOutput, ...state };
};
var transformOutputResultSync = ({ result, fileDescriptors, fdNumber, state, outputFiles, isMaxBuffer, verboseInfo }, { buffer, encoding, lines, stripFinalNewline: stripFinalNewline2, maxBuffer }) => {
  if (result === null) {
    return;
  }
  const truncatedResult = truncateMaxBufferSync(result, isMaxBuffer, maxBuffer);
  const uint8ArrayResult = bufferToUint8Array(truncatedResult);
  const { stdioItems, objectMode } = fileDescriptors[fdNumber];
  const chunks = runOutputGeneratorsSync([uint8ArrayResult], stdioItems, encoding, state);
  const { serializedResult, finalResult = serializedResult } = serializeChunks({
    chunks,
    objectMode,
    encoding,
    lines,
    stripFinalNewline: stripFinalNewline2,
    fdNumber
  });
  logOutputSync({
    serializedResult,
    fdNumber,
    state,
    verboseInfo,
    encoding,
    stdioItems,
    objectMode
  });
  const returnedResult = buffer[fdNumber] ? finalResult : void 0;
  try {
    if (state.error === void 0) {
      writeToFiles(serializedResult, stdioItems, outputFiles);
    }
    return returnedResult;
  } catch (error) {
    state.error = error;
    return returnedResult;
  }
};
var runOutputGeneratorsSync = (chunks, stdioItems, encoding, state) => {
  try {
    return runGeneratorsSync(chunks, stdioItems, encoding, false);
  } catch (error) {
    state.error = error;
    return chunks;
  }
};
var serializeChunks = ({ chunks, objectMode, encoding, lines, stripFinalNewline: stripFinalNewline2, fdNumber }) => {
  if (objectMode) {
    return { serializedResult: chunks };
  }
  if (encoding === "buffer") {
    return { serializedResult: joinToUint8Array(chunks) };
  }
  const serializedResult = joinToString(chunks, encoding);
  if (lines[fdNumber]) {
    return { serializedResult, finalResult: splitLinesSync(serializedResult, !stripFinalNewline2[fdNumber], objectMode) };
  }
  return { serializedResult };
};
var logOutputSync = ({ serializedResult, fdNumber, state, verboseInfo, encoding, stdioItems, objectMode }) => {
  if (!shouldLogOutput({
    stdioItems,
    encoding,
    verboseInfo,
    fdNumber
  })) {
    return;
  }
  const linesArray = splitLinesSync(serializedResult, false, objectMode);
  try {
    logLinesSync(linesArray, fdNumber, verboseInfo);
  } catch (error) {
    state.error ??= error;
  }
};
var writeToFiles = (serializedResult, stdioItems, outputFiles) => {
  for (const { path: path9, append } of stdioItems.filter(({ type }) => FILE_TYPES.has(type))) {
    const pathString = typeof path9 === "string" ? path9 : path9.toString();
    if (append || outputFiles.has(pathString)) {
      appendFileSync(path9, serializedResult);
    } else {
      outputFiles.add(pathString);
      writeFileSync(path9, serializedResult);
    }
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/all-sync.js
var getAllSync = ([, stdout, stderr], options) => {
  if (!options.all) {
    return;
  }
  if (stdout === void 0) {
    return stderr;
  }
  if (stderr === void 0) {
    return stdout;
  }
  if (Array.isArray(stdout)) {
    return Array.isArray(stderr) ? [...stdout, ...stderr] : [...stdout, stripNewline(stderr, options, "all")];
  }
  if (Array.isArray(stderr)) {
    return [stripNewline(stdout, options, "all"), ...stderr];
  }
  if (isUint8Array(stdout) && isUint8Array(stderr)) {
    return concatUint8Arrays([stdout, stderr]);
  }
  return `${stdout}${stderr}`;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/exit-async.js
import { once as once4 } from "node:events";
var waitForExit = async (subprocess, context) => {
  const [exitCode, signal] = await waitForExitOrError(subprocess);
  context.isForcefullyTerminated ??= false;
  return [exitCode, signal];
};
var waitForExitOrError = async (subprocess) => {
  const [spawnPayload, exitPayload] = await Promise.allSettled([
    once4(subprocess, "spawn"),
    once4(subprocess, "exit")
  ]);
  if (spawnPayload.status === "rejected") {
    return [];
  }
  return exitPayload.status === "rejected" ? waitForSubprocessExit(subprocess) : exitPayload.value;
};
var waitForSubprocessExit = async (subprocess) => {
  try {
    return await once4(subprocess, "exit");
  } catch {
    return waitForSubprocessExit(subprocess);
  }
};
var waitForSuccessfulExit = async (exitPromise) => {
  const [exitCode, signal] = await exitPromise;
  if (!isSubprocessErrorExit(exitCode, signal) && isFailedExit(exitCode, signal)) {
    throw new DiscardedError();
  }
  return [exitCode, signal];
};
var isSubprocessErrorExit = (exitCode, signal) => exitCode === void 0 && signal === void 0;
var isFailedExit = (exitCode, signal) => exitCode !== 0 || signal !== null;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/exit-sync.js
var getExitResultSync = ({ error, status: exitCode, signal, output }, { maxBuffer }) => {
  const resultError = getResultError(error, exitCode, signal);
  const timedOut = resultError?.code === "ETIMEDOUT";
  const isMaxBuffer = isMaxBufferSync(resultError, output, maxBuffer);
  return {
    resultError,
    exitCode,
    signal,
    timedOut,
    isMaxBuffer
  };
};
var getResultError = (error, exitCode, signal) => {
  if (error !== void 0) {
    return error;
  }
  return isFailedExit(exitCode, signal) ? new DiscardedError() : void 0;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/main-sync.js
var execaCoreSync = (rawFile, rawArguments, rawOptions) => {
  const { file, commandArguments, command, escapedCommand, startTime, verboseInfo, options, fileDescriptors } = handleSyncArguments(rawFile, rawArguments, rawOptions);
  const result = spawnSubprocessSync({
    file,
    commandArguments,
    options,
    command,
    escapedCommand,
    verboseInfo,
    fileDescriptors,
    startTime
  });
  return handleResult(result, verboseInfo, options);
};
var handleSyncArguments = (rawFile, rawArguments, rawOptions) => {
  const { command, escapedCommand, startTime, verboseInfo } = handleCommand(rawFile, rawArguments, rawOptions);
  const syncOptions = normalizeSyncOptions(rawOptions);
  const { file, commandArguments, options } = normalizeOptions(rawFile, rawArguments, syncOptions);
  validateSyncOptions(options);
  const fileDescriptors = handleStdioSync(options, verboseInfo);
  return {
    file,
    commandArguments,
    command,
    escapedCommand,
    startTime,
    verboseInfo,
    options,
    fileDescriptors
  };
};
var normalizeSyncOptions = (options) => options.node && !options.ipc ? { ...options, ipc: false } : options;
var validateSyncOptions = ({ ipc, ipcInput, detached, cancelSignal }) => {
  if (ipcInput) {
    throwInvalidSyncOption("ipcInput");
  }
  if (ipc) {
    throwInvalidSyncOption("ipc: true");
  }
  if (detached) {
    throwInvalidSyncOption("detached: true");
  }
  if (cancelSignal) {
    throwInvalidSyncOption("cancelSignal");
  }
};
var throwInvalidSyncOption = (value) => {
  throw new TypeError(`The "${value}" option cannot be used with synchronous methods.`);
};
var spawnSubprocessSync = ({ file, commandArguments, options, command, escapedCommand, verboseInfo, fileDescriptors, startTime }) => {
  const syncResult = runSubprocessSync({
    file,
    commandArguments,
    options,
    command,
    escapedCommand,
    fileDescriptors,
    startTime
  });
  if (syncResult.failed) {
    return syncResult;
  }
  const { resultError, exitCode, signal, timedOut, isMaxBuffer } = getExitResultSync(syncResult, options);
  const { output, error = resultError } = transformOutputSync({
    fileDescriptors,
    syncResult,
    options,
    isMaxBuffer,
    verboseInfo
  });
  const stdio = output.map((stdioOutput, fdNumber) => stripNewline(stdioOutput, options, fdNumber));
  const all = stripNewline(getAllSync(output, options), options, "all");
  return getSyncResult({
    error,
    exitCode,
    signal,
    timedOut,
    isMaxBuffer,
    stdio,
    all,
    options,
    command,
    escapedCommand,
    startTime
  });
};
var runSubprocessSync = ({ file, commandArguments, options, command, escapedCommand, fileDescriptors, startTime }) => {
  try {
    addInputOptionsSync(fileDescriptors, options);
    const normalizedOptions = normalizeSpawnSyncOptions(options);
    return spawnSync(...concatenateShell(file, commandArguments, normalizedOptions));
  } catch (error) {
    return makeEarlyError({
      error,
      command,
      escapedCommand,
      fileDescriptors,
      options,
      startTime,
      isSync: true
    });
  }
};
var normalizeSpawnSyncOptions = ({ encoding, maxBuffer, ...options }) => ({ ...options, encoding: "buffer", maxBuffer: getMaxBufferSync(maxBuffer) });
var getSyncResult = ({ error, exitCode, signal, timedOut, isMaxBuffer, stdio, all, options, command, escapedCommand, startTime }) => error === void 0 ? makeSuccessResult({
  command,
  escapedCommand,
  stdio,
  all,
  ipcOutput: [],
  options,
  startTime
}) : makeError({
  error,
  command,
  escapedCommand,
  timedOut,
  isCanceled: false,
  isGracefullyCanceled: false,
  isMaxBuffer,
  isForcefullyTerminated: false,
  exitCode,
  signal,
  stdio,
  all,
  ipcOutput: [],
  options,
  startTime,
  isSync: true
});

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/main-async.js
import { setMaxListeners } from "node:events";
import { spawn } from "node:child_process";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/methods.js
import process8 from "node:process";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/get-one.js
import { once as once5, on as on2 } from "node:events";
var getOneMessage = ({ anyProcess, channel, isSubprocess, ipc }, { reference = true, filter } = {}) => {
  validateIpcMethod({
    methodName: "getOneMessage",
    isSubprocess,
    ipc,
    isConnected: isConnected(anyProcess)
  });
  return getOneMessageAsync({
    anyProcess,
    channel,
    isSubprocess,
    filter,
    reference
  });
};
var getOneMessageAsync = async ({ anyProcess, channel, isSubprocess, filter, reference }) => {
  addReference(channel, reference);
  const ipcEmitter = getIpcEmitter(anyProcess, channel, isSubprocess);
  const controller = new AbortController();
  try {
    return await Promise.race([
      getMessage(ipcEmitter, filter, controller),
      throwOnDisconnect2(ipcEmitter, isSubprocess, controller),
      throwOnStrictError(ipcEmitter, isSubprocess, controller)
    ]);
  } catch (error) {
    disconnect(anyProcess);
    throw error;
  } finally {
    controller.abort();
    removeReference(channel, reference);
  }
};
var getMessage = async (ipcEmitter, filter, { signal }) => {
  if (filter === void 0) {
    const [message] = await once5(ipcEmitter, "message", { signal });
    return message;
  }
  for await (const [message] of on2(ipcEmitter, "message", { signal })) {
    if (filter(message)) {
      return message;
    }
  }
};
var throwOnDisconnect2 = async (ipcEmitter, isSubprocess, { signal }) => {
  await once5(ipcEmitter, "disconnect", { signal });
  throwOnEarlyDisconnect(isSubprocess);
};
var throwOnStrictError = async (ipcEmitter, isSubprocess, { signal }) => {
  const [error] = await once5(ipcEmitter, "strict:error", { signal });
  throw getStrictResponseError(error, isSubprocess);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/get-each.js
import { once as once6, on as on3 } from "node:events";
var getEachMessage = ({ anyProcess, channel, isSubprocess, ipc }, { reference = true } = {}) => loopOnMessages({
  anyProcess,
  channel,
  isSubprocess,
  ipc,
  shouldAwait: !isSubprocess,
  reference
});
var loopOnMessages = ({ anyProcess, channel, isSubprocess, ipc, shouldAwait, reference }) => {
  validateIpcMethod({
    methodName: "getEachMessage",
    isSubprocess,
    ipc,
    isConnected: isConnected(anyProcess)
  });
  addReference(channel, reference);
  const ipcEmitter = getIpcEmitter(anyProcess, channel, isSubprocess);
  const controller = new AbortController();
  const state = {};
  stopOnDisconnect(anyProcess, ipcEmitter, controller);
  abortOnStrictError({
    ipcEmitter,
    isSubprocess,
    controller,
    state
  });
  return iterateOnMessages({
    anyProcess,
    channel,
    ipcEmitter,
    isSubprocess,
    shouldAwait,
    controller,
    state,
    reference
  });
};
var stopOnDisconnect = async (anyProcess, ipcEmitter, controller) => {
  try {
    await once6(ipcEmitter, "disconnect", { signal: controller.signal });
    controller.abort();
  } catch {
  }
};
var abortOnStrictError = async ({ ipcEmitter, isSubprocess, controller, state }) => {
  try {
    const [error] = await once6(ipcEmitter, "strict:error", { signal: controller.signal });
    state.error = getStrictResponseError(error, isSubprocess);
    controller.abort();
  } catch {
  }
};
var iterateOnMessages = async function* ({ anyProcess, channel, ipcEmitter, isSubprocess, shouldAwait, controller, state, reference }) {
  try {
    for await (const [message] of on3(ipcEmitter, "message", { signal: controller.signal })) {
      throwIfStrictError(state);
      yield message;
    }
  } catch {
    throwIfStrictError(state);
  } finally {
    controller.abort();
    removeReference(channel, reference);
    if (!isSubprocess) {
      disconnect(anyProcess);
    }
    if (shouldAwait) {
      await anyProcess;
    }
  }
};
var throwIfStrictError = ({ error }) => {
  if (error) {
    throw error;
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/methods.js
var addIpcMethods = (subprocess, { ipc }) => {
  Object.assign(subprocess, getIpcMethods(subprocess, false, ipc));
};
var getIpcExport = () => {
  const anyProcess = process8;
  const isSubprocess = true;
  const ipc = process8.channel !== void 0;
  return {
    ...getIpcMethods(anyProcess, isSubprocess, ipc),
    getCancelSignal: getCancelSignal.bind(void 0, {
      anyProcess,
      channel: anyProcess.channel,
      isSubprocess,
      ipc
    })
  };
};
var getIpcMethods = (anyProcess, isSubprocess, ipc) => ({
  sendMessage: sendMessage.bind(void 0, {
    anyProcess,
    channel: anyProcess.channel,
    isSubprocess,
    ipc
  }),
  getOneMessage: getOneMessage.bind(void 0, {
    anyProcess,
    channel: anyProcess.channel,
    isSubprocess,
    ipc
  }),
  getEachMessage: getEachMessage.bind(void 0, {
    anyProcess,
    channel: anyProcess.channel,
    isSubprocess,
    ipc
  })
});

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/return/early-error.js
import { ChildProcess as ChildProcess2 } from "node:child_process";
import {
  PassThrough,
  Readable,
  Writable,
  Duplex
} from "node:stream";
var handleEarlyError = ({ error, command, escapedCommand, fileDescriptors, options, startTime, verboseInfo }) => {
  cleanupCustomStreams(fileDescriptors);
  const subprocess = new ChildProcess2();
  createDummyStreams(subprocess, fileDescriptors);
  Object.assign(subprocess, { readable, writable, duplex });
  const earlyError = makeEarlyError({
    error,
    command,
    escapedCommand,
    fileDescriptors,
    options,
    startTime,
    isSync: false
  });
  const promise = handleDummyPromise(earlyError, verboseInfo, options);
  return { subprocess, promise };
};
var createDummyStreams = (subprocess, fileDescriptors) => {
  const stdin = createDummyStream();
  const stdout = createDummyStream();
  const stderr = createDummyStream();
  const extraStdio = Array.from({ length: fileDescriptors.length - 3 }, createDummyStream);
  const all = createDummyStream();
  const stdio = [stdin, stdout, stderr, ...extraStdio];
  Object.assign(subprocess, {
    stdin,
    stdout,
    stderr,
    all,
    stdio
  });
};
var createDummyStream = () => {
  const stream = new PassThrough();
  stream.end();
  return stream;
};
var readable = () => new Readable({ read() {
} });
var writable = () => new Writable({ write() {
} });
var duplex = () => new Duplex({ read() {
}, write() {
} });
var handleDummyPromise = async (error, verboseInfo, options) => handleResult(error, verboseInfo, options);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/stdio/handle-async.js
import { createReadStream, createWriteStream } from "node:fs";
import { Buffer as Buffer4 } from "node:buffer";
import { Readable as Readable2, Writable as Writable2, Duplex as Duplex2 } from "node:stream";
var handleStdioAsync = (options, verboseInfo) => handleStdio(addPropertiesAsync, options, verboseInfo, false);
var forbiddenIfAsync = ({ type, optionName }) => {
  throw new TypeError(`The \`${optionName}\` option cannot be ${TYPE_TO_MESSAGE[type]}.`);
};
var addProperties2 = {
  fileNumber: forbiddenIfAsync,
  generator: generatorToStream,
  asyncGenerator: generatorToStream,
  nodeStream: ({ value }) => ({ stream: value }),
  webTransform({ value: { transform, writableObjectMode, readableObjectMode } }) {
    const objectMode = writableObjectMode || readableObjectMode;
    const stream = Duplex2.fromWeb(transform, { objectMode });
    return { stream };
  },
  duplex: ({ value: { transform } }) => ({ stream: transform }),
  native() {
  }
};
var addPropertiesAsync = {
  input: {
    ...addProperties2,
    fileUrl: ({ value }) => ({ stream: createReadStream(value) }),
    filePath: ({ value: { file } }) => ({ stream: createReadStream(file) }),
    webStream: ({ value }) => ({ stream: Readable2.fromWeb(value) }),
    iterable: ({ value }) => ({ stream: Readable2.from(value) }),
    asyncIterable: ({ value }) => ({ stream: Readable2.from(value) }),
    string: ({ value }) => ({ stream: Readable2.from(value) }),
    uint8Array: ({ value }) => ({ stream: Readable2.from(Buffer4.from(value)) })
  },
  output: {
    ...addProperties2,
    fileUrl: ({ value }) => ({ stream: createWriteStream(value) }),
    filePath: ({ value: { file, append } }) => ({ stream: createWriteStream(file, append ? { flags: "a" } : {}) }),
    webStream: ({ value }) => ({ stream: Writable2.fromWeb(value) }),
    iterable: forbiddenIfAsync,
    asyncIterable: forbiddenIfAsync,
    string: forbiddenIfAsync,
    uint8Array: forbiddenIfAsync
  }
};

// ../../node_modules/.pnpm/@sindresorhus+merge-streams@4.0.0/node_modules/@sindresorhus/merge-streams/index.js
import { on as on4, once as once7 } from "node:events";
import { PassThrough as PassThroughStream, getDefaultHighWaterMark as getDefaultHighWaterMark2 } from "node:stream";
import { finished as finished2 } from "node:stream/promises";
function mergeStreams(streams) {
  if (!Array.isArray(streams)) {
    throw new TypeError(`Expected an array, got \`${typeof streams}\`.`);
  }
  for (const stream of streams) {
    validateStream(stream);
  }
  const objectMode = streams.some(({ readableObjectMode }) => readableObjectMode);
  const highWaterMark = getHighWaterMark(streams, objectMode);
  const passThroughStream = new MergedStream({
    objectMode,
    writableHighWaterMark: highWaterMark,
    readableHighWaterMark: highWaterMark
  });
  for (const stream of streams) {
    passThroughStream.add(stream);
  }
  return passThroughStream;
}
var getHighWaterMark = (streams, objectMode) => {
  if (streams.length === 0) {
    return getDefaultHighWaterMark2(objectMode);
  }
  const highWaterMarks = streams.filter(({ readableObjectMode }) => readableObjectMode === objectMode).map(({ readableHighWaterMark }) => readableHighWaterMark);
  return Math.max(...highWaterMarks);
};
var MergedStream = class extends PassThroughStream {
  #streams = /* @__PURE__ */ new Set([]);
  #ended = /* @__PURE__ */ new Set([]);
  #aborted = /* @__PURE__ */ new Set([]);
  #onFinished;
  #unpipeEvent = /* @__PURE__ */ Symbol("unpipe");
  #streamPromises = /* @__PURE__ */ new WeakMap();
  add(stream) {
    validateStream(stream);
    if (this.#streams.has(stream)) {
      return;
    }
    this.#streams.add(stream);
    this.#onFinished ??= onMergedStreamFinished(this, this.#streams, this.#unpipeEvent);
    const streamPromise = endWhenStreamsDone({
      passThroughStream: this,
      stream,
      streams: this.#streams,
      ended: this.#ended,
      aborted: this.#aborted,
      onFinished: this.#onFinished,
      unpipeEvent: this.#unpipeEvent
    });
    this.#streamPromises.set(stream, streamPromise);
    stream.pipe(this, { end: false });
  }
  async remove(stream) {
    validateStream(stream);
    if (!this.#streams.has(stream)) {
      return false;
    }
    const streamPromise = this.#streamPromises.get(stream);
    if (streamPromise === void 0) {
      return false;
    }
    this.#streamPromises.delete(stream);
    stream.unpipe(this);
    await streamPromise;
    return true;
  }
};
var onMergedStreamFinished = async (passThroughStream, streams, unpipeEvent) => {
  updateMaxListeners(passThroughStream, PASSTHROUGH_LISTENERS_COUNT);
  const controller = new AbortController();
  try {
    await Promise.race([
      onMergedStreamEnd(passThroughStream, controller),
      onInputStreamsUnpipe(passThroughStream, streams, unpipeEvent, controller)
    ]);
  } finally {
    controller.abort();
    updateMaxListeners(passThroughStream, -PASSTHROUGH_LISTENERS_COUNT);
  }
};
var onMergedStreamEnd = async (passThroughStream, { signal }) => {
  try {
    await finished2(passThroughStream, { signal, cleanup: true });
  } catch (error) {
    errorOrAbortStream(passThroughStream, error);
    throw error;
  }
};
var onInputStreamsUnpipe = async (passThroughStream, streams, unpipeEvent, { signal }) => {
  for await (const [unpipedStream] of on4(passThroughStream, "unpipe", { signal })) {
    if (streams.has(unpipedStream)) {
      unpipedStream.emit(unpipeEvent);
    }
  }
};
var validateStream = (stream) => {
  if (typeof stream?.pipe !== "function") {
    throw new TypeError(`Expected a readable stream, got: \`${typeof stream}\`.`);
  }
};
var endWhenStreamsDone = async ({ passThroughStream, stream, streams, ended, aborted: aborted2, onFinished, unpipeEvent }) => {
  updateMaxListeners(passThroughStream, PASSTHROUGH_LISTENERS_PER_STREAM);
  const controller = new AbortController();
  try {
    await Promise.race([
      afterMergedStreamFinished(onFinished, stream, controller),
      onInputStreamEnd({
        passThroughStream,
        stream,
        streams,
        ended,
        aborted: aborted2,
        controller
      }),
      onInputStreamUnpipe({
        stream,
        streams,
        ended,
        aborted: aborted2,
        unpipeEvent,
        controller
      })
    ]);
  } finally {
    controller.abort();
    updateMaxListeners(passThroughStream, -PASSTHROUGH_LISTENERS_PER_STREAM);
  }
  if (streams.size > 0 && streams.size === ended.size + aborted2.size) {
    if (ended.size === 0 && aborted2.size > 0) {
      abortStream(passThroughStream);
    } else {
      endStream(passThroughStream);
    }
  }
};
var afterMergedStreamFinished = async (onFinished, stream, { signal }) => {
  try {
    await onFinished;
    if (!signal.aborted) {
      abortStream(stream);
    }
  } catch (error) {
    if (!signal.aborted) {
      errorOrAbortStream(stream, error);
    }
  }
};
var onInputStreamEnd = async ({ passThroughStream, stream, streams, ended, aborted: aborted2, controller: { signal } }) => {
  try {
    await finished2(stream, {
      signal,
      cleanup: true,
      readable: true,
      writable: false
    });
    if (streams.has(stream)) {
      ended.add(stream);
    }
  } catch (error) {
    if (signal.aborted || !streams.has(stream)) {
      return;
    }
    if (isAbortError(error)) {
      aborted2.add(stream);
    } else {
      errorStream(passThroughStream, error);
    }
  }
};
var onInputStreamUnpipe = async ({ stream, streams, ended, aborted: aborted2, unpipeEvent, controller: { signal } }) => {
  await once7(stream, unpipeEvent, { signal });
  if (!stream.readable) {
    return once7(signal, "abort", { signal });
  }
  streams.delete(stream);
  ended.delete(stream);
  aborted2.delete(stream);
};
var endStream = (stream) => {
  if (stream.writable) {
    stream.end();
  }
};
var errorOrAbortStream = (stream, error) => {
  if (isAbortError(error)) {
    abortStream(stream);
  } else {
    errorStream(stream, error);
  }
};
var isAbortError = (error) => error?.code === "ERR_STREAM_PREMATURE_CLOSE";
var abortStream = (stream) => {
  if (stream.readable || stream.writable) {
    stream.destroy();
  }
};
var errorStream = (stream, error) => {
  if (!stream.destroyed) {
    stream.once("error", noop2);
    stream.destroy(error);
  }
};
var noop2 = () => {
};
var updateMaxListeners = (passThroughStream, increment2) => {
  const maxListeners = passThroughStream.getMaxListeners();
  if (maxListeners !== 0 && maxListeners !== Number.POSITIVE_INFINITY) {
    passThroughStream.setMaxListeners(maxListeners + increment2);
  }
};
var PASSTHROUGH_LISTENERS_COUNT = 2;
var PASSTHROUGH_LISTENERS_PER_STREAM = 1;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/pipeline.js
import { finished as finished3 } from "node:stream/promises";
var pipeStreams = (source, destination) => {
  source.pipe(destination);
  onSourceFinish(source, destination);
  onDestinationFinish(source, destination);
};
var onSourceFinish = async (source, destination) => {
  if (isStandardStream(source) || isStandardStream(destination)) {
    return;
  }
  try {
    await finished3(source, { cleanup: true, readable: true, writable: false });
  } catch {
  }
  endDestinationStream(destination);
};
var endDestinationStream = (destination) => {
  if (destination.writable) {
    destination.end();
  }
};
var onDestinationFinish = async (source, destination) => {
  if (isStandardStream(source) || isStandardStream(destination)) {
    return;
  }
  try {
    await finished3(destination, { cleanup: true, readable: false, writable: true });
  } catch {
  }
  abortSourceStream(source);
};
var abortSourceStream = (source) => {
  if (source.readable) {
    source.destroy();
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/output-async.js
var pipeOutputAsync = (subprocess, fileDescriptors, controller) => {
  const pipeGroups = /* @__PURE__ */ new Map();
  for (const [fdNumber, { stdioItems, direction }] of Object.entries(fileDescriptors)) {
    for (const { stream } of stdioItems.filter(({ type }) => TRANSFORM_TYPES.has(type))) {
      pipeTransform(subprocess, stream, direction, fdNumber);
    }
    for (const { stream } of stdioItems.filter(({ type }) => !TRANSFORM_TYPES.has(type))) {
      pipeStdioItem({
        subprocess,
        stream,
        direction,
        fdNumber,
        pipeGroups,
        controller
      });
    }
  }
  for (const [outputStream, inputStreams] of pipeGroups.entries()) {
    const inputStream = inputStreams.length === 1 ? inputStreams[0] : mergeStreams(inputStreams);
    pipeStreams(inputStream, outputStream);
  }
};
var pipeTransform = (subprocess, stream, direction, fdNumber) => {
  if (direction === "output") {
    pipeStreams(subprocess.stdio[fdNumber], stream);
  } else {
    pipeStreams(stream, subprocess.stdio[fdNumber]);
  }
  const streamProperty = SUBPROCESS_STREAM_PROPERTIES[fdNumber];
  if (streamProperty !== void 0) {
    subprocess[streamProperty] = stream;
  }
  subprocess.stdio[fdNumber] = stream;
};
var SUBPROCESS_STREAM_PROPERTIES = ["stdin", "stdout", "stderr"];
var pipeStdioItem = ({ subprocess, stream, direction, fdNumber, pipeGroups, controller }) => {
  if (stream === void 0) {
    return;
  }
  setStandardStreamMaxListeners(stream, controller);
  const [inputStream, outputStream] = direction === "output" ? [stream, subprocess.stdio[fdNumber]] : [subprocess.stdio[fdNumber], stream];
  const outputStreams = pipeGroups.get(inputStream) ?? [];
  pipeGroups.set(inputStream, [...outputStreams, outputStream]);
};
var setStandardStreamMaxListeners = (stream, { signal }) => {
  if (isStandardStream(stream)) {
    incrementMaxListeners(stream, MAX_LISTENERS_INCREMENT, signal);
  }
};
var MAX_LISTENERS_INCREMENT = 2;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/cleanup.js
import { addAbortListener as addAbortListener2 } from "node:events";

// ../../node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/dist/mjs/signals.js
var signals = [];
signals.push("SIGHUP", "SIGINT", "SIGTERM");
if (process.platform !== "win32") {
  signals.push(
    "SIGALRM",
    "SIGABRT",
    "SIGVTALRM",
    "SIGXCPU",
    "SIGXFSZ",
    "SIGUSR2",
    "SIGTRAP",
    "SIGSYS",
    "SIGQUIT",
    "SIGIOT"
    // should detect profiler and enable/disable accordingly.
    // see #21
    // 'SIGPROF'
  );
}
if (process.platform === "linux") {
  signals.push("SIGIO", "SIGPOLL", "SIGPWR", "SIGSTKFLT");
}

// ../../node_modules/.pnpm/signal-exit@4.1.0/node_modules/signal-exit/dist/mjs/index.js
var processOk = (process11) => !!process11 && typeof process11 === "object" && typeof process11.removeListener === "function" && typeof process11.emit === "function" && typeof process11.reallyExit === "function" && typeof process11.listeners === "function" && typeof process11.kill === "function" && typeof process11.pid === "number" && typeof process11.on === "function";
var kExitEmitter = /* @__PURE__ */ Symbol.for("signal-exit emitter");
var global = globalThis;
var ObjectDefineProperty = Object.defineProperty.bind(Object);
var Emitter = class {
  emitted = {
    afterExit: false,
    exit: false
  };
  listeners = {
    afterExit: [],
    exit: []
  };
  count = 0;
  id = Math.random();
  constructor() {
    if (global[kExitEmitter]) {
      return global[kExitEmitter];
    }
    ObjectDefineProperty(global, kExitEmitter, {
      value: this,
      writable: false,
      enumerable: false,
      configurable: false
    });
  }
  on(ev, fn) {
    this.listeners[ev].push(fn);
  }
  removeListener(ev, fn) {
    const list = this.listeners[ev];
    const i2 = list.indexOf(fn);
    if (i2 === -1) {
      return;
    }
    if (i2 === 0 && list.length === 1) {
      list.length = 0;
    } else {
      list.splice(i2, 1);
    }
  }
  emit(ev, code, signal) {
    if (this.emitted[ev]) {
      return false;
    }
    this.emitted[ev] = true;
    let ret = false;
    for (const fn of this.listeners[ev]) {
      ret = fn(code, signal) === true || ret;
    }
    if (ev === "exit") {
      ret = this.emit("afterExit", code, signal) || ret;
    }
    return ret;
  }
};
var SignalExitBase = class {
};
var signalExitWrap = (handler) => {
  return {
    onExit(cb, opts) {
      return handler.onExit(cb, opts);
    },
    load() {
      return handler.load();
    },
    unload() {
      return handler.unload();
    }
  };
};
var SignalExitFallback = class extends SignalExitBase {
  onExit() {
    return () => {
    };
  }
  load() {
  }
  unload() {
  }
};
var SignalExit = class extends SignalExitBase {
  // "SIGHUP" throws an `ENOSYS` error on Windows,
  // so use a supported signal instead
  /* c8 ignore start */
  #hupSig = process9.platform === "win32" ? "SIGINT" : "SIGHUP";
  /* c8 ignore stop */
  #emitter = new Emitter();
  #process;
  #originalProcessEmit;
  #originalProcessReallyExit;
  #sigListeners = {};
  #loaded = false;
  constructor(process11) {
    super();
    this.#process = process11;
    this.#sigListeners = {};
    for (const sig of signals) {
      this.#sigListeners[sig] = () => {
        const listeners = this.#process.listeners(sig);
        let { count: count2 } = this.#emitter;
        const p = process11;
        if (typeof p.__signal_exit_emitter__ === "object" && typeof p.__signal_exit_emitter__.count === "number") {
          count2 += p.__signal_exit_emitter__.count;
        }
        if (listeners.length === count2) {
          this.unload();
          const ret = this.#emitter.emit("exit", null, sig);
          const s = sig === "SIGHUP" ? this.#hupSig : sig;
          if (!ret)
            process11.kill(process11.pid, s);
        }
      };
    }
    this.#originalProcessReallyExit = process11.reallyExit;
    this.#originalProcessEmit = process11.emit;
  }
  onExit(cb, opts) {
    if (!processOk(this.#process)) {
      return () => {
      };
    }
    if (this.#loaded === false) {
      this.load();
    }
    const ev = opts?.alwaysLast ? "afterExit" : "exit";
    this.#emitter.on(ev, cb);
    return () => {
      this.#emitter.removeListener(ev, cb);
      if (this.#emitter.listeners["exit"].length === 0 && this.#emitter.listeners["afterExit"].length === 0) {
        this.unload();
      }
    };
  }
  load() {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    this.#emitter.count += 1;
    for (const sig of signals) {
      try {
        const fn = this.#sigListeners[sig];
        if (fn)
          this.#process.on(sig, fn);
      } catch (_) {
      }
    }
    this.#process.emit = (ev, ...a2) => {
      return this.#processEmit(ev, ...a2);
    };
    this.#process.reallyExit = (code) => {
      return this.#processReallyExit(code);
    };
  }
  unload() {
    if (!this.#loaded) {
      return;
    }
    this.#loaded = false;
    signals.forEach((sig) => {
      const listener = this.#sigListeners[sig];
      if (!listener) {
        throw new Error("Listener not defined for signal: " + sig);
      }
      try {
        this.#process.removeListener(sig, listener);
      } catch (_) {
      }
    });
    this.#process.emit = this.#originalProcessEmit;
    this.#process.reallyExit = this.#originalProcessReallyExit;
    this.#emitter.count -= 1;
  }
  #processReallyExit(code) {
    if (!processOk(this.#process)) {
      return 0;
    }
    this.#process.exitCode = code || 0;
    this.#emitter.emit("exit", this.#process.exitCode, null);
    return this.#originalProcessReallyExit.call(this.#process, this.#process.exitCode);
  }
  #processEmit(ev, ...args) {
    const og = this.#originalProcessEmit;
    if (ev === "exit" && processOk(this.#process)) {
      if (typeof args[0] === "number") {
        this.#process.exitCode = args[0];
      }
      const ret = og.call(this.#process, ev, ...args);
      this.#emitter.emit("exit", this.#process.exitCode, null);
      return ret;
    } else {
      return og.call(this.#process, ev, ...args);
    }
  }
};
var process9 = globalThis.process;
var {
  /**
   * Called when the process is exiting, whether via signal, explicit
   * exit, or running out of stuff to do.
   *
   * If the global process object is not suitable for instrumentation,
   * then this will be a no-op.
   *
   * Returns a function that may be used to unload signal-exit.
   */
  onExit,
  /**
   * Load the listeners.  Likely you never need to call this, unless
   * doing a rather deep integration with signal-exit functionality.
   * Mostly exposed for the benefit of testing.
   *
   * @internal
   */
  load,
  /**
   * Unload the listeners.  Likely you never need to call this, unless
   * doing a rather deep integration with signal-exit functionality.
   * Mostly exposed for the benefit of testing.
   *
   * @internal
   */
  unload
} = signalExitWrap(processOk(process9) ? new SignalExit(process9) : new SignalExitFallback());

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/terminate/cleanup.js
var cleanupOnExit = (subprocess, { cleanup, detached }, { signal }) => {
  if (!cleanup || detached) {
    return;
  }
  const removeExitHandler = onExit(() => {
    subprocess.kill();
  });
  addAbortListener2(signal, () => {
    removeExitHandler();
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/pipe/pipe-arguments.js
var normalizePipeArguments = ({ source, sourcePromise, boundOptions, createNested }, ...pipeArguments) => {
  const startTime = getStartTime();
  const {
    destination,
    destinationStream,
    destinationError,
    from,
    unpipeSignal
  } = getDestinationStream(boundOptions, createNested, pipeArguments);
  const { sourceStream, sourceError } = getSourceStream(source, from);
  const { options: sourceOptions, fileDescriptors } = SUBPROCESS_OPTIONS.get(source);
  return {
    sourcePromise,
    sourceStream,
    sourceOptions,
    sourceError,
    destination,
    destinationStream,
    destinationError,
    unpipeSignal,
    fileDescriptors,
    startTime
  };
};
var getDestinationStream = (boundOptions, createNested, pipeArguments) => {
  try {
    const {
      destination,
      pipeOptions: { from, to, unpipeSignal } = {}
    } = getDestination(boundOptions, createNested, ...pipeArguments);
    const destinationStream = getToStream(destination, to);
    return {
      destination,
      destinationStream,
      from,
      unpipeSignal
    };
  } catch (error) {
    return { destinationError: error };
  }
};
var getDestination = (boundOptions, createNested, firstArgument, ...pipeArguments) => {
  if (Array.isArray(firstArgument)) {
    const destination = createNested(mapDestinationArguments, boundOptions)(firstArgument, ...pipeArguments);
    return { destination, pipeOptions: boundOptions };
  }
  if (typeof firstArgument === "string" || firstArgument instanceof URL || isDenoExecPath(firstArgument)) {
    if (Object.keys(boundOptions).length > 0) {
      throw new TypeError('Please use .pipe("file", ..., options) or .pipe(execa("file", ..., options)) instead of .pipe(options)("file", ...).');
    }
    const [rawFile, rawArguments, rawOptions] = normalizeParameters(firstArgument, ...pipeArguments);
    const destination = createNested(mapDestinationArguments)(rawFile, rawArguments, rawOptions);
    return { destination, pipeOptions: rawOptions };
  }
  if (SUBPROCESS_OPTIONS.has(firstArgument)) {
    if (Object.keys(boundOptions).length > 0) {
      throw new TypeError("Please use .pipe(options)`command` or .pipe($(options)`command`) instead of .pipe(options)($`command`).");
    }
    return { destination: firstArgument, pipeOptions: pipeArguments[0] };
  }
  throw new TypeError(`The first argument must be a template string, an options object, or an Execa subprocess: ${firstArgument}`);
};
var mapDestinationArguments = ({ options }) => ({ options: { ...options, stdin: "pipe", piped: true } });
var getSourceStream = (source, from) => {
  try {
    const sourceStream = getFromStream(source, from);
    return { sourceStream };
  } catch (error) {
    return { sourceError: error };
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/pipe/throw.js
var handlePipeArgumentsError = ({
  sourceStream,
  sourceError,
  destinationStream,
  destinationError,
  fileDescriptors,
  sourceOptions,
  startTime
}) => {
  const error = getPipeArgumentsError({
    sourceStream,
    sourceError,
    destinationStream,
    destinationError
  });
  if (error !== void 0) {
    throw createNonCommandError({
      error,
      fileDescriptors,
      sourceOptions,
      startTime
    });
  }
};
var getPipeArgumentsError = ({ sourceStream, sourceError, destinationStream, destinationError }) => {
  if (sourceError !== void 0 && destinationError !== void 0) {
    return destinationError;
  }
  if (destinationError !== void 0) {
    abortSourceStream(sourceStream);
    return destinationError;
  }
  if (sourceError !== void 0) {
    endDestinationStream(destinationStream);
    return sourceError;
  }
};
var createNonCommandError = ({ error, fileDescriptors, sourceOptions, startTime }) => makeEarlyError({
  error,
  command: PIPE_COMMAND_MESSAGE,
  escapedCommand: PIPE_COMMAND_MESSAGE,
  fileDescriptors,
  options: sourceOptions,
  startTime,
  isSync: false
});
var PIPE_COMMAND_MESSAGE = "source.pipe(destination)";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/pipe/sequence.js
var waitForBothSubprocesses = async (subprocessPromises) => {
  const [
    { status: sourceStatus, reason: sourceReason, value: sourceResult = sourceReason },
    { status: destinationStatus, reason: destinationReason, value: destinationResult = destinationReason }
  ] = await subprocessPromises;
  if (!destinationResult.pipedFrom.includes(sourceResult)) {
    destinationResult.pipedFrom.push(sourceResult);
  }
  if (destinationStatus === "rejected") {
    throw destinationResult;
  }
  if (sourceStatus === "rejected") {
    throw sourceResult;
  }
  return destinationResult;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/pipe/streaming.js
import { finished as finished4 } from "node:stream/promises";
var pipeSubprocessStream = (sourceStream, destinationStream, maxListenersController) => {
  const mergedStream = MERGED_STREAMS.has(destinationStream) ? pipeMoreSubprocessStream(sourceStream, destinationStream) : pipeFirstSubprocessStream(sourceStream, destinationStream);
  incrementMaxListeners(sourceStream, SOURCE_LISTENERS_PER_PIPE, maxListenersController.signal);
  incrementMaxListeners(destinationStream, DESTINATION_LISTENERS_PER_PIPE, maxListenersController.signal);
  cleanupMergedStreamsMap(destinationStream);
  return mergedStream;
};
var pipeFirstSubprocessStream = (sourceStream, destinationStream) => {
  const mergedStream = mergeStreams([sourceStream]);
  pipeStreams(mergedStream, destinationStream);
  MERGED_STREAMS.set(destinationStream, mergedStream);
  return mergedStream;
};
var pipeMoreSubprocessStream = (sourceStream, destinationStream) => {
  const mergedStream = MERGED_STREAMS.get(destinationStream);
  mergedStream.add(sourceStream);
  return mergedStream;
};
var cleanupMergedStreamsMap = async (destinationStream) => {
  try {
    await finished4(destinationStream, { cleanup: true, readable: false, writable: true });
  } catch {
  }
  MERGED_STREAMS.delete(destinationStream);
};
var MERGED_STREAMS = /* @__PURE__ */ new WeakMap();
var SOURCE_LISTENERS_PER_PIPE = 2;
var DESTINATION_LISTENERS_PER_PIPE = 1;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/pipe/abort.js
import { aborted } from "node:util";
var unpipeOnAbort = (unpipeSignal, unpipeContext) => unpipeSignal === void 0 ? [] : [unpipeOnSignalAbort(unpipeSignal, unpipeContext)];
var unpipeOnSignalAbort = async (unpipeSignal, { sourceStream, mergedStream, fileDescriptors, sourceOptions, startTime }) => {
  await aborted(unpipeSignal, sourceStream);
  await mergedStream.remove(sourceStream);
  const error = new Error("Pipe canceled by `unpipeSignal` option.");
  throw createNonCommandError({
    error,
    fileDescriptors,
    sourceOptions,
    startTime
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/pipe/setup.js
var pipeToSubprocess = (sourceInfo, ...pipeArguments) => {
  if (isPlainObject2(pipeArguments[0])) {
    return pipeToSubprocess.bind(void 0, {
      ...sourceInfo,
      boundOptions: { ...sourceInfo.boundOptions, ...pipeArguments[0] }
    });
  }
  const { destination, ...normalizedInfo } = normalizePipeArguments(sourceInfo, ...pipeArguments);
  const promise = handlePipePromise({ ...normalizedInfo, destination });
  promise.pipe = pipeToSubprocess.bind(void 0, {
    ...sourceInfo,
    source: destination,
    sourcePromise: promise,
    boundOptions: {}
  });
  return promise;
};
var handlePipePromise = async ({
  sourcePromise,
  sourceStream,
  sourceOptions,
  sourceError,
  destination,
  destinationStream,
  destinationError,
  unpipeSignal,
  fileDescriptors,
  startTime
}) => {
  const subprocessPromises = getSubprocessPromises(sourcePromise, destination);
  handlePipeArgumentsError({
    sourceStream,
    sourceError,
    destinationStream,
    destinationError,
    fileDescriptors,
    sourceOptions,
    startTime
  });
  const maxListenersController = new AbortController();
  try {
    const mergedStream = pipeSubprocessStream(sourceStream, destinationStream, maxListenersController);
    return await Promise.race([
      waitForBothSubprocesses(subprocessPromises),
      ...unpipeOnAbort(unpipeSignal, {
        sourceStream,
        mergedStream,
        sourceOptions,
        fileDescriptors,
        startTime
      })
    ]);
  } finally {
    maxListenersController.abort();
  }
};
var getSubprocessPromises = (sourcePromise, destination) => Promise.allSettled([sourcePromise, destination]);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/contents.js
import { setImmediate } from "node:timers/promises";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/iterate.js
import { on as on5 } from "node:events";
import { getDefaultHighWaterMark as getDefaultHighWaterMark3 } from "node:stream";
var iterateOnSubprocessStream = ({ subprocessStdout, subprocess, binary, shouldEncode, encoding, preserveNewlines }) => {
  const controller = new AbortController();
  stopReadingOnExit(subprocess, controller);
  return iterateOnStream({
    stream: subprocessStdout,
    controller,
    binary,
    shouldEncode: !subprocessStdout.readableObjectMode && shouldEncode,
    encoding,
    shouldSplit: !subprocessStdout.readableObjectMode,
    preserveNewlines
  });
};
var stopReadingOnExit = async (subprocess, controller) => {
  try {
    await subprocess;
  } catch {
  } finally {
    controller.abort();
  }
};
var iterateForResult = ({ stream, onStreamEnd, lines, encoding, stripFinalNewline: stripFinalNewline2, allMixed }) => {
  const controller = new AbortController();
  stopReadingOnStreamEnd(onStreamEnd, controller, stream);
  const objectMode = stream.readableObjectMode && !allMixed;
  return iterateOnStream({
    stream,
    controller,
    binary: encoding === "buffer",
    shouldEncode: !objectMode,
    encoding,
    shouldSplit: !objectMode && lines,
    preserveNewlines: !stripFinalNewline2
  });
};
var stopReadingOnStreamEnd = async (onStreamEnd, controller, stream) => {
  try {
    await onStreamEnd;
  } catch {
    stream.destroy();
  } finally {
    controller.abort();
  }
};
var iterateOnStream = ({ stream, controller, binary, shouldEncode, encoding, shouldSplit, preserveNewlines }) => {
  const onStdoutChunk = on5(stream, "data", {
    signal: controller.signal,
    highWaterMark: HIGH_WATER_MARK,
    // Backward compatibility with older name for this option
    // See https://github.com/nodejs/node/pull/52080#discussion_r1525227861
    // @todo Remove after removing support for Node 21
    highWatermark: HIGH_WATER_MARK
  });
  return iterateOnData({
    onStdoutChunk,
    controller,
    binary,
    shouldEncode,
    encoding,
    shouldSplit,
    preserveNewlines
  });
};
var DEFAULT_OBJECT_HIGH_WATER_MARK = getDefaultHighWaterMark3(true);
var HIGH_WATER_MARK = DEFAULT_OBJECT_HIGH_WATER_MARK;
var iterateOnData = async function* ({ onStdoutChunk, controller, binary, shouldEncode, encoding, shouldSplit, preserveNewlines }) {
  const generators = getGenerators({
    binary,
    shouldEncode,
    encoding,
    shouldSplit,
    preserveNewlines
  });
  try {
    for await (const [chunk] of onStdoutChunk) {
      yield* transformChunkSync(chunk, generators, 0);
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  } finally {
    yield* finalChunksSync(generators);
  }
};
var getGenerators = ({ binary, shouldEncode, encoding, shouldSplit, preserveNewlines }) => [
  getEncodingTransformGenerator(binary, encoding, !shouldEncode),
  getSplitLinesGenerator(binary, preserveNewlines, !shouldSplit, {})
].filter(Boolean);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/io/contents.js
var getStreamOutput = async ({ stream, onStreamEnd, fdNumber, encoding, buffer, maxBuffer, lines, allMixed, stripFinalNewline: stripFinalNewline2, verboseInfo, streamInfo }) => {
  const logPromise = logOutputAsync({
    stream,
    onStreamEnd,
    fdNumber,
    encoding,
    allMixed,
    verboseInfo,
    streamInfo
  });
  if (!buffer) {
    await Promise.all([resumeStream(stream), logPromise]);
    return;
  }
  const stripFinalNewlineValue = getStripFinalNewline(stripFinalNewline2, fdNumber);
  const iterable = iterateForResult({
    stream,
    onStreamEnd,
    lines,
    encoding,
    stripFinalNewline: stripFinalNewlineValue,
    allMixed
  });
  const [output] = await Promise.all([
    getStreamContents2({
      stream,
      iterable,
      fdNumber,
      encoding,
      maxBuffer,
      lines
    }),
    logPromise
  ]);
  return output;
};
var logOutputAsync = async ({ stream, onStreamEnd, fdNumber, encoding, allMixed, verboseInfo, streamInfo: { fileDescriptors } }) => {
  if (!shouldLogOutput({
    stdioItems: fileDescriptors[fdNumber]?.stdioItems,
    encoding,
    verboseInfo,
    fdNumber
  })) {
    return;
  }
  const linesIterable = iterateForResult({
    stream,
    onStreamEnd,
    lines: true,
    encoding,
    stripFinalNewline: true,
    allMixed
  });
  await logLines(linesIterable, stream, fdNumber, verboseInfo);
};
var resumeStream = async (stream) => {
  await setImmediate();
  if (stream.readableFlowing === null) {
    stream.resume();
  }
};
var getStreamContents2 = async ({ stream, stream: { readableObjectMode }, iterable, fdNumber, encoding, maxBuffer, lines }) => {
  try {
    if (readableObjectMode || lines) {
      return await getStreamAsArray(iterable, { maxBuffer });
    }
    if (encoding === "buffer") {
      return new Uint8Array(await getStreamAsArrayBuffer(iterable, { maxBuffer }));
    }
    return await getStreamAsString(iterable, { maxBuffer });
  } catch (error) {
    return handleBufferedData(handleMaxBuffer({
      error,
      stream,
      readableObjectMode,
      lines,
      encoding,
      fdNumber
    }));
  }
};
var getBufferedData = async (streamPromise) => {
  try {
    return await streamPromise;
  } catch (error) {
    return handleBufferedData(error);
  }
};
var handleBufferedData = ({ bufferedData }) => isArrayBuffer(bufferedData) ? new Uint8Array(bufferedData) : bufferedData;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/wait-stream.js
import { finished as finished5 } from "node:stream/promises";
var waitForStream = async (stream, fdNumber, streamInfo, { isSameDirection, stopOnExit = false } = {}) => {
  const state = handleStdinDestroy(stream, streamInfo);
  const abortController = new AbortController();
  try {
    await Promise.race([
      ...stopOnExit ? [streamInfo.exitPromise] : [],
      finished5(stream, { cleanup: true, signal: abortController.signal })
    ]);
  } catch (error) {
    if (!state.stdinCleanedUp) {
      handleStreamError(error, fdNumber, streamInfo, isSameDirection);
    }
  } finally {
    abortController.abort();
  }
};
var handleStdinDestroy = (stream, { originalStreams: [originalStdin], subprocess }) => {
  const state = { stdinCleanedUp: false };
  if (stream === originalStdin) {
    spyOnStdinDestroy(stream, subprocess, state);
  }
  return state;
};
var spyOnStdinDestroy = (subprocessStdin, subprocess, state) => {
  const { _destroy } = subprocessStdin;
  subprocessStdin._destroy = (...destroyArguments) => {
    setStdinCleanedUp(subprocess, state);
    _destroy.call(subprocessStdin, ...destroyArguments);
  };
};
var setStdinCleanedUp = ({ exitCode, signalCode }, state) => {
  if (exitCode !== null || signalCode !== null) {
    state.stdinCleanedUp = true;
  }
};
var handleStreamError = (error, fdNumber, streamInfo, isSameDirection) => {
  if (!shouldIgnoreStreamError(error, fdNumber, streamInfo, isSameDirection)) {
    throw error;
  }
};
var shouldIgnoreStreamError = (error, fdNumber, streamInfo, isSameDirection = true) => {
  if (streamInfo.propagating) {
    return isStreamEpipe(error) || isStreamAbort(error);
  }
  streamInfo.propagating = true;
  return isInputFileDescriptor(streamInfo, fdNumber) === isSameDirection ? isStreamEpipe(error) : isStreamAbort(error);
};
var isInputFileDescriptor = ({ fileDescriptors }, fdNumber) => fdNumber !== "all" && fileDescriptors[fdNumber].direction === "input";
var isStreamAbort = (error) => error?.code === "ERR_STREAM_PREMATURE_CLOSE";
var isStreamEpipe = (error) => error?.code === "EPIPE";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/stdio.js
var waitForStdioStreams = ({ subprocess, encoding, buffer, maxBuffer, lines, stripFinalNewline: stripFinalNewline2, verboseInfo, streamInfo }) => subprocess.stdio.map((stream, fdNumber) => waitForSubprocessStream({
  stream,
  fdNumber,
  encoding,
  buffer: buffer[fdNumber],
  maxBuffer: maxBuffer[fdNumber],
  lines: lines[fdNumber],
  allMixed: false,
  stripFinalNewline: stripFinalNewline2,
  verboseInfo,
  streamInfo
}));
var waitForSubprocessStream = async ({ stream, fdNumber, encoding, buffer, maxBuffer, lines, allMixed, stripFinalNewline: stripFinalNewline2, verboseInfo, streamInfo }) => {
  if (!stream) {
    return;
  }
  const onStreamEnd = waitForStream(stream, fdNumber, streamInfo);
  if (isInputFileDescriptor(streamInfo, fdNumber)) {
    await onStreamEnd;
    return;
  }
  const [output] = await Promise.all([
    getStreamOutput({
      stream,
      onStreamEnd,
      fdNumber,
      encoding,
      buffer,
      maxBuffer,
      lines,
      allMixed,
      stripFinalNewline: stripFinalNewline2,
      verboseInfo,
      streamInfo
    }),
    onStreamEnd
  ]);
  return output;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/all-async.js
var makeAllStream = ({ stdout, stderr }, { all }) => all && (stdout || stderr) ? mergeStreams([stdout, stderr].filter(Boolean)) : void 0;
var waitForAllStream = ({ subprocess, encoding, buffer, maxBuffer, lines, stripFinalNewline: stripFinalNewline2, verboseInfo, streamInfo }) => waitForSubprocessStream({
  ...getAllStream(subprocess, buffer),
  fdNumber: "all",
  encoding,
  maxBuffer: maxBuffer[1] + maxBuffer[2],
  lines: lines[1] || lines[2],
  allMixed: getAllMixed(subprocess),
  stripFinalNewline: stripFinalNewline2,
  verboseInfo,
  streamInfo
});
var getAllStream = ({ stdout, stderr, all }, [, bufferStdout, bufferStderr]) => {
  const buffer = bufferStdout || bufferStderr;
  if (!buffer) {
    return { stream: all, buffer };
  }
  if (!bufferStdout) {
    return { stream: stderr, buffer };
  }
  if (!bufferStderr) {
    return { stream: stdout, buffer };
  }
  return { stream: all, buffer };
};
var getAllMixed = ({ all, stdout, stderr }) => all && stdout && stderr && stdout.readableObjectMode !== stderr.readableObjectMode;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/wait-subprocess.js
import { once as once8 } from "node:events";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/verbose/ipc.js
var shouldLogIpc = (verboseInfo) => isFullVerbose(verboseInfo, "ipc");
var logIpcOutput = (message, verboseInfo) => {
  const verboseMessage = serializeVerboseMessage(message);
  verboseLog({
    type: "ipc",
    verboseMessage,
    fdNumber: "ipc",
    verboseInfo
  });
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/ipc/buffer-messages.js
var waitForIpcOutput = async ({
  subprocess,
  buffer: bufferArray,
  maxBuffer: maxBufferArray,
  ipc,
  ipcOutput,
  verboseInfo
}) => {
  if (!ipc) {
    return ipcOutput;
  }
  const isVerbose2 = shouldLogIpc(verboseInfo);
  const buffer = getFdSpecificValue(bufferArray, "ipc");
  const maxBuffer = getFdSpecificValue(maxBufferArray, "ipc");
  for await (const message of loopOnMessages({
    anyProcess: subprocess,
    channel: subprocess.channel,
    isSubprocess: false,
    ipc,
    shouldAwait: false,
    reference: true
  })) {
    if (buffer) {
      checkIpcMaxBuffer(subprocess, ipcOutput, maxBuffer);
      ipcOutput.push(message);
    }
    if (isVerbose2) {
      logIpcOutput(message, verboseInfo);
    }
  }
  return ipcOutput;
};
var getBufferedIpcOutput = async (ipcOutputPromise, ipcOutput) => {
  await Promise.allSettled([ipcOutputPromise]);
  return ipcOutput;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/resolve/wait-subprocess.js
var waitForSubprocessResult = async ({
  subprocess,
  options: {
    encoding,
    buffer,
    maxBuffer,
    lines,
    timeoutDuration: timeout,
    cancelSignal,
    gracefulCancel,
    forceKillAfterDelay,
    stripFinalNewline: stripFinalNewline2,
    ipc,
    ipcInput
  },
  context,
  verboseInfo,
  fileDescriptors,
  originalStreams,
  onInternalError,
  controller
}) => {
  const exitPromise = waitForExit(subprocess, context);
  const streamInfo = {
    originalStreams,
    fileDescriptors,
    subprocess,
    exitPromise,
    propagating: false
  };
  const stdioPromises = waitForStdioStreams({
    subprocess,
    encoding,
    buffer,
    maxBuffer,
    lines,
    stripFinalNewline: stripFinalNewline2,
    verboseInfo,
    streamInfo
  });
  const allPromise = waitForAllStream({
    subprocess,
    encoding,
    buffer,
    maxBuffer,
    lines,
    stripFinalNewline: stripFinalNewline2,
    verboseInfo,
    streamInfo
  });
  const ipcOutput = [];
  const ipcOutputPromise = waitForIpcOutput({
    subprocess,
    buffer,
    maxBuffer,
    ipc,
    ipcOutput,
    verboseInfo
  });
  const originalPromises = waitForOriginalStreams(originalStreams, subprocess, streamInfo);
  const customStreamsEndPromises = waitForCustomStreamsEnd(fileDescriptors, streamInfo);
  try {
    return await Promise.race([
      Promise.all([
        {},
        waitForSuccessfulExit(exitPromise),
        Promise.all(stdioPromises),
        allPromise,
        ipcOutputPromise,
        sendIpcInput(subprocess, ipcInput),
        ...originalPromises,
        ...customStreamsEndPromises
      ]),
      onInternalError,
      throwOnSubprocessError(subprocess, controller),
      ...throwOnTimeout(subprocess, timeout, context, controller),
      ...throwOnCancel({
        subprocess,
        cancelSignal,
        gracefulCancel,
        context,
        controller
      }),
      ...throwOnGracefulCancel({
        subprocess,
        cancelSignal,
        gracefulCancel,
        forceKillAfterDelay,
        context,
        controller
      })
    ]);
  } catch (error) {
    context.terminationReason ??= "other";
    return Promise.all([
      { error },
      exitPromise,
      Promise.all(stdioPromises.map((stdioPromise) => getBufferedData(stdioPromise))),
      getBufferedData(allPromise),
      getBufferedIpcOutput(ipcOutputPromise, ipcOutput),
      Promise.allSettled(originalPromises),
      Promise.allSettled(customStreamsEndPromises)
    ]);
  }
};
var waitForOriginalStreams = (originalStreams, subprocess, streamInfo) => originalStreams.map((stream, fdNumber) => stream === subprocess.stdio[fdNumber] ? void 0 : waitForStream(stream, fdNumber, streamInfo));
var waitForCustomStreamsEnd = (fileDescriptors, streamInfo) => fileDescriptors.flatMap(({ stdioItems }, fdNumber) => stdioItems.filter(({ value, stream = value }) => isStream(stream, { checkOpen: false }) && !isStandardStream(stream)).map(({ type, value, stream = value }) => waitForStream(stream, fdNumber, streamInfo, {
  isSameDirection: TRANSFORM_TYPES.has(type),
  stopOnExit: type === "native"
})));
var throwOnSubprocessError = async (subprocess, { signal }) => {
  const [error] = await once8(subprocess, "error", { signal });
  throw error;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/concurrent.js
var initializeConcurrentStreams = () => ({
  readableDestroy: /* @__PURE__ */ new WeakMap(),
  writableFinal: /* @__PURE__ */ new WeakMap(),
  writableDestroy: /* @__PURE__ */ new WeakMap()
});
var addConcurrentStream = (concurrentStreams, stream, waitName) => {
  const weakMap = concurrentStreams[waitName];
  if (!weakMap.has(stream)) {
    weakMap.set(stream, []);
  }
  const promises = weakMap.get(stream);
  const promise = createDeferred();
  promises.push(promise);
  const resolve2 = promise.resolve.bind(promise);
  return { resolve: resolve2, promises };
};
var waitForConcurrentStreams = async ({ resolve: resolve2, promises }, subprocess) => {
  resolve2();
  const [isSubprocessExit] = await Promise.race([
    Promise.allSettled([true, subprocess]),
    Promise.all([false, ...promises])
  ]);
  return !isSubprocessExit;
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/readable.js
import { Readable as Readable3 } from "node:stream";
import { callbackify as callbackify2 } from "node:util";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/shared.js
import { finished as finished6 } from "node:stream/promises";
var safeWaitForSubprocessStdin = async (subprocessStdin) => {
  if (subprocessStdin === void 0) {
    return;
  }
  try {
    await waitForSubprocessStdin(subprocessStdin);
  } catch {
  }
};
var safeWaitForSubprocessStdout = async (subprocessStdout) => {
  if (subprocessStdout === void 0) {
    return;
  }
  try {
    await waitForSubprocessStdout(subprocessStdout);
  } catch {
  }
};
var waitForSubprocessStdin = async (subprocessStdin) => {
  await finished6(subprocessStdin, { cleanup: true, readable: false, writable: true });
};
var waitForSubprocessStdout = async (subprocessStdout) => {
  await finished6(subprocessStdout, { cleanup: true, readable: true, writable: false });
};
var waitForSubprocess = async (subprocess, error) => {
  await subprocess;
  if (error) {
    throw error;
  }
};
var destroyOtherStream = (stream, isOpen, error) => {
  if (error && !isStreamAbort(error)) {
    stream.destroy(error);
  } else if (isOpen) {
    stream.destroy();
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/readable.js
var createReadable = ({ subprocess, concurrentStreams, encoding }, { from, binary: binaryOption = true, preserveNewlines = true } = {}) => {
  const binary = binaryOption || BINARY_ENCODINGS.has(encoding);
  const { subprocessStdout, waitReadableDestroy } = getSubprocessStdout(subprocess, from, concurrentStreams);
  const { readableEncoding, readableObjectMode, readableHighWaterMark } = getReadableOptions(subprocessStdout, binary);
  const { read, onStdoutDataDone } = getReadableMethods({
    subprocessStdout,
    subprocess,
    binary,
    encoding,
    preserveNewlines
  });
  const readable2 = new Readable3({
    read,
    destroy: callbackify2(onReadableDestroy.bind(void 0, { subprocessStdout, subprocess, waitReadableDestroy })),
    highWaterMark: readableHighWaterMark,
    objectMode: readableObjectMode,
    encoding: readableEncoding
  });
  onStdoutFinished({
    subprocessStdout,
    onStdoutDataDone,
    readable: readable2,
    subprocess
  });
  return readable2;
};
var getSubprocessStdout = (subprocess, from, concurrentStreams) => {
  const subprocessStdout = getFromStream(subprocess, from);
  const waitReadableDestroy = addConcurrentStream(concurrentStreams, subprocessStdout, "readableDestroy");
  return { subprocessStdout, waitReadableDestroy };
};
var getReadableOptions = ({ readableEncoding, readableObjectMode, readableHighWaterMark }, binary) => binary ? { readableEncoding, readableObjectMode, readableHighWaterMark } : { readableEncoding, readableObjectMode: true, readableHighWaterMark: DEFAULT_OBJECT_HIGH_WATER_MARK };
var getReadableMethods = ({ subprocessStdout, subprocess, binary, encoding, preserveNewlines }) => {
  const onStdoutDataDone = createDeferred();
  const onStdoutData = iterateOnSubprocessStream({
    subprocessStdout,
    subprocess,
    binary,
    shouldEncode: !binary,
    encoding,
    preserveNewlines
  });
  return {
    read() {
      onRead(this, onStdoutData, onStdoutDataDone);
    },
    onStdoutDataDone
  };
};
var onRead = async (readable2, onStdoutData, onStdoutDataDone) => {
  try {
    const { value, done } = await onStdoutData.next();
    if (done) {
      onStdoutDataDone.resolve();
    } else {
      readable2.push(value);
    }
  } catch {
  }
};
var onStdoutFinished = async ({ subprocessStdout, onStdoutDataDone, readable: readable2, subprocess, subprocessStdin }) => {
  try {
    await waitForSubprocessStdout(subprocessStdout);
    await subprocess;
    await safeWaitForSubprocessStdin(subprocessStdin);
    await onStdoutDataDone;
    if (readable2.readable) {
      readable2.push(null);
    }
  } catch (error) {
    await safeWaitForSubprocessStdin(subprocessStdin);
    destroyOtherReadable(readable2, error);
  }
};
var onReadableDestroy = async ({ subprocessStdout, subprocess, waitReadableDestroy }, error) => {
  if (await waitForConcurrentStreams(waitReadableDestroy, subprocess)) {
    destroyOtherReadable(subprocessStdout, error);
    await waitForSubprocess(subprocess, error);
  }
};
var destroyOtherReadable = (stream, error) => {
  destroyOtherStream(stream, stream.readable, error);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/writable.js
import { Writable as Writable3 } from "node:stream";
import { callbackify as callbackify3 } from "node:util";
var createWritable = ({ subprocess, concurrentStreams }, { to } = {}) => {
  const { subprocessStdin, waitWritableFinal, waitWritableDestroy } = getSubprocessStdin(subprocess, to, concurrentStreams);
  const writable2 = new Writable3({
    ...getWritableMethods(subprocessStdin, subprocess, waitWritableFinal),
    destroy: callbackify3(onWritableDestroy.bind(void 0, {
      subprocessStdin,
      subprocess,
      waitWritableFinal,
      waitWritableDestroy
    })),
    highWaterMark: subprocessStdin.writableHighWaterMark,
    objectMode: subprocessStdin.writableObjectMode
  });
  onStdinFinished(subprocessStdin, writable2);
  return writable2;
};
var getSubprocessStdin = (subprocess, to, concurrentStreams) => {
  const subprocessStdin = getToStream(subprocess, to);
  const waitWritableFinal = addConcurrentStream(concurrentStreams, subprocessStdin, "writableFinal");
  const waitWritableDestroy = addConcurrentStream(concurrentStreams, subprocessStdin, "writableDestroy");
  return { subprocessStdin, waitWritableFinal, waitWritableDestroy };
};
var getWritableMethods = (subprocessStdin, subprocess, waitWritableFinal) => ({
  write: onWrite.bind(void 0, subprocessStdin),
  final: callbackify3(onWritableFinal.bind(void 0, subprocessStdin, subprocess, waitWritableFinal))
});
var onWrite = (subprocessStdin, chunk, encoding, done) => {
  if (subprocessStdin.write(chunk, encoding)) {
    done();
  } else {
    subprocessStdin.once("drain", done);
  }
};
var onWritableFinal = async (subprocessStdin, subprocess, waitWritableFinal) => {
  if (await waitForConcurrentStreams(waitWritableFinal, subprocess)) {
    if (subprocessStdin.writable) {
      subprocessStdin.end();
    }
    await subprocess;
  }
};
var onStdinFinished = async (subprocessStdin, writable2, subprocessStdout) => {
  try {
    await waitForSubprocessStdin(subprocessStdin);
    if (writable2.writable) {
      writable2.end();
    }
  } catch (error) {
    await safeWaitForSubprocessStdout(subprocessStdout);
    destroyOtherWritable(writable2, error);
  }
};
var onWritableDestroy = async ({ subprocessStdin, subprocess, waitWritableFinal, waitWritableDestroy }, error) => {
  await waitForConcurrentStreams(waitWritableFinal, subprocess);
  if (await waitForConcurrentStreams(waitWritableDestroy, subprocess)) {
    destroyOtherWritable(subprocessStdin, error);
    await waitForSubprocess(subprocess, error);
  }
};
var destroyOtherWritable = (stream, error) => {
  destroyOtherStream(stream, stream.writable, error);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/duplex.js
import { Duplex as Duplex3 } from "node:stream";
import { callbackify as callbackify4 } from "node:util";
var createDuplex = ({ subprocess, concurrentStreams, encoding }, { from, to, binary: binaryOption = true, preserveNewlines = true } = {}) => {
  const binary = binaryOption || BINARY_ENCODINGS.has(encoding);
  const { subprocessStdout, waitReadableDestroy } = getSubprocessStdout(subprocess, from, concurrentStreams);
  const { subprocessStdin, waitWritableFinal, waitWritableDestroy } = getSubprocessStdin(subprocess, to, concurrentStreams);
  const { readableEncoding, readableObjectMode, readableHighWaterMark } = getReadableOptions(subprocessStdout, binary);
  const { read, onStdoutDataDone } = getReadableMethods({
    subprocessStdout,
    subprocess,
    binary,
    encoding,
    preserveNewlines
  });
  const duplex2 = new Duplex3({
    read,
    ...getWritableMethods(subprocessStdin, subprocess, waitWritableFinal),
    destroy: callbackify4(onDuplexDestroy.bind(void 0, {
      subprocessStdout,
      subprocessStdin,
      subprocess,
      waitReadableDestroy,
      waitWritableFinal,
      waitWritableDestroy
    })),
    readableHighWaterMark,
    writableHighWaterMark: subprocessStdin.writableHighWaterMark,
    readableObjectMode,
    writableObjectMode: subprocessStdin.writableObjectMode,
    encoding: readableEncoding
  });
  onStdoutFinished({
    subprocessStdout,
    onStdoutDataDone,
    readable: duplex2,
    subprocess,
    subprocessStdin
  });
  onStdinFinished(subprocessStdin, duplex2, subprocessStdout);
  return duplex2;
};
var onDuplexDestroy = async ({ subprocessStdout, subprocessStdin, subprocess, waitReadableDestroy, waitWritableFinal, waitWritableDestroy }, error) => {
  await Promise.all([
    onReadableDestroy({ subprocessStdout, subprocess, waitReadableDestroy }, error),
    onWritableDestroy({
      subprocessStdin,
      subprocess,
      waitWritableFinal,
      waitWritableDestroy
    }, error)
  ]);
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/iterable.js
var createIterable = (subprocess, encoding, {
  from,
  binary: binaryOption = false,
  preserveNewlines = false
} = {}) => {
  const binary = binaryOption || BINARY_ENCODINGS.has(encoding);
  const subprocessStdout = getFromStream(subprocess, from);
  const onStdoutData = iterateOnSubprocessStream({
    subprocessStdout,
    subprocess,
    binary,
    shouldEncode: true,
    encoding,
    preserveNewlines
  });
  return iterateOnStdoutData(onStdoutData, subprocessStdout, subprocess);
};
var iterateOnStdoutData = async function* (onStdoutData, subprocessStdout, subprocess) {
  try {
    yield* onStdoutData;
  } finally {
    if (subprocessStdout.readable) {
      subprocessStdout.destroy();
    }
    await subprocess;
  }
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/convert/add.js
var addConvertedStreams = (subprocess, { encoding }) => {
  const concurrentStreams = initializeConcurrentStreams();
  subprocess.readable = createReadable.bind(void 0, { subprocess, concurrentStreams, encoding });
  subprocess.writable = createWritable.bind(void 0, { subprocess, concurrentStreams });
  subprocess.duplex = createDuplex.bind(void 0, { subprocess, concurrentStreams, encoding });
  subprocess.iterable = createIterable.bind(void 0, subprocess, encoding);
  subprocess[Symbol.asyncIterator] = createIterable.bind(void 0, subprocess, encoding, {});
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/promise.js
var mergePromise = (subprocess, promise) => {
  for (const [property, descriptor] of descriptors) {
    const value = descriptor.value.bind(promise);
    Reflect.defineProperty(subprocess, property, { ...descriptor, value });
  }
};
var nativePromisePrototype = (async () => {
})().constructor.prototype;
var descriptors = ["then", "catch", "finally"].map((property) => [
  property,
  Reflect.getOwnPropertyDescriptor(nativePromisePrototype, property)
]);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/main-async.js
var execaCoreAsync = (rawFile, rawArguments, rawOptions, createNested) => {
  const { file, commandArguments, command, escapedCommand, startTime, verboseInfo, options, fileDescriptors } = handleAsyncArguments(rawFile, rawArguments, rawOptions);
  const { subprocess, promise } = spawnSubprocessAsync({
    file,
    commandArguments,
    options,
    startTime,
    verboseInfo,
    command,
    escapedCommand,
    fileDescriptors
  });
  subprocess.pipe = pipeToSubprocess.bind(void 0, {
    source: subprocess,
    sourcePromise: promise,
    boundOptions: {},
    createNested
  });
  mergePromise(subprocess, promise);
  SUBPROCESS_OPTIONS.set(subprocess, { options, fileDescriptors });
  return subprocess;
};
var handleAsyncArguments = (rawFile, rawArguments, rawOptions) => {
  const { command, escapedCommand, startTime, verboseInfo } = handleCommand(rawFile, rawArguments, rawOptions);
  const { file, commandArguments, options: normalizedOptions } = normalizeOptions(rawFile, rawArguments, rawOptions);
  const options = handleAsyncOptions(normalizedOptions);
  const fileDescriptors = handleStdioAsync(options, verboseInfo);
  return {
    file,
    commandArguments,
    command,
    escapedCommand,
    startTime,
    verboseInfo,
    options,
    fileDescriptors
  };
};
var handleAsyncOptions = ({ timeout, signal, ...options }) => {
  if (signal !== void 0) {
    throw new TypeError('The "signal" option has been renamed to "cancelSignal" instead.');
  }
  return { ...options, timeoutDuration: timeout };
};
var spawnSubprocessAsync = ({ file, commandArguments, options, startTime, verboseInfo, command, escapedCommand, fileDescriptors }) => {
  let subprocess;
  try {
    subprocess = spawn(...concatenateShell(file, commandArguments, options));
  } catch (error) {
    return handleEarlyError({
      error,
      command,
      escapedCommand,
      fileDescriptors,
      options,
      startTime,
      verboseInfo
    });
  }
  const controller = new AbortController();
  setMaxListeners(Number.POSITIVE_INFINITY, controller.signal);
  const originalStreams = [...subprocess.stdio];
  pipeOutputAsync(subprocess, fileDescriptors, controller);
  cleanupOnExit(subprocess, options, controller);
  const context = {};
  const onInternalError = createDeferred();
  subprocess.kill = subprocessKill.bind(void 0, {
    kill: subprocess.kill.bind(subprocess),
    options,
    onInternalError,
    context,
    controller
  });
  subprocess.all = makeAllStream(subprocess, options);
  addConvertedStreams(subprocess, options);
  addIpcMethods(subprocess, options);
  const promise = handlePromise({
    subprocess,
    options,
    startTime,
    verboseInfo,
    fileDescriptors,
    originalStreams,
    command,
    escapedCommand,
    context,
    onInternalError,
    controller
  });
  return { subprocess, promise };
};
var handlePromise = async ({ subprocess, options, startTime, verboseInfo, fileDescriptors, originalStreams, command, escapedCommand, context, onInternalError, controller }) => {
  const [
    errorInfo,
    [exitCode, signal],
    stdioResults,
    allResult,
    ipcOutput
  ] = await waitForSubprocessResult({
    subprocess,
    options,
    context,
    verboseInfo,
    fileDescriptors,
    originalStreams,
    onInternalError,
    controller
  });
  controller.abort();
  onInternalError.resolve();
  const stdio = stdioResults.map((stdioResult, fdNumber) => stripNewline(stdioResult, options, fdNumber));
  const all = stripNewline(allResult, options, "all");
  const result = getAsyncResult({
    errorInfo,
    exitCode,
    signal,
    stdio,
    all,
    ipcOutput,
    context,
    options,
    command,
    escapedCommand,
    startTime
  });
  return handleResult(result, verboseInfo, options);
};
var getAsyncResult = ({ errorInfo, exitCode, signal, stdio, all, ipcOutput, context, options, command, escapedCommand, startTime }) => "error" in errorInfo ? makeError({
  error: errorInfo.error,
  command,
  escapedCommand,
  timedOut: context.terminationReason === "timeout",
  isCanceled: context.terminationReason === "cancel" || context.terminationReason === "gracefulCancel",
  isGracefullyCanceled: context.terminationReason === "gracefulCancel",
  isMaxBuffer: errorInfo.error instanceof MaxBufferError,
  isForcefullyTerminated: context.isForcefullyTerminated,
  exitCode,
  signal,
  stdio,
  all,
  ipcOutput,
  options,
  startTime,
  isSync: false
}) : makeSuccessResult({
  command,
  escapedCommand,
  stdio,
  all,
  ipcOutput,
  options,
  startTime
});

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/bind.js
var mergeOptions = (boundOptions, options) => {
  const newOptions = Object.fromEntries(
    Object.entries(options).map(([optionName, optionValue2]) => [
      optionName,
      mergeOption(optionName, boundOptions[optionName], optionValue2)
    ])
  );
  return { ...boundOptions, ...newOptions };
};
var mergeOption = (optionName, boundOptionValue, optionValue2) => {
  if (DEEP_OPTIONS.has(optionName) && isPlainObject2(boundOptionValue) && isPlainObject2(optionValue2)) {
    return { ...boundOptionValue, ...optionValue2 };
  }
  return optionValue2;
};
var DEEP_OPTIONS = /* @__PURE__ */ new Set(["env", ...FD_SPECIFIC_OPTIONS]);

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/create.js
var createExeca = (mapArguments, boundOptions, deepOptions, setBoundExeca) => {
  const createNested = (mapArguments2, boundOptions2, setBoundExeca2) => createExeca(mapArguments2, boundOptions2, deepOptions, setBoundExeca2);
  const boundExeca = (...execaArguments) => callBoundExeca({
    mapArguments,
    deepOptions,
    boundOptions,
    setBoundExeca,
    createNested
  }, ...execaArguments);
  if (setBoundExeca !== void 0) {
    setBoundExeca(boundExeca, createNested, boundOptions);
  }
  return boundExeca;
};
var callBoundExeca = ({ mapArguments, deepOptions = {}, boundOptions = {}, setBoundExeca, createNested }, firstArgument, ...nextArguments) => {
  if (isPlainObject2(firstArgument)) {
    return createNested(mapArguments, mergeOptions(boundOptions, firstArgument), setBoundExeca);
  }
  const { file, commandArguments, options, isSync } = parseArguments({
    mapArguments,
    firstArgument,
    nextArguments,
    deepOptions,
    boundOptions
  });
  return isSync ? execaCoreSync(file, commandArguments, options) : execaCoreAsync(file, commandArguments, options, createNested);
};
var parseArguments = ({ mapArguments, firstArgument, nextArguments, deepOptions, boundOptions }) => {
  const callArguments = isTemplateString(firstArgument) ? parseTemplates(firstArgument, nextArguments) : [firstArgument, ...nextArguments];
  const [initialFile, initialArguments, initialOptions] = normalizeParameters(...callArguments);
  const mergedOptions = mergeOptions(mergeOptions(deepOptions, boundOptions), initialOptions);
  const {
    file = initialFile,
    commandArguments = initialArguments,
    options = mergedOptions,
    isSync = false
  } = mapArguments({ file: initialFile, commandArguments: initialArguments, options: mergedOptions });
  return {
    file,
    commandArguments,
    options,
    isSync
  };
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/command.js
var mapCommandAsync = ({ file, commandArguments }) => parseCommand(file, commandArguments);
var mapCommandSync = ({ file, commandArguments }) => ({ ...parseCommand(file, commandArguments), isSync: true });
var parseCommand = (command, unusedArguments) => {
  if (unusedArguments.length > 0) {
    throw new TypeError(`The command and its arguments must be passed as a single string: ${command} ${unusedArguments}.`);
  }
  const [file, ...commandArguments] = parseCommandString(command);
  return { file, commandArguments };
};
var parseCommandString = (command) => {
  if (typeof command !== "string") {
    throw new TypeError(`The command must be a string: ${String(command)}.`);
  }
  const trimmedCommand = command.trim();
  if (trimmedCommand === "") {
    return [];
  }
  const tokens = [];
  for (const token of trimmedCommand.split(SPACES_REGEXP)) {
    const previousToken = tokens.at(-1);
    if (previousToken && previousToken.endsWith("\\")) {
      tokens[tokens.length - 1] = `${previousToken.slice(0, -1)} ${token}`;
    } else {
      tokens.push(token);
    }
  }
  return tokens;
};
var SPACES_REGEXP = / +/g;

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/script.js
var setScriptSync = (boundExeca, createNested, boundOptions) => {
  boundExeca.sync = createNested(mapScriptSync, boundOptions);
  boundExeca.s = boundExeca.sync;
};
var mapScriptAsync = ({ options }) => getScriptOptions(options);
var mapScriptSync = ({ options }) => ({ ...getScriptOptions(options), isSync: true });
var getScriptOptions = (options) => ({ options: { ...getScriptStdinOption(options), ...options } });
var getScriptStdinOption = ({ input, inputFile, stdio }) => input === void 0 && inputFile === void 0 && stdio === void 0 ? { stdin: "inherit" } : {};
var deepScriptOptions = { preferLocal: true };

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/index.js
var execa = createExeca(() => ({}));
var execaSync = createExeca(() => ({ isSync: true }));
var execaCommand = createExeca(mapCommandAsync);
var execaCommandSync = createExeca(mapCommandSync);
var execaNode = createExeca(mapNode);
var $ = createExeca(mapScriptAsync, {}, deepScriptOptions, setScriptSync);
var {
  sendMessage: sendMessage2,
  getOneMessage: getOneMessage2,
  getEachMessage: getEachMessage2,
  getCancelSignal: getCancelSignal2
} = getIpcExport();

// ../process-utils/src/exec-portable-file.ts
import { extname as extname2 } from "node:path";

// ../../node_modules/.pnpm/which-command@0.1.0/node_modules/which-command/index.js
import fs from "node:fs";
import path7 from "node:path";
import process10 from "node:process";
var isWindows = process10.platform === "win32";
var separatorPattern = isWindows ? new RegExp("[\\/\\\\]", "v") : new RegExp("\\/", "v");
var defaultPathExt = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
function resolveOptions(command, options) {
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("Expected a non-empty string.");
  }
  const {
    cwd = process10.cwd(),
    // On Windows, `process.env.PATH` can be undefined in some contexts (for example, worker threads), where it's only exposed as `Path`.
    path: searchPath = process10.env.PATH ?? (isWindows ? process10.env.Path : void 0) ?? "",
    // `||` (not `??`) so an empty `PATHEXT` falls back to the default instead of disabling all lookup on Windows.
    pathExt = process10.env.PATHEXT || defaultPathExt
  } = options;
  return { cwd, searchPath, pathExt };
}
function windowsExtensions(command, pathExt) {
  const extensions = pathExt.split(path7.delimiter).filter(Boolean);
  const commandExtension = path7.extname(command).toLowerCase();
  if (commandExtension !== "" && extensions.some((extension) => extension.toLowerCase() === commandExtension)) {
    return ["", ...extensions];
  }
  return extensions;
}
function* candidatePaths(command, { cwd, searchPath, pathExt }) {
  const extensions = isWindows ? windowsExtensions(command, pathExt) : [""];
  if (separatorPattern.test(command)) {
    const base = path7.resolve(cwd, command);
    for (const extension of extensions) {
      yield base + extension;
    }
    return;
  }
  const directories = [
    // Windows searches the current directory before `PATH`.
    ...isWindows ? [cwd] : [],
    ...searchPath.split(path7.delimiter)
  ];
  for (const directory of directories) {
    const unquoted = isWindows && directory.length > 1 && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
    if (unquoted === "") {
      continue;
    }
    const base = path7.resolve(cwd, unquoted, command);
    for (const extension of extensions) {
      yield base + extension;
    }
  }
}
function isExecutableSync(filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    return isWindows && error.code === "EACCES";
  }
  if (!stats.isFile()) {
    return false;
  }
  if (isWindows) {
    return true;
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function whichCommandSync(command, options = {}) {
  const resolved = resolveOptions(command, options);
  for (const candidate of candidatePaths(command, resolved)) {
    if (isExecutableSync(candidate)) {
      return candidate;
    }
  }
  return void 0;
}

// ../process-utils/src/exec-portable-file.ts
async function execPortableFile(command, args, options) {
  if (options.signal?.aborted) throw options.signal.reason;
  if (process.platform === "win32") {
    const envKeys = Object.keys(options.env).sort();
    const pathKey2 = envKeys.find((key) => key.toUpperCase() === "PATH");
    const pathExtKey = envKeys.find((key) => key.toUpperCase() === "PATHEXT");
    const commandExtension = extname2(command);
    const pathExt = options.env[pathExtKey ?? "PATHEXT"];
    if (whichCommandSync(command, {
      cwd: options.cwd,
      path: options.env[pathKey2 ?? "PATH"],
      pathExt: commandExtension ? `${commandExtension};${pathExt ?? ".EXE;.COM;.CMD;.BAT"}` : pathExt
    }) === void 0) {
      throw Object.assign(new Error(`spawn ${command} ENOENT`), {
        code: "ENOENT",
        syscall: `spawn ${command}`,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false
      });
    }
  }
  const subprocess = execa(command, args, {
    cwd: options.cwd,
    env: options.env,
    extendEnv: false,
    encoding: "buffer",
    stripFinalNewline: false,
    maxBuffer: options.maxBuffer,
    input: options.input ?? "",
    detached: supportsProcessGroups(),
    forceKillAfterDelay: 1e3,
    reject: false
  });
  const stopProcess = createProcessStop(subprocess);
  let stopPromise;
  let canceled = false;
  let timedOut = false;
  function stop() {
    stopPromise ??= stopProcess({ gracePeriodMs: 1e3 });
    void stopPromise.catch(() => void 0);
  }
  const onAbort = () => {
    canceled = true;
    stop();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = options.timeout ? setTimeout(() => {
    timedOut = true;
    stop();
  }, options.timeout) : void 0;
  for (const stream of [subprocess.stdout, subprocess.stderr]) {
    stream?.once("close", () => {
      if (!stream.readableEnded && (process.platform !== "win32" || subprocess.exitCode === null && subprocess.signalCode === null)) {
        stop();
      }
    });
  }
  if (options.onStderr) {
    const decoder = new TextDecoder();
    const onStderr = options.onStderr;
    subprocess.stderr?.on("data", (chunk) => {
      const text = decoder.decode(chunk, { stream: true });
      if (text) onStderr(text);
    });
    subprocess.stderr?.on("end", () => {
      const text = decoder.decode();
      if (text) onStderr(text);
    });
  }
  const result = await subprocess.finally(() => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  });
  await stopPromise;
  const output = {
    stdout: Buffer.from(result.stdout).toString("utf8"),
    stderr: Buffer.from(result.stderr).toString("utf8")
  };
  if (!result.failed && !canceled && !timedOut) return output;
  const stopped = canceled || result.isMaxBuffer || timedOut;
  const syscall = result.cause instanceof Error && "syscall" in result.cause && typeof result.cause.syscall === "string" ? result.cause.syscall : void 0;
  const overflowStream = result.shortMessage?.startsWith(
    "Command's stderr was larger than "
  ) ? "stderr" : "stdout";
  const message = canceled ? "The operation was aborted" : result.isMaxBuffer ? `${overflowStream} maxBuffer length exceeded` : timedOut ? `Command timed out after ${options.timeout}ms` : result.originalMessage || `Command failed: ${command}`;
  throw Object.assign(
    new Error(message, {
      cause: canceled ? options.signal?.reason : result.cause
    }),
    {
      name: canceled ? "AbortError" : "Error",
      code: canceled ? "ABORT_ERR" : result.isMaxBuffer ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" : result.code ?? result.exitCode ?? null,
      signal: stopped ? "SIGTERM" : result.signal ?? null,
      killed: stopped || result.isTerminated,
      ...syscall === void 0 ? {} : { syscall },
      ...output
    }
  );
}

// ../process-utils/src/environment.ts
function sanitizeInheritedChildProcessEnv(args) {
  const sanitizedEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === void 0) {
      continue;
    }
    const normalizedKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (normalizedKey === "NODE_ENV" || normalizedKey.startsWith("BB_")) {
      continue;
    }
    sanitizedEnv[normalizedKey === "PATH" ? "PATH" : key] = value;
  }
  if (args.shellPath !== void 0) {
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

// ../process-utils/src/process-info.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFileAsync = promisify3(execFile2);

// ../process-utils/src/performance-diagnostics.ts
import { Session } from "node:inspector/promises";
var PROFILE_RETENTION_MS = 12 * 60 * 60 * 1e3;
var MAX_PROFILE_BYTES = 12 * 1024 * 1024;

// ../provider-bridge-protocol/src/bridge-kit/provider-maintenance-kit.ts
var import_compare = __toESM(require_compare(), 1);
var import_valid = __toESM(require_valid(), 1);
import { execFile as execFile3 } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path8 from "node:path";
import { promisify as promisify4 } from "node:util";
import { z as z25 } from "zod";
var execFileAsync2 = promisify4(execFile3);
var CLI_PROBE_TIMEOUT_MS = 5e3;
var INSTALLATION_CHECK_TIMEOUT_MS = 15e3;
var DEFAULT_WINDOWS_PATHEXT = ".COM;.EXE;.BAT;.CMD";
function selectResolvedExecutable(args) {
  const candidates = args.candidates.map((candidate) => candidate.trim()).filter((candidate) => candidate.length > 0);
  if (args.platform !== "win32") {
    return candidates[0] ?? null;
  }
  const extensions = (args.pathExt ?? DEFAULT_WINDOWS_PATHEXT).split(";").map((extension) => extension.trim().toLowerCase()).filter((extension) => extension.length > 0);
  return candidates.find(
    (candidate) => extensions.includes(path8.win32.extname(candidate).toLowerCase())
  ) ?? null;
}
async function resolveExecutablePath(command) {
  if (path8.isAbsolute(command)) {
    try {
      await access(command, fsConstants.X_OK);
      return command;
    } catch {
      return null;
    }
  }
  try {
    const lookup = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync2(lookup, [command], {
      timeout: CLI_PROBE_TIMEOUT_MS
    });
    return selectResolvedExecutable({
      candidates: stdout.split(/\r?\n/u),
      platform: process.platform,
      pathExt: process.env.PATHEXT
    });
  } catch {
    return null;
  }
}
async function commandOutput(command, args) {
  try {
    const { stdout, stderr } = await execPortableFile(command, [...args], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: INSTALLATION_CHECK_TIMEOUT_MS
    });
    return `${stdout}
${stderr}`.trim();
  } catch {
    return null;
  }
}
function versionFrom(value) {
  const candidate = value?.match(/\bv?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)/u)?.[1];
  return candidate !== void 0 && (0, import_valid.default)(candidate) !== null ? candidate : null;
}
async function readCliVersion(command) {
  try {
    const { stdout, stderr } = await execPortableFile(command, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: CLI_PROBE_TIMEOUT_MS
    });
    return versionFrom(`${stdout}
${stderr}`);
  } catch {
    return null;
  }
}
function compareVersions(left, right) {
  return (0, import_compare.default)(left, right);
}
function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}
function formatCommand(command, args) {
  return [command, ...args].map(
    (part) => /^[A-Za-z0-9_./:@+-]+$/u.test(part) ? part : `'${part.replace(/'/gu, "'\\''")}'`
  ).join(" ");
}
function npmGlobalInstallCommand(npmPackage) {
  const command = npmCommand();
  const args = ["install", "-g", `${npmPackage}@latest`];
  return { command, args, displayCommand: formatCommand(command, args) };
}
async function npmLatestVersion(npmPackage) {
  return versionFrom(
    await commandOutput(npmCommand(), ["view", npmPackage, "version"])
  );
}
async function probeNpmGlobalPackage(npmPackage) {
  const npm = npmCommand();
  const [prefixOutput, listOutput] = await Promise.all([
    commandOutput(npm, ["prefix", "-g"]),
    commandOutput(npm, ["list", "-g", npmPackage, "--depth=0", "--json"])
  ]);
  const npmPrefix = firstLine(prefixOutput);
  return {
    npmBin: npmPrefix === null ? null : process.platform === "win32" ? npmPrefix : path8.join(npmPrefix, "bin"),
    npmGlobalPackageVersion: npmGlobalPackageVersion(listOutput, npmPackage)
  };
}
function firstLine(value) {
  return value?.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}
function npmGlobalPackageVersion(value, npmPackage) {
  if (value === null) return null;
  try {
    const parsed = z25.object({
      dependencies: z25.record(z25.string(), z25.object({ version: z25.string().min(1) })).default({})
    }).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data.dependencies[npmPackage]?.version ?? null : null;
  } catch {
    return null;
  }
}
function pathIsInside(child, parent) {
  const relativePath = path8.relative(path8.resolve(parent), path8.resolve(child));
  return relativePath === "" || !relativePath.startsWith("..") && !path8.isAbsolute(relativePath);
}
function npmGlobalInstallSource(args) {
  return !args.installed ? "notInstalled" : args.executablePath !== null && args.npmBin !== null && pathIsInside(args.executablePath, args.npmBin) ? "npmGlobal" : "external";
}
function installationVerification(status, action) {
  return action === "install" ? { kind: "installed" } : status.latestVersion !== null ? { kind: "version_at_least", version: status.latestVersion } : {
    kind: "version_changed",
    previousVersion: status.currentVersion ?? "unknown"
  };
}
function downloadedInstallerCommand(url, options = {}) {
  if ((options.platform ?? process.platform) === "win32" && options.powershellUrl !== void 0) {
    const powershellScript = `irm ${options.powershellUrl} | iex`;
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        powershellScript
      ],
      displayCommand: powershellScript
    };
  }
  const script = [
    'tmp=$(mktemp "${TMPDIR:-/tmp}/provider-installation.XXXXXX")',
    `trap 'rm -f "$tmp"' EXIT`,
    `curl -fsSL ${url} -o "$tmp"`,
    'bash "$tmp"'
  ].join(" && ");
  return { command: "sh", args: ["-c", script], displayCommand: script };
}
function clampPercent(value) {
  return Math.min(
    100,
    Math.max(0, Math.round(Number.isFinite(value) ? value : 0))
  );
}

// ../provider-bridge-protocol/src/bridge-kit/provider-tool-call-contract.ts
import { z as z26 } from "zod";
var providerToolCallCancellationSchema = z26.object({
  requestId: z26.union([z26.string(), z26.number().int()])
});

// ../provider-bridge-protocol/src/bridge-kit/provider-visibility.ts
function createProviderVisibilityMetadata(args) {
  return {
    parseRawEvent: args.parseRawEvent,
    describeParsedRawEvent: args.describeParsedRawEvent,
    describeRawEvent(event) {
      return args.describeParsedRawEvent(args.parseRawEvent(event));
    }
  };
}

// ../provider-bridge-protocol/src/bridge-kit/runtime-json-rpc.ts
import { z as z28 } from "zod";

// ../provider-bridge-protocol/src/errors.ts
import { z as z27 } from "zod";
var BRIDGE_JSON_RPC_ERRORS = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  BRIDGE_ERROR: -32e3,
  NO_ACTIVE_TURN: -32001,
  SESSION_NOT_RESTORABLE: -32002,
  FORK_CHECKPOINT_UNSUPPORTED: -32003,
  MISSING_EXECUTABLE: -32004
};
var providerRecoveryHintSchema = z27.object({
  kind: providerRecoveryKindSchema,
  message: z27.string().min(1),
  retryable: z27.boolean()
});
var bridgeErrorDataSchema = z27.object({ recovery: providerRecoveryHintSchema.optional() }).passthrough();

// ../provider-bridge-protocol/src/bridge-kit/runtime-json-rpc.ts
var JSON_RPC_INVALID_PARAMS_CODE = -32602;
var ProviderRequestDecodeError = class extends Error {
  code = JSON_RPC_INVALID_PARAMS_CODE;
  constructor(message) {
    super(message);
    this.name = "ProviderRequestDecodeError";
  }
};
var ProviderResponseEncodeError = class extends Error {
  code = JSON_RPC_INVALID_PARAMS_CODE;
  constructor(message) {
    super(message);
    this.name = "ProviderResponseEncodeError";
  }
};
var ignoredJsonRpcResultSchema = z28.unknown();

// ../provider-bridge-protocol/src/version.ts
var PROVIDER_BRIDGE_PROTOCOL_VERSION = 2;
var THREAD_DELTA_GRAMMAR_V2 = PROVIDER_BRIDGE_PROTOCOL_VERSION;
var THREAD_DELTA_GRAMMAR_V3 = 3;

// ../provider-bridge-protocol/src/handshake.ts
import { z as z29 } from "zod";
var bridgeGrammarVersionsSchema = z29.tuple([z29.number().int().positive(), z29.number().int().positive()]).refine(([min, max]) => min <= max, {
  message: "grammarVersions must be an ascending [min, max] range"
});
var bridgeSteerModeSchema = z29.enum(["inject", "queue"]);
var bridgeCapabilitiesSchema = z29.object({
  sessionRestore: z29.boolean().default(false),
  threadArchive: z29.boolean().default(false),
  threadRename: z29.boolean().default(false),
  threadGoalClear: z29.boolean().default(false),
  fork: providerForkSchema.default("none"),
  approvalEnforcedBy: z29.enum(["runtime", "provider"]).default("runtime"),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ]),
  steerMode: bridgeSteerModeSchema.default("queue"),
  skills: z29.object({ configure: z29.boolean().default(false) }).default({ configure: false })
}).passthrough();
var initializeParamsSchema = z29.object({
  protocolVersion: z29.number().int().positive(),
  client: z29.object({ name: z29.string().min(1), version: z29.string().min(1) }),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ])
}).passthrough();
var initializeResultSchema = z29.object({
  protocolVersion: z29.number().int().positive(),
  capabilities: z29.preprocess(
    (value) => value ?? {},
    bridgeCapabilitiesSchema
  )
}).passthrough();

// ../provider-bridge-protocol/src/execution-options.ts
import { z as z30 } from "zod";
var bridgeExecutionOptionsSchema = z30.object({
  model: z30.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  instructions: z30.string().optional(),
  envVars: z30.record(z30.string(), z30.string()).optional(),
  providerOptions: z30.record(z30.string(), z30.unknown()).optional()
}).and(runtimePermissionPolicySchema);

// ../provider-bridge-protocol/src/provider-maintenance.ts
import { z as z31 } from "zod";
var providerMaintenanceParamsSchema = z31.object({
  providerId: z31.string().min(1),
  cwd: z31.string().min(1).optional(),
  providerOptions: z31.record(z31.string(), z31.unknown()).optional()
}).passthrough();
var providerInstallationRequirementSchema = z31.enum(["thread_rewind"]);
var providerInstallationStatusParamsSchema = providerMaintenanceParamsSchema.extend({
  requirement: providerInstallationRequirementSchema.optional(),
  checkUpdates: z31.boolean().default(true)
});
var providerHealthSchema = z31.object({
  status: z31.enum([
    "ready",
    "not_installed",
    "unauthenticated",
    "expired",
    "unsupported_version",
    "unknown"
  ]),
  statusMessage: z31.string().min(1).nullable(),
  accountEmail: z31.string().nullable(),
  planLabel: z31.string().min(1).nullable(),
  installedVersion: z31.string().min(1).nullable(),
  minimumSupportedVersion: z31.string().min(1).nullable(),
  canInstall: z31.boolean(),
  canUpdate: z31.boolean(),
  loginCommand: z31.string().min(1).nullable(),
  localLoginCommand: z31.string().min(1).nullable().optional()
}).passthrough();
var providerUsageWindowSchema = z31.object({
  label: z31.string().min(1),
  usedPercent: z31.number().min(0).max(100),
  resetsAt: z31.string().min(1).nullable(),
  cost: z31.object({
    usedUsdCents: z31.number().int().nonnegative(),
    limitUsdCents: z31.number().int().positive()
  }).optional()
}).passthrough();
var providerUsageSchema = z31.discriminatedUnion("status", [
  z31.object({
    status: z31.literal("ok"),
    accountEmail: z31.string().email().nullable(),
    planLabel: z31.string().min(1).nullable(),
    windows: z31.array(providerUsageWindowSchema)
  }).passthrough(),
  z31.object({ status: z31.literal("not_installed") }).passthrough(),
  z31.object({ status: z31.literal("unauthenticated") }).passthrough(),
  z31.object({ status: z31.literal("expired") }).passthrough(),
  z31.object({
    status: z31.literal("error"),
    message: z31.string().min(1),
    planLabel: z31.string().min(1).nullable().default(null),
    accountEmail: z31.string().nullable().default(null)
  }).passthrough()
]);
var providerHealthResultSchema = z31.discriminatedUnion("supported", [
  z31.object({ supported: z31.literal(false) }).passthrough(),
  z31.object({
    supported: z31.literal(true),
    health: providerHealthSchema
  }).passthrough()
]);
var providerUsageResultSchema = z31.discriminatedUnion("supported", [
  z31.object({ supported: z31.literal(false) }).passthrough(),
  z31.object({
    supported: z31.literal(true),
    usage: providerUsageSchema
  }).passthrough()
]);
var providerInstallationActionKindSchema = z31.enum([
  "install",
  "update"
]);
var providerInstallationActionSchema = z31.object({
  kind: providerInstallationActionKindSchema,
  label: z31.enum(["Install", "Update"]),
  command: z31.string().min(1)
}).passthrough();
var providerInstallationSourceSchema = z31.enum([
  "notInstalled",
  "npmGlobal",
  "external"
]);
var providerInstallationStatusSchema = z31.object({
  executableName: z31.string().min(1),
  executablePath: z31.string().min(1).nullable(),
  installed: z31.boolean(),
  installSource: providerInstallationSourceSchema,
  currentVersion: z31.string().min(1).nullable(),
  latestVersion: z31.string().min(1).nullable(),
  minimumSupportedVersion: z31.string().min(1).nullable(),
  npmPackageName: z31.string().min(1).nullable(),
  npmGlobalPackageVersion: z31.string().min(1).nullable(),
  installAction: providerInstallationActionSchema.nullable(),
  needsUpdate: z31.boolean(),
  versionUnsupported: z31.boolean()
}).passthrough();
var providerInstallationRunParamsSchema = providerMaintenanceParamsSchema.extend({
  action: providerInstallationActionKindSchema
});
var providerInstallationCommandSchema = z31.object({
  command: z31.string().min(1),
  args: z31.array(z31.string()).max(64),
  displayCommand: z31.string().min(1)
}).passthrough();
var providerInstallationVerificationSchema = z31.discriminatedUnion(
  "kind",
  [
    z31.object({ kind: z31.literal("installed") }).passthrough(),
    z31.object({
      kind: z31.literal("version_changed"),
      previousVersion: z31.string().min(1)
    }).passthrough(),
    z31.object({
      kind: z31.literal("version_at_least"),
      version: z31.string().min(1)
    }).passthrough()
  ]
);
var providerInstallationRunResultSchema = z31.discriminatedUnion(
  "available",
  [
    z31.object({
      available: z31.literal(false),
      message: z31.string().min(1)
    }).passthrough(),
    z31.object({
      available: z31.literal(true),
      command: providerInstallationCommandSchema,
      verification: providerInstallationVerificationSchema
    }).passthrough()
  ]
);

// ../provider-bridge-protocol/src/requests.ts
import { z as z32 } from "zod";
var BRIDGE_REQUEST_METHODS = {
  initialize: "initialize",
  modelList: "model/list",
  providerHealth: "provider/health",
  providerUsage: "provider/usage",
  providerInstallationStatus: "provider/installation/status",
  providerInstallationRun: "provider/installation/run",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadStop: "thread/stop",
  threadDiscard: "thread/discard",
  threadNameSet: "thread/name/set",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  threadGoalClear: "thread/goal/clear",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  skillsConfigure: "skills/configure"
};
var sessionConstructionFields = {
  threadId: z32.string().min(1),
  cwd: z32.string().min(1),
  options: bridgeExecutionOptionsSchema,
  dynamicTools: z32.array(dynamicToolSchema).optional(),
  disallowedTools: z32.array(z32.string().min(1)).optional(),
  instructionMode: instructionModeSchema
};
var modelListParamsSchema = z32.object({ cwd: z32.string().min(1).optional() }).passthrough();
var threadStartParamsSchema = z32.object({
  ...sessionConstructionFields,
  input: z32.array(promptInputSchema).optional()
}).passthrough();
var threadResumeParamsSchema = z32.object({
  ...sessionConstructionFields,
  providerThreadId: z32.string().min(1)
}).passthrough();
var threadForkParamsSchema = z32.object({
  ...sessionConstructionFields,
  sourceProviderThreadId: z32.string().min(1),
  sourceProviderCheckpointId: z32.string().min(1).optional()
}).passthrough();
var threadStopParamsSchema = z32.object({
  threadId: z32.string().min(1),
  providerThreadId: z32.string().min(1),
  intent: z32.enum(["interrupt", "release"]),
  activeTurnId: z32.string().min(1).nullable()
}).passthrough();
var threadRefParams = z32.object({
  threadId: z32.string().min(1),
  providerThreadId: z32.string().min(1)
}).passthrough();
var threadDiscardParamsSchema = threadRefParams;
var threadArchiveParamsSchema = threadRefParams;
var threadUnarchiveParamsSchema = threadRefParams;
var threadGoalClearParamsSchema = threadRefParams;
var threadNameSetParamsSchema = z32.object({
  threadId: z32.string().min(1),
  providerThreadId: z32.string().min(1),
  title: z32.string().min(1)
}).passthrough();
var turnInputFields = {
  threadId: z32.string().min(1),
  providerThreadId: z32.string().min(1),
  input: z32.array(promptInputSchema),
  clientRequestId: clientTurnRequestIdSchema,
  options: bridgeExecutionOptionsSchema
};
var turnStartParamsSchema = z32.object(turnInputFields).passthrough();
var turnSteerParamsSchema = z32.object({
  ...turnInputFields,
  expectedTurnId: z32.string().min(1)
}).passthrough();
var skillsConfigureRootSchema = z32.object({
  id: z32.string().min(1),
  path: z32.string().min(1),
  skills: z32.array(
    z32.object({
      name: z32.string().min(1),
      description: z32.string()
    }).passthrough()
  )
}).passthrough();
var skillsConfigureParamsSchema = z32.object({
  roots: z32.array(skillsConfigureRootSchema)
}).passthrough();
var threadIdentityResultSchema = z32.object({
  providerThreadId: z32.string().min(1),
  sessionRestorable: z32.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
import { z as z33 } from "zod";
var BRIDGE_NOTIFICATION_METHODS = {
  threadIdentity: "thread/identity",
  sessionReplaced: "session/replaced",
  providerRaw: "provider/raw",
  providerRecovery: "provider/recovery",
  error: "error"
};
var threadIdentityNotificationSchema = z33.object({
  threadId: z33.string().min(1),
  providerThreadId: z33.string().min(1),
  sessionRestorable: z33.boolean().optional()
}).passthrough();
var sessionReplacedNotificationSchema = z33.object({
  threadId: z33.string().min(1),
  providerThreadId: z33.string().min(1).nullable(),
  reason: z33.string().min(1),
  contextLost: z33.boolean().default(false),
  showRuntimeNote: z33.boolean().default(false)
}).passthrough();
var providerRecoveryNotificationSchema = z33.object({
  threadId: z33.string().min(1).optional(),
  ...providerRecoveryHintSchema.shape
}).passthrough();
var errorNotificationSchema = z33.object({
  threadId: z33.string().min(1).optional(),
  providerThreadId: z33.string().min(1).optional(),
  message: z33.string().min(1)
}).passthrough();

// ../provider-bridge-protocol/src/thread-delta.ts
import { z as z34 } from "zod";
var THREAD_DELTA_NOTIFICATION_METHOD = "thread/delta";
var deltaPresentationSchema = threadEventItemPresentationSchema;
var THREAD_DELTA_KEY_SEPARATOR = "";
var deltaKeyPartSchema = z34.string().min(1).refine((value) => !value.includes(THREAD_DELTA_KEY_SEPARATOR), {
  message: "provider keys must not contain the internal key separator (\\u001f)"
});
var deltaItemKeySchema = z34.object({
  providerItemId: deltaKeyPartSchema.optional(),
  channel: deltaKeyPartSchema.optional(),
  parentRef: deltaKeyPartSchema.optional()
});
var providerTurnIdSchema = deltaKeyPartSchema;
var deltaFileChangeSchema = z34.object({
  path: z34.string(),
  kind: z34.enum(["add", "update", "delete"]),
  movePath: z34.string().optional(),
  diff: z34.string().optional(),
  oldText: z34.string().optional(),
  newText: z34.string().optional()
});
var deltaBackgroundTaskShapeSchema = z34.object({
  type: z34.literal("backgroundTask"),
  familyId: z34.string().min(1),
  taskType: z34.string(),
  description: z34.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z34.boolean(),
  workflowName: z34.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z34.string().optional(),
  error: z34.string().optional(),
  outputFile: z34.string().optional()
});
var deltaFileReadShapeSchema = z34.object({
  type: z34.literal("fileRead"),
  path: z34.string(),
  cmd: z34.string().optional()
});
var deltaSearchShapeSchema = z34.object({
  type: z34.literal("search"),
  mode: threadEventSearchModeSchema,
  query: z34.string(),
  path: z34.string().optional(),
  cmd: z34.string().optional()
});
var deltaDelegationShapeSchema = z34.object({
  type: z34.literal("delegation"),
  childRef: deltaKeyPartSchema,
  label: z34.string(),
  background: z34.boolean(),
  summary: z34.string().optional()
});
var deltaPlanStepsShapeSchema = z34.object({
  type: z34.literal("planSteps"),
  steps: z34.array(threadEventPlanStepSchema),
  explanation: z34.string().optional()
});
var deltaExtensionShapeSchema = z34.object({
  type: z34.literal("extension"),
  kind: extensionKindSchema,
  payload: jsonValueSchema
});
var deltaItemShapeSchema = z34.discriminatedUnion("type", [
  z34.object({
    type: z34.literal("command"),
    command: z34.string(),
    cwd: z34.string(),
    aggregatedOutput: z34.string().optional(),
    exitCode: z34.number().optional(),
    durationMs: z34.number().optional()
  }),
  z34.object({
    type: z34.literal("fileChange"),
    changes: z34.array(deltaFileChangeSchema)
  }),
  z34.object({
    type: z34.literal("tool"),
    tool: z34.string(),
    server: z34.string().optional(),
    args: z34.unknown().optional(),
    result: z34.unknown().optional(),
    error: z34.string().optional(),
    durationMs: z34.number().optional()
  }),
  z34.object({ type: z34.literal("compaction") }),
  z34.object({ type: z34.literal("agentMessage"), text: z34.string() }),
  z34.object({
    type: z34.literal("reasoning"),
    summary: z34.array(z34.string()),
    content: z34.array(z34.string())
  }),
  z34.object({ type: z34.literal("plan"), text: z34.string() }),
  z34.object({
    type: z34.literal("webSearch"),
    queries: z34.array(z34.string()).min(1)
  }),
  z34.object({
    type: z34.literal("webFetch"),
    url: z34.string(),
    prompt: z34.string().nullable().optional(),
    pattern: z34.string().nullable()
  }),
  z34.object({ type: z34.literal("imageView"), path: z34.string() }),
  z34.object({
    type: z34.literal("imageGeneration"),
    prompt: z34.string().nullable(),
    path: z34.string().nullable(),
    result: z34.string().optional(),
    error: z34.string().nullable(),
    transparentBackground: z34.boolean()
  }),
  deltaBackgroundTaskShapeSchema,
  deltaFileReadShapeSchema,
  deltaSearchShapeSchema,
  deltaDelegationShapeSchema,
  deltaPlanStepsShapeSchema,
  deltaExtensionShapeSchema
]);
var deltaProgressSnapshotSchema = z34.discriminatedUnion("type", [
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema
]);
var deltaTextChannelSchema = z34.enum([
  "agentMessage",
  "reasoningSummary",
  "reasoningText",
  "plan"
]);
var deltaOutputChannelSchema = z34.enum(["command", "fileChange"]);
var deltaErrorSchema = z34.object({ message: z34.string() });
var deltaAttachSchema = z34.enum(["open", "currentOrLast"]);
var deltaNoTurnFallbackSchema = z34.object({
  raw: providerRawEventSchema,
  rawType: z34.string()
});
function requireExtensionPresentation(delta, ctx) {
  if (delta.item.type === "extension" && delta.presentation === void 0) {
    ctx.addIssue({
      code: "custom",
      message: "extension items require a presentation on item.open/item.close",
      path: ["presentation"]
    });
  }
}
var threadDeltaSchema = z34.discriminatedUnion("kind", [
  z34.object({
    kind: z34.literal("input.accepted"),
    clientRequestId: clientTurnRequestIdSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z34.object({
    kind: z34.literal("input.provider"),
    text: z34.string().min(1),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z34.object({
    kind: z34.literal("turn.open"),
    providerTurnId: providerTurnIdSchema.optional(),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z34.object({
    kind: z34.literal("turn.boundary"),
    status: threadEventTurnStatusSchema,
    error: deltaErrorSchema.optional(),
    providerCheckpointId: z34.string().min(1).optional(),
    claimIfIdle: z34.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z34.object({
    kind: z34.literal("item.open"),
    key: deltaItemKeySchema,
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    attach: deltaAttachSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z34.object({
    kind: z34.literal("item.close"),
    key: deltaItemKeySchema,
    status: threadEventItemStatusSchema,
    resultText: z34.string().optional(),
    exitCode: z34.number().optional(),
    aggregatedOutput: z34.string().optional(),
    approvalStatus: z34.literal("denied").optional(),
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z34.object({
    kind: z34.literal("item.progress"),
    key: deltaItemKeySchema,
    message: z34.string().optional(),
    snapshot: deltaProgressSnapshotSchema.optional(),
    flush: z34.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z34.object({
    kind: z34.literal("item.textDelta"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z34.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z34.object({
    kind: z34.literal("item.textClose"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z34.string().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z34.object({
    kind: z34.literal("item.outputDelta"),
    key: deltaItemKeySchema,
    channel: deltaOutputChannelSchema,
    text: z34.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z34.object({
    kind: z34.literal("command.outputSnapshot"),
    key: deltaItemKeySchema,
    text: z34.string(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z34.object({
    kind: z34.literal("usage"),
    total: threadEventTokenUsageBreakdownSchema,
    last: threadEventTokenUsageBreakdownSchema,
    modelContextWindow: z34.number().nullable(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z34.object({
    kind: z34.literal("contextWindow"),
    snapshot: contextSnapshotSchema.optional(),
    used: z34.number().nullable(),
    size: z34.number().nullable().optional(),
    estimated: z34.boolean(),
    cost: threadUsageCostSchema.optional(),
    attach: deltaAttachSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z34.object({
    kind: z34.literal("context.compacted"),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z34.object({ kind: z34.literal("context.cleared") }),
  z34.object({
    kind: z34.literal("turn.diff"),
    diff: z34.string(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z34.object({ kind: z34.literal("thread.started") }),
  z34.object({
    kind: z34.literal("thread.identity"),
    providerThreadId: z34.string().min(1)
  }),
  z34.object({
    kind: z34.literal("thread.name"),
    name: z34.string().min(1),
    source: z34.literal("agent").optional()
  }),
  z34.object({
    kind: z34.literal("extension.state"),
    extensionKind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z34.object({
    kind: z34.literal("provider.rateLimits"),
    rateLimits: providerRateLimitStateSchema
  }),
  z34.object({
    kind: z34.literal("provider.error"),
    message: z34.string(),
    detail: z34.string().optional(),
    willRetry: z34.boolean().optional(),
    category: providerErrorCategorySchema.optional(),
    errorInfo: providerErrorInfoSchema.optional(),
    settlesTurn: z34.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    threadScoped: z34.boolean().optional()
  }),
  z34.object({
    kind: z34.literal("provider.modelFallback"),
    originalModel: z34.string().min(1),
    fallbackModel: z34.string().min(1),
    reason: z34.enum(["refusal", "provider"]),
    message: z34.string()
  }),
  z34.object({
    kind: z34.literal("thread.execution"),
    execution: threadExecutionReportSchema
  }),
  z34.object({
    kind: z34.literal("provider.warning"),
    summary: z34.string().optional(),
    details: z34.string().optional(),
    category: threadEventWarningCategorySchema.optional(),
    vouchedTurn: z34.boolean().optional()
  }),
  z34.object({
    kind: z34.literal("unhandled"),
    raw: providerRawEventSchema,
    rawType: z34.string(),
    vouchedTurn: z34.boolean(),
    onlyIfNoTurn: z34.boolean().optional(),
    parentRef: deltaKeyPartSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z34.object({ kind: z34.literal("session.ended") }),
  z34.object({ kind: z34.literal("session.reset") })
]);
var threadDeltaNotificationParamsSchema = z34.object({
  threadId: z34.string().min(1),
  deltas: z34.array(threadDeltaSchema)
}).passthrough();

// ../provider-bridge-acp/src/launch-spec.ts
import { z as z35 } from "zod";
var acpNativeSkillRootsSchema = z35.object({
  user: z35.array(providerNativeRootInputSchema).default([]),
  project: z35.array(providerNativeRootInputSchema).default([])
}).strict().superRefine((roots, context) => {
  const normalized = providerNativeRootsSchema.safeParse(
    normalizeProviderNativeRoots(roots)
  );
  if (normalized.success) {
    return;
  }
  for (const issue of normalized.error.issues) {
    context.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message
    });
  }
});
var acpLaunchSpecSchema = z35.object({
  displayName: z35.string().min(1),
  command: z35.string().min(1),
  args: z35.array(z35.string()),
  env: z35.record(z35.string().min(1), z35.string()),
  cwd: z35.string().min(1).optional(),
  modelCli: z35.object({
    listArgs: z35.array(z35.string()),
    selectFlag: z35.string().min(1).optional(),
    primaryModels: z35.array(z35.string())
  }).strict().transform(
    (modelCli) => modelCli.listArgs.length > 0 ? modelCli : void 0
  ).optional(),
  reasoningCli: acpReasoningCliSchema.optional(),
  nativeReasoning: acpNativeReasoningSchema.optional(),
  nativeSkillRoots: acpNativeSkillRootsSchema.optional(),
  permissionCli: acpPermissionCliSchema.optional()
}).strict();
function normalizeAcpLaunchSpec(spec) {
  const {
    displayName,
    command,
    args,
    env,
    cwd,
    modelCli,
    reasoningCli,
    nativeReasoning,
    nativeSkillRoots,
    permissionCli
  } = spec;
  const permissionCliHasMode = permissionCli?.full !== void 0 || permissionCli?.workspaceWrite !== void 0 || permissionCli?.readonly !== void 0;
  return {
    displayName,
    command,
    args,
    env,
    ...cwd !== void 0 ? { cwd } : {},
    ...modelCli !== void 0 && modelCli.listArgs.length > 0 ? { modelCli } : {},
    ...reasoningCli !== void 0 ? { reasoningCli } : {},
    ...nativeReasoning !== void 0 ? { nativeReasoning } : {},
    ...nativeSkillRoots !== void 0 ? { nativeSkillRoots } : {},
    ...permissionCli !== void 0 && permissionCliHasMode ? { permissionCli } : {}
  };
}

// src/claude-task-tools.ts
import { z as z36 } from "zod";
var claudeTaskToolNameSchema = z36.enum([
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate"
]);
var claudeTaskStatusSchema = z36.enum(["pending", "in_progress", "completed"]);
var claudeTaskCreateOutputSchema = z36.object({
  task: z36.object({
    id: z36.string(),
    subject: z36.string()
  }).passthrough()
}).passthrough();
var claudeTaskGetOutputSchema = z36.object({
  task: z36.object({
    id: z36.string(),
    status: claudeTaskStatusSchema,
    subject: z36.string()
  }).passthrough().nullable()
}).passthrough();
var claudeTaskUpdateOutputSchema = z36.object({
  success: z36.boolean(),
  taskId: z36.string()
}).passthrough();
var claudeTaskListOutputSchema = z36.object({
  tasks: z36.array(z36.unknown())
}).passthrough();
var claudeTaskToolOutputSchema = z36.union([
  claudeTaskCreateOutputSchema,
  claudeTaskGetOutputSchema,
  claudeTaskListOutputSchema,
  claudeTaskUpdateOutputSchema
]);
export {
  BRIDGE_INBOUND_REQUEST_METHODS,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  HIGH_REASONING_EFFORT,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_WORKFLOW_TASK_TYPE,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  PROVIDER_BRIDGE_EXPORT_NAME,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  ProviderRequestDecodeError,
  ProviderResponseEncodeError,
  THREAD_DELTA_GRAMMAR_V2,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  ULTRACODE_REASONING_EFFORT,
  USER_QUESTION_MAX_OPTIONS,
  USER_QUESTION_MAX_QUESTIONS,
  XHIGH_REASONING_EFFORT,
  ZERO_TOKEN_USAGE,
  acpNativeReasoningSchema,
  acpPermissionCliSchema,
  acpReasoningCliSchema,
  addTokenUsage,
  approvalInteractionOutcomeSchema,
  backgroundTaskItemStatus,
  bashArgsSchema,
  bridgeCapabilitiesSchema,
  bridgeErrorDataSchema,
  bridgeGrammarVersionsSchema,
  bridgeRequestEnvelopeSchema,
  bridgeSteerModeSchema,
  buildShellEnvOverrides,
  claudeTaskToolNameSchema,
  claudeTaskToolOutputSchema,
  contextSnapshotSchema,
  createBridgeIo,
  createBridgeLineHandler,
  createPendingToolCallTracker,
  createProviderVisibilityMetadata,
  decodeBridgeJsonRpcResponse,
  decodeToolCallResponsePayload,
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema,
  deltaExtensionShapeSchema,
  deltaFileChangeSchema,
  deltaFileReadShapeSchema,
  deltaItemKeySchema,
  deltaItemShapeSchema,
  deltaNoTurnFallbackSchema,
  deltaOutputChannelSchema,
  deltaPlanStepsShapeSchema,
  deltaPresentationSchema,
  deltaProgressSnapshotSchema,
  deltaSearchShapeSchema,
  deltaTextChannelSchema,
  dynamicToolSchema,
  errorEnvelopeSchema,
  BridgeRecoveryError as experimental_BridgeRecoveryError,
  COMPACTION_PRESENTATION as experimental_COMPACTION_PRESENTATION,
  REASONING_PRESENTATION as experimental_REASONING_PRESENTATION,
  buildBridgeToolCallContent as experimental_buildBridgeToolCallContent,
  clampPercent as experimental_clampPercent,
  commandOutput as experimental_commandOutput,
  compareVersions as experimental_compareVersions,
  experimental_defineProviderBridge,
  downloadedInstallerCommand as experimental_downloadedInstallerCommand,
  fileReadPresentation as experimental_fileReadPresentation,
  formatCommand as experimental_formatCommand,
  installationVerification as experimental_installationVerification,
  experimental_isProviderBridgeRecording,
  killPortableProcess as experimental_killPortableProcess,
  npmCommand as experimental_npmCommand,
  npmGlobalInstallCommand as experimental_npmGlobalInstallCommand,
  npmGlobalInstallSource as experimental_npmGlobalInstallSource,
  npmLatestVersion as experimental_npmLatestVersion,
  planStepsPresentation as experimental_planStepsPresentation,
  presentationDetail as experimental_presentationDetail,
  presentationFileName as experimental_presentationFileName,
  presentationTitle as experimental_presentationTitle,
  probeNpmGlobalPackage as experimental_probeNpmGlobalPackage,
  readBoundedLines as experimental_readBoundedLines,
  readCliVersion as experimental_readCliVersion,
  experimental_recordProviderChildIo,
  resolveExecutablePath as experimental_resolveExecutablePath,
  runMcpElicitation as experimental_runMcpElicitation,
  searchPresentation as experimental_searchPresentation,
  spawnPortableProcess as experimental_spawnPortableProcess,
  toolPresentation as experimental_toolPresentation,
  versionFrom as experimental_versionFrom,
  webFetchPresentation as experimental_webFetchPresentation,
  webSearchPresentation as experimental_webSearchPresentation,
  withTitle as experimental_withTitle,
  extensionKindSchema,
  extractResultText,
  getRawSdkMessage,
  getRecordProperty,
  getStringProperty,
  acpLaunchSpecSchema as hostDaemonAcpLaunchSpecSchema,
  initializeParamsSchema,
  instructionModeValues,
  interactionRequestPayloadSchema,
  isApprovalInteractionOutcome,
  isApprovalPendingInteractionPayload,
  isApprovalPendingInteractionResolution,
  isBackgroundAgentTaskType,
  isExtensionKind,
  isRecord,
  isSettledBackgroundTaskStatus,
  isStandaloneBuiltinCompactCommand,
  isUserQuestionPendingInteractionPayload,
  isUserQuestionPendingInteractionResolution,
  jsonRpcEnvelopeSchema,
  jsonValueSchema,
  mimeTypeFromExtension,
  modelListParamsSchema,
  normalizeAcpLaunchSpec as normalizeHostDaemonAcpLaunchSpec,
  normalizeProviderCommandOutput,
  pendingInteractionCommandActionSchema,
  pendingInteractionFileSystemPermissionsSchema,
  pendingInteractionMacOsPermissionsSchema,
  pendingInteractionNetworkPermissionsSchema,
  pendingInteractionRequestedPermissionProfileSchema,
  pendingInteractionResolutionSchema,
  permissionEscalationValues,
  providerHealthResultSchema,
  providerHealthSchema,
  providerInstallationActionKindSchema,
  providerInstallationActionSchema,
  providerInstallationCommandSchema,
  providerInstallationRequirementSchema,
  providerInstallationRunParamsSchema,
  providerInstallationRunResultSchema,
  providerInstallationSourceSchema,
  providerInstallationStatusParamsSchema,
  providerInstallationStatusSchema,
  providerInstallationVerificationSchema,
  providerInteractionOutcomeSchema,
  providerMaintenanceParamsSchema,
  providerRawEventSchema,
  providerRecoveryHintSchema,
  providerRecoveryKindSchema,
  providerRecoveryKindValues,
  providerRecoveryNotificationSchema,
  providerUsageResultSchema,
  providerUsageSchema,
  providerUsageWindowSchema,
  reasoningEffortsForLevels,
  reasoningLevelSchema,
  reasoningLevelValues,
  removeCommandMentionsFromPromptInput,
  runBridgeRequest,
  runtimePermissionScopeValues,
  sanitizeInheritedChildProcessEnv,
  sdkMessageEnvelopeSchema,
  shouldAutoDenyInteractiveRequest,
  skillsConfigureParamsSchema,
  textBlockSchema,
  threadArchiveParamsSchema,
  threadContextWindowUsageEnvelopeSchema,
  threadDeltaNotificationParamsSchema,
  threadDeltaSchema,
  threadDiscardParamsSchema,
  threadEventItemPresentationSchema,
  threadEventSearchModeSchema,
  threadForkParamsSchema,
  threadGoalClearParamsSchema,
  threadIdentityEnvelopeSchema,
  threadNameSetParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  threadUnarchiveParamsSchema,
  toNonNegativeNumber,
  toOptionalRecord,
  toOptionalString,
  toPositiveNumber,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  userQuestionInteractionOutcomeSchema,
  withoutBridgeRuntimeEnv
};
