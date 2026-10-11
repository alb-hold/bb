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

// ../domain/src/context-snapshot.ts
import { z } from "zod";
var tokenCountSchema = z.number().int().nonnegative();
var contextEntrySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tokens: tokenCountSchema
});
var contextCategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["used", "free", "reserved", "deferred"]),
  tokens: tokenCountSchema,
  entries: z.array(contextEntrySchema)
});
var contextSnapshotSchema = z.object({
  capturedAt: z.iso.datetime(),
  providerSessionId: z.string().min(1),
  providerTurnId: z.string().min(1).nullable(),
  model: z.string().min(1),
  usedTokens: tokenCountSchema,
  contextWindowTokens: z.number().int().positive(),
  autoCompactAtTokens: z.number().int().positive().nullable(),
  estimated: z.boolean(),
  categories: z.array(contextCategorySchema)
});

// ../domain/src/acp-cli.ts
import { z as z4 } from "zod";

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
import { z as z3 } from "zod";

// ../domain/src/json-value.ts
import { z as z2 } from "zod";
var jsonValueSchema = z2.lazy(
  () => z2.union([
    z2.string(),
    z2.number(),
    z2.boolean(),
    z2.null(),
    z2.array(jsonValueSchema),
    z2.record(z2.string(), jsonValueSchema)
  ])
);
var jsonObjectSchema = z2.record(
  z2.string(),
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
var reasoningLevelSchema = z3.string().min(1);
function isStandardReasoningLevel(level) {
  return reasoningLevelValues.includes(level);
}
function standardReasoningLevelRank(level) {
  const rank = reasoningLevelValues.indexOf(level);
  return rank === -1 ? null : rank;
}
function compareReasoningLevels(a2, b) {
  const aRank = standardReasoningLevelRank(a2);
  const bRank = standardReasoningLevelRank(b);
  if (aRank === null || bRank === null) {
    return aRank === bRank ? 0 : aRank === null ? 1 : -1;
  }
  return aRank - bRank;
}
var serviceTierSchema = z3.string().min(1);
var instructionModeValues = ["append", "replace"];
var instructionModeSchema = z3.enum(instructionModeValues);
var permissionModeValues = ["accept-edits", "auto", "full"];
var permissionModeSchema = z3.enum(permissionModeValues);
var permissionModeInputSchema = z3.union([permissionModeSchema, z3.literal("workspace-write")]).transform(
  (permissionMode) => permissionMode === "workspace-write" ? "accept-edits" : permissionMode
);
var legacyRecordedPermissionModeValues = [
  "workspace-write",
  "readonly"
];
var recordedPermissionModeSchema = z3.enum([
  ...permissionModeValues,
  ...legacyRecordedPermissionModeValues
]);
var permissionEscalationValues = ["ask", "deny"];
var permissionEscalationSchema = z3.enum(permissionEscalationValues);
var promptInputVisibilityValues = ["agent-only"];
var promptInputVisibilitySchema = z3.enum(promptInputVisibilityValues);
var promptInputVisibilityFields = {
  visibility: promptInputVisibilitySchema.optional()
};
var promptMentionPathSourceValues = ["workspace", "thread-storage"];
var promptMentionPathSourceSchema = z3.enum(promptMentionPathSourceValues);
var promptMentionPathEntryKindValues = ["file", "directory"];
var promptMentionPathEntryKindSchema = z3.enum(
  promptMentionPathEntryKindValues
);
var promptMentionCommandTriggerValues = ["/", "$"];
var promptMentionCommandTriggerSchema = z3.enum(
  promptMentionCommandTriggerValues
);
var promptMentionCommandSourceValues = ["skill", "command"];
var promptMentionCommandSourceSchema = z3.enum(
  promptMentionCommandSourceValues
);
var promptMentionCommandOriginValues = [
  "builtin",
  "project",
  "user"
];
var promptMentionCommandOriginSchema = z3.enum(
  promptMentionCommandOriginValues
);
var canonicalPromptMentionResourceSchema = z3.discriminatedUnion("kind", [
  z3.object({
    kind: z3.literal("thread"),
    threadId: z3.string(),
    projectId: z3.string().optional(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("project"),
    projectId: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("section"),
    sectionId: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("path"),
    source: promptMentionPathSourceSchema,
    entryKind: promptMentionPathEntryKindSchema,
    path: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("command"),
    trigger: promptMentionCommandTriggerSchema,
    name: z3.string(),
    source: promptMentionCommandSourceSchema,
    origin: promptMentionCommandOriginSchema,
    label: z3.string(),
    argumentHint: z3.string().nullable()
  }),
  z3.object({
    kind: z3.literal("plugin"),
    pluginId: z3.string(),
    icon: z3.string().nullable().optional(),
    itemId: z3.string(),
    label: z3.string()
  }),
  z3.object({
    kind: z3.literal("attachment"),
    path: z3.string(),
    label: z3.string()
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
var promptMentionResourceSchema = z3.preprocess(
  normalizeLegacyPromptMentionResource,
  canonicalPromptMentionResourceSchema
);
var promptTextMentionSchema = z3.object({
  start: z3.number().int().nonnegative(),
  end: z3.number().int().nonnegative(),
  resource: promptMentionResourceSchema
});
var promptInputSchema = z3.discriminatedUnion("type", [
  z3.object({
    type: z3.literal("text"),
    text: z3.string(),
    mentions: z3.array(promptTextMentionSchema).default([]),
    ...promptInputVisibilityFields
  }),
  z3.object({
    type: z3.literal("image"),
    url: z3.string().url(),
    ...promptInputVisibilityFields
  }),
  z3.object({
    type: z3.literal("localImage"),
    path: z3.string(),
    sourceProjectId: z3.string().min(1).optional(),
    hostId: z3.string().min(1).optional(),
    ...promptInputVisibilityFields
  }),
  z3.object({
    type: z3.literal("localFile"),
    path: z3.string(),
    sourceProjectId: z3.string().min(1).optional(),
    hostId: z3.string().min(1).optional(),
    name: z3.string().optional(),
    sizeBytes: z3.number().int().nonnegative().optional(),
    mimeType: z3.string().optional(),
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
var threadExecutionSourceSchema = z3.enum([
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start"
]);
var callerExecutionInputSourceValues = [
  "explicit",
  "client-preference"
];
var callerExecutionInputSourceSchema = z3.enum(
  callerExecutionInputSourceValues
);
var threadExecutionOptionsSchema = z3.object({
  model: z3.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  source: threadExecutionSourceSchema.optional(),
  seq: z3.number().int().optional()
});
var resolvedThreadExecutionOptionsSchema = threadExecutionOptionsSchema.extend({
  model: z3.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  source: threadExecutionSourceSchema
});
var recordedThreadExecutionOptionsSchema = resolvedThreadExecutionOptionsSchema.extend({
  permissionMode: recordedPermissionModeSchema
});
var threadExecutionReportSchema = z3.object({
  model: z3.string().min(1),
  reasoningLevel: reasoningLevelSchema.nullable(),
  permissionMode: permissionModeSchema.nullable(),
  serviceTier: serviceTierSchema.nullable()
});
var runtimePermissionScopeValues = ["workspace", "full"];
var runtimePermissionScopeSchema = z3.enum(runtimePermissionScopeValues);
var runtimePermissionPolicySchema = z3.discriminatedUnion(
  "permissionMode",
  [
    z3.object({
      permissionMode: z3.literal("accept-edits"),
      permissionScope: z3.literal("workspace"),
      approvalReviewer: z3.literal("user"),
      permissionEscalation: permissionEscalationSchema
    }),
    z3.object({
      permissionMode: z3.literal("auto"),
      permissionScope: z3.literal("workspace"),
      approvalReviewer: z3.literal("automatic"),
      permissionEscalation: permissionEscalationSchema
    }),
    z3.object({
      permissionMode: z3.literal("full"),
      permissionScope: z3.literal("full"),
      approvalReviewer: z3.null(),
      permissionEscalation: z3.null()
    })
  ]
);
var promptModeSchema = z3.literal("plan");
var sessionOptionValueSchema = z3.union([z3.string(), z3.boolean()]);
var sessionOptionSelectionsSchema = z3.record(
  z3.string().min(1),
  sessionOptionValueSchema
);
var runtimeThreadExecutionBaseOptionsSchema = z3.object({
  model: z3.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  providerOptions: jsonObjectSchema
});
var runtimeThreadExecutionOptionsSchema = runtimeThreadExecutionBaseOptionsSchema.and(runtimePermissionPolicySchema);
var projectExecutionDefaultsSchema = z3.object({
  providerId: z3.string().min(1),
  model: z3.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema
});

// ../domain/src/acp-cli.ts
var providerSkillRootPathSchema = z4.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Skill roots must be relative paths without dot segments"
);
var uniqueProviderSkillRootPathsSchema = z4.array(providerSkillRootPathSchema).superRefine((paths, context) => {
  if (new Set(paths).size !== paths.length) {
    context.addIssue({
      code: "custom",
      message: "Skill roots must not contain duplicates"
    });
  }
});
var providerNativeSkillRootsSchema = z4.object({
  user: uniqueProviderSkillRootPathsSchema.default([]),
  project: uniqueProviderSkillRootPathsSchema.default([])
}).strict();
var acpReasoningCliLevelValueOverridesSchema = z4.record(
  reasoningLevelSchema,
  z4.string().min(1)
);
var acpReasoningCliSchema = z4.object({
  flag: z4.string().min(1),
  supportedLevels: z4.array(reasoningLevelSchema).min(1),
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
var acpNativeReasoningSchema = z4.object({
  configId: z4.string().min(1),
  supportedLevels: z4.array(reasoningLevelSchema).min(1),
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
var acpPermissionCliArgsSchema = z4.array(z4.string().min(1)).min(1);
var acpPermissionCliSchema = z4.object({
  full: acpPermissionCliArgsSchema.optional(),
  workspaceWrite: acpPermissionCliArgsSchema.optional(),
  readonly: acpPermissionCliArgsSchema.optional(),
  insertAfterArgs: z4.number().int().min(0).optional()
}).strict().superRefine((permissionCli, context) => {
  if (permissionCli.full === void 0 && permissionCli.workspaceWrite === void 0 && permissionCli.readonly === void 0) {
    context.addIssue({
      code: "custom",
      message: "permissionCli must configure at least one permission mode"
    });
  }
});

// ../domain/src/native-roots.ts
import { z as z5 } from "zod";
var PROVIDER_NATIVE_ROOTS_MAX = 32;
var PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}:$/u;
var nativeRootNamePrefixSchema = z5.string().refine(
  (value) => value === "" || PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN.test(value),
  "A root name prefix is a plugin-name-like token ending in ':'"
);
var nativeRootManifestPathSchema = z5.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "A manifest marker is a relative path without dot segments"
);
var relativeNativeRootPathSchema = z5.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Roots must be relative paths without dot segments"
);
var absoluteNativeRootPathSchema = z5.string().min(1).refine(
  isAbsoluteProviderSkillRootPath,
  "Absolute roots must be absolute paths without dot segments"
);
var providerNativeRootInputSchema = z5.union([
  z5.string().min(1),
  z5.object({
    path: z5.string().min(1),
    /** Skills nest in subdirectories (the agent scans recursively). */
    recursive: z5.boolean().optional(),
    /**
     * Scan the same relative directory in every ancestor of the workspace
     * up to the repository root (`project` roots only).
     */
    ancestors: z5.boolean().optional(),
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
var providerNativeRootsInputSchema = z5.object({
  user: z5.array(providerNativeRootInputSchema).optional(),
  project: z5.array(providerNativeRootInputSchema).optional()
}).strict();
var providerNativeRootSchema = z5.object({
  path: z5.string().min(1),
  recursive: z5.boolean(),
  ancestors: z5.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  /** Absent: every skill-shaped directory under the root is a skill. */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
function uniqueByPath(roots) {
  return new Set(roots.map((root) => root.path)).size === roots.length;
}
function nativeRootSideSchema(side) {
  return z5.array(
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
var providerNativeRootsSchema = z5.object({
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
var providerResolvedNativeRootShapeSchema = z5.enum([
  "skills",
  "skill",
  "skill-file",
  "commands",
  "command-file"
]);
var resolvedNativeRootFieldsSchema = z5.object({
  path: absoluteNativeRootPathSchema,
  origin: z5.enum(["user", "project"]),
  recursive: z5.boolean(),
  /** Only with origin `project`, for a path inside the workspace. */
  ancestors: z5.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  shape: providerResolvedNativeRootShapeSchema,
  /**
   * `skill-file` only: the skill name when the file's frontmatter names
   * none. A vendor plugin's root SKILL.md takes the plugin's name; absent
   * means the parent directory's name.
   */
  fallbackName: z5.string().min(1).optional(),
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
var providerResolvedNativeRootsSchema = z5.object({
  skills: z5.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedSkillShapes.has(root.shape),
      "A skills root needs a skill shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX),
  commands: z5.array(
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
var providerNativeRootSetSchema = z5.object({
  skills: providerNativeRootsSchema,
  commands: providerNativeRootsSchema,
  resolved: providerResolvedNativeRootsSchema
}).strict();

// ../domain/src/completed-turn-display.ts
import { z as z6 } from "zod";
var COMPLETED_TURN_DISPLAY_VALUES = ["collapse", "flat"];
var completedTurnDisplaySchema = z6.enum(COMPLETED_TURN_DISPLAY_VALUES);

// ../domain/src/background-task.ts
import { z as z7 } from "zod";
var backgroundTaskStatusValues = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "killed",
  "stopped"
];
var backgroundTaskStatusSchema = z7.enum(backgroundTaskStatusValues);
var workflowAgentStateValues = [
  "queued",
  "running",
  "done",
  "failed",
  "skipped"
];
var workflowAgentStateSchema = z7.enum(workflowAgentStateValues);
var workflowAgentSnapshotSchema = z7.object({
  index: z7.number().int().positive(),
  label: z7.string(),
  state: workflowAgentStateSchema,
  model: z7.string(),
  attempt: z7.number().int().positive(),
  cached: z7.boolean(),
  lastProgressAt: z7.number(),
  phaseIndex: z7.number().int().positive().optional(),
  phaseTitle: z7.string().optional(),
  agentType: z7.string().optional(),
  isolation: z7.string().optional(),
  queuedAt: z7.number().optional(),
  startedAt: z7.number().optional(),
  lastToolName: z7.string().optional(),
  lastToolSummary: z7.string().optional(),
  promptPreview: z7.string().optional(),
  resultPreview: z7.string().optional(),
  error: z7.string().optional(),
  tokens: z7.number().optional(),
  toolCalls: z7.number().optional(),
  durationMs: z7.number().optional()
});
var workflowPhaseSnapshotSchema = z7.object({
  index: z7.number().int().positive(),
  title: z7.string(),
  kind: z7.string().optional()
});
var workflowProgressSnapshotSchema = z7.object({
  phases: z7.array(workflowPhaseSnapshotSchema),
  agents: z7.array(workflowAgentSnapshotSchema)
});
var backgroundTaskUsageSchema = z7.object({
  totalTokens: z7.number(),
  toolUses: z7.number(),
  durationMs: z7.number()
});

// ../domain/src/provider-event.ts
import { z as z16 } from "zod";

// ../domain/src/thread-events.ts
import { z as z13 } from "zod";

// ../domain/src/pending-interactions.ts
import { z as z10 } from "zod";

// ../domain/src/plugin-interaction-limits.ts
var PLUGIN_INTERACTION_MAX_TITLE_LENGTH = 160;
var PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES = 64 * 1024;
var PLUGIN_INTERACTION_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1e3;
function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ../domain/src/item-presentation.ts
import { z as z8 } from "zod";
var THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH = 280;
var threadEventItemPresentationLabelSchema = z8.object({
  pending: z8.string().min(1),
  completed: z8.string().min(1)
});
var threadEventItemPresentationIconSchema = z8.object({
  glyph: z8.string().min(1)
});
var threadEventItemPresentationTintSchema = z8.object({
  light: z8.string().min(1),
  dark: z8.string().min(1)
});
var THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH = 80;
var threadEventItemPresentationBadgeSchema = z8.object({
  glyph: z8.string().min(1),
  label: z8.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  hint: z8.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  tone: z8.enum(["neutral", "destructive"])
});
var threadEventItemPresentationSchema = z8.object({
  label: threadEventItemPresentationLabelSchema,
  icon: threadEventItemPresentationIconSchema,
  title: z8.string().optional(),
  detail: z8.string().max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  suppress: z8.boolean().optional(),
  tint: threadEventItemPresentationTintSchema.optional(),
  badge: threadEventItemPresentationBadgeSchema.optional()
});

// ../domain/src/provider-extension-kind.ts
import { z as z9 } from "zod";
var EXTENSION_KIND_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/u;
function isExtensionKind(value) {
  return EXTENSION_KIND_PATTERN.test(value);
}
var extensionKindSchema = z9.string().refine(isExtensionKind, {
  message: 'extension kinds are "<pluginId>/<name>" (lowercase letters, digits, and "-")'
});

// ../domain/src/pending-interactions.ts
var pendingInteractionStatusSchema = z10.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted"
]);
var pendingInteractionCommandActionSchema = z10.discriminatedUnion(
  "type",
  [
    z10.object({
      type: z10.literal("read"),
      command: z10.string(),
      name: z10.string(),
      path: z10.string()
    }),
    z10.object({
      type: z10.literal("listFiles"),
      command: z10.string(),
      path: z10.string().nullable()
    }),
    z10.object({
      type: z10.literal("search"),
      command: z10.string(),
      query: z10.string().nullable(),
      path: z10.string().nullable()
    }),
    z10.object({
      type: z10.literal("unknown"),
      command: z10.string()
    })
  ]
);
var pendingInteractionNetworkPermissionsSchema = z10.object({
  enabled: z10.boolean().nullable()
});
var pendingInteractionFileSystemPermissionsSchema = z10.object({
  read: z10.array(z10.string()),
  write: z10.array(z10.string())
});
var pendingInteractionMacOsPreferencesPermissionSchema = z10.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsContactsPermissionSchema = z10.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsAutomationPermissionSchema = z10.union([
  z10.literal("none"),
  z10.literal("all"),
  z10.object({
    kind: z10.literal("bundle_ids"),
    bundleIds: z10.array(z10.string())
  })
]);
var pendingInteractionMacOsPermissionsSchema = z10.object({
  preferences: pendingInteractionMacOsPreferencesPermissionSchema,
  automations: pendingInteractionMacOsAutomationPermissionSchema,
  launchServices: z10.boolean(),
  accessibility: z10.boolean(),
  calendar: z10.boolean(),
  reminders: z10.boolean(),
  contacts: pendingInteractionMacOsContactsPermissionSchema
});
var pendingInteractionRequestedPermissionProfileSchema = z10.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
  macos: pendingInteractionMacOsPermissionsSchema.nullable()
});
var pendingInteractionGrantablePermissionProfileSchema = z10.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable()
}).strict();
var pendingInteractionGrantedPermissionProfileSchema = pendingInteractionGrantablePermissionProfileSchema;
var pendingInteractionApprovalDecisionSchema = z10.enum([
  "allow_once",
  "allow_for_session",
  "deny"
]);
var pendingInteractionFileChangeWriteScopeSchema = z10.string().min(1);
var pendingInteractionCommandApprovalSubjectSchema = z10.object({
  kind: z10.literal("command"),
  itemId: z10.string().min(1),
  command: z10.string().min(1),
  cwd: z10.string().nullable(),
  actions: z10.array(pendingInteractionCommandActionSchema),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionFileChangeApprovalSubjectSchema = z10.object({
  kind: z10.literal("file_change"),
  itemId: z10.string().min(1),
  writeScope: pendingInteractionFileChangeWriteScopeSchema.nullable(),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionPermissionGrantApprovalSubjectSchema = z10.object({
  kind: z10.literal("permission_grant"),
  itemId: z10.string().min(1),
  toolName: z10.string().nullable(),
  permissions: pendingInteractionGrantablePermissionProfileSchema
});
var pendingInteractionPlanApprovalSubjectSchema = z10.object({
  kind: z10.literal("plan"),
  itemId: z10.string().min(1),
  plan: z10.string().min(1),
  planFilePath: z10.string().min(1).nullable()
});
var pendingInteractionToolUseApprovalSubjectSchema = z10.object({
  kind: z10.literal("tool_use"),
  itemId: z10.string().min(1),
  tool: z10.string().min(1),
  presentation: threadEventItemPresentationSchema
});
var pendingInteractionApprovalSubjectSchema = z10.discriminatedUnion("kind", [
  pendingInteractionCommandApprovalSubjectSchema,
  pendingInteractionFileChangeApprovalSubjectSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionPlanApprovalSubjectSchema,
  pendingInteractionToolUseApprovalSubjectSchema
]);
var approvalPendingInteractionPayloadSchema = z10.object({
  kind: z10.literal("approval"),
  subject: pendingInteractionApprovalSubjectSchema,
  reason: z10.string().nullable(),
  availableDecisions: z10.array(pendingInteractionApprovalDecisionSchema).min(1)
});
var USER_QUESTION_MAX_QUESTIONS = 4;
var USER_QUESTION_MAX_OPTIONS = 4;
var USER_QUESTION_MAX_SELECTED = 4;
var USER_QUESTION_MAX_FREE_TEXT_LENGTH = 4096;
var pendingInteractionUserQuestionIdSchema = z10.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question ids cannot be blank"
});
var pendingInteractionUserQuestionPromptSchema = z10.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question prompts cannot be blank"
});
var pendingInteractionUserQuestionShortLabelSchema = z10.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question short labels cannot be blank"
});
var pendingInteractionUserQuestionOptionValueSchema = z10.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option values cannot be blank"
});
var pendingInteractionUserQuestionOptionLabelSchema = z10.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option labels cannot be blank"
});
var pendingInteractionUserQuestionOptionDescriptionSchema = z10.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option descriptions cannot be blank"
});
var pendingInteractionUserQuestionFreeTextSchema = z10.string().min(1).max(
  USER_QUESTION_MAX_FREE_TEXT_LENGTH,
  `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`
).refine((value) => value.trim().length > 0, {
  message: "User question free text cannot be blank"
});
var pendingInteractionUserQuestionOptionSchema = z10.object({
  value: pendingInteractionUserQuestionOptionValueSchema,
  label: pendingInteractionUserQuestionOptionLabelSchema,
  description: pendingInteractionUserQuestionOptionDescriptionSchema.optional()
});
var pendingInteractionUserQuestionQuestionSchema = z10.object({
  id: pendingInteractionUserQuestionIdSchema,
  prompt: pendingInteractionUserQuestionPromptSchema,
  shortLabel: pendingInteractionUserQuestionShortLabelSchema.optional(),
  multiSelect: z10.boolean(),
  options: z10.array(pendingInteractionUserQuestionOptionSchema).max(
    USER_QUESTION_MAX_OPTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_OPTIONS} options`
  ).optional(),
  allowFreeText: z10.boolean()
}).superRefine((question, context) => {
  const optionValues = /* @__PURE__ */ new Set();
  question.options?.forEach((option, index) => {
    if (optionValues.has(option.value)) {
      context.addIssue({
        code: z10.ZodIssueCode.custom,
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
var userQuestionPendingInteractionPayloadSchema = z10.object({
  kind: z10.literal("user_question"),
  questions: z10.array(pendingInteractionUserQuestionQuestionSchema).min(1).max(
    USER_QUESTION_MAX_QUESTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_QUESTIONS} questions`
  )
}).superRefine((payload, context) => {
  const questionIds = /* @__PURE__ */ new Set();
  payload.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: z10.ZodIssueCode.custom,
        message: "User question ids must be unique",
        path: ["questions", index, "id"]
      });
      return;
    }
    questionIds.add(question.id);
  });
});
var pluginPendingInteractionPayloadSchema = z10.object({
  kind: z10.literal("plugin"),
  title: z10.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema,
  presentation: threadEventItemPresentationSchema.optional()
});
var pluginExtensionInteractionRequestPayloadSchema = z10.object({
  kind: extensionKindSchema,
  title: z10.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin request data exceeds 64 KiB" }
  )
});
var interactionRequestPayloadSchema = z10.union([
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
var pendingInteractionPayloadSchema = z10.union([
  approvalPendingInteractionPayloadSchema,
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
function isApprovalPendingInteractionPayload(payload) {
  return payload.kind === "approval";
}
var approvalDecisionDiscriminatorError = "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'";
var approvalPendingInteractionResolutionSchema = z10.discriminatedUnion(
  "decision",
  [
    z10.object({
      decision: z10.literal("allow_once"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z10.object({
      decision: z10.literal("allow_for_session"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z10.object({
      decision: z10.literal("deny")
    })
  ],
  approvalDecisionDiscriminatorError
);
var pendingInteractionUserAnswerSchema = z10.object({
  selected: z10.array(z10.string().min(1)).max(
    USER_QUESTION_MAX_SELECTED,
    `User question selected choices cannot exceed ${USER_QUESTION_MAX_SELECTED}`
  ),
  freeText: pendingInteractionUserQuestionFreeTextSchema.optional()
});
var userQuestionPendingInteractionResolutionSchema = z10.object({
  kind: z10.literal("user_answer"),
  answers: z10.record(z10.string().min(1), pendingInteractionUserAnswerSchema)
});
var pluginInteractionDescriptionSchema = z10.object({
  title: z10.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH).optional(),
  detail: z10.string().trim().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  payload: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin interaction description payload exceeds 64 KiB" }
  ).optional()
});
var pluginPendingInteractionResolutionSchema = z10.object({
  kind: z10.literal("plugin_submitted"),
  description: pluginInteractionDescriptionSchema.optional()
});
var pluginExtensionInteractionResolutionSchema = z10.object({
  kind: z10.literal("request_answer"),
  value: jsonValueSchema
});
var pendingInteractionResolutionSchema = z10.union(
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
var approvalInteractionOutcomeSchema = z10.object({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema
});
var userQuestionInteractionOutcomeSchema = z10.object({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema
});
var pluginExtensionInteractionOutcomeSchema = z10.object({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema
});
var providerInteractionOutcomeSchema = z10.union([
  approvalInteractionOutcomeSchema,
  userQuestionInteractionOutcomeSchema,
  pluginExtensionInteractionOutcomeSchema
]);
var pendingInteractionProviderOriginSchema = z10.object({
  kind: z10.literal("provider"),
  providerId: z10.string().min(1),
  providerThreadId: z10.string().min(1),
  providerRequestId: z10.string().min(1)
});
var pendingInteractionPluginOriginSchema = z10.object({
  kind: z10.literal("plugin"),
  pluginId: z10.string().min(1),
  rendererId: z10.string().min(1)
});
var pendingInteractionCreateSchema = z10.object({
  threadId: z10.string().min(1),
  turnId: z10.string().min(1),
  providerId: z10.string().min(1),
  providerThreadId: z10.string().min(1),
  providerRequestId: z10.string().min(1),
  payload: pendingInteractionPayloadSchema
});
var pendingInteractionBaseSchema = z10.object({
  id: z10.string().min(1),
  threadId: z10.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z10.string().nullable(),
  createdAt: z10.number().int().nonnegative(),
  expiresAt: z10.number().int().nonnegative().nullable().optional(),
  resolvedAt: z10.number().int().nonnegative().nullable()
});
var providerPendingInteractionBaseSchema = pendingInteractionBaseSchema.extend({
  turnId: z10.string().min(1),
  providerId: z10.string().min(1),
  providerThreadId: z10.string().min(1),
  providerRequestId: z10.string().min(1),
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
var providerPendingInteractionSchema = z10.union([
  approvalPendingInteractionSchema,
  userQuestionPendingInteractionSchema,
  pluginExtensionPendingInteractionSchema
]);
var pluginPendingInteractionSchema = pendingInteractionBaseSchema.extend({
  turnId: z10.string().min(1).nullable(),
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema,
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pendingInteractionSchema = z10.union([
  providerPendingInteractionSchema,
  pluginPendingInteractionSchema
]);
var interactionLifecycleRecordBaseSchema = z10.object({
  id: z10.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z10.string().nullable()
});
var interactionLifecycleProviderOriginSchema = z10.object({
  kind: z10.literal("provider"),
  providerId: z10.string().min(1),
  providerRequestId: z10.string().min(1)
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
var interactionLifecycleSchema = z10.union([
  approvalInteractionLifecycleSchema,
  userQuestionInteractionLifecycleSchema,
  pluginInteractionLifecycleSchema,
  pluginExtensionInteractionLifecycleSchema
]);

// ../domain/src/protocol-ids.ts
import { z as z11 } from "zod";
var clientTurnRequestIdSchema = z11.string().regex(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);

// ../domain/src/system-message.ts
import { z as z12 } from "zod";
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
var systemMessageKindSchema = z12.enum(systemMessageKindValues);
var systemThreadInterruptedReasonSchema = z12.enum([
  "manual-stop",
  "host-daemon-restarted",
  "host-removed",
  "provider-turn-idle"
]);
var childThreadOutcomeSchema = z12.object({
  threadId: z12.string(),
  status: z12.enum(["completed", "failed", "interrupted"]),
  interruption: z12.object({
    reason: systemThreadInterruptedReasonSchema,
    cause: z12.literal("host-connection-lost").optional()
  }).optional()
});
var systemMessageSubjectSchema = z12.discriminatedUnion("kind", [
  z12.object({
    kind: z12.literal("thread"),
    threadId: z12.string(),
    threadName: z12.string(),
    outcomes: z12.array(childThreadOutcomeSchema).optional()
  }),
  z12.object({
    kind: z12.literal("thread-batch"),
    count: z12.number(),
    outcomes: z12.array(childThreadOutcomeSchema).optional()
  }),
  z12.object({
    kind: z12.literal("tool-call"),
    toolName: z12.string(),
    suppress: z12.boolean()
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
var threadTurnInitiatorSchema = z13.enum(threadTurnInitiatorValues);
var turnRequestOptionsSchema = recordedThreadExecutionOptionsSchema;
var turnRequestTargetSchema = z13.discriminatedUnion("kind", [
  z13.object({ kind: z13.literal("thread-start") }),
  z13.object({ kind: z13.literal("new-turn") }),
  z13.object({
    kind: z13.literal("auto"),
    expectedTurnId: z13.string().nullable()
  }),
  z13.object({
    kind: z13.literal("steer"),
    expectedTurnId: z13.string().nullable()
  })
]);
var clientTurnLifecycleEventDataSchema = z13.object({
  direction: z13.literal("outbound"),
  source: z13.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  request: z13.object({
    method: z13.enum(["thread/start", "turn/start"]),
    params: z13.record(z13.string(), z13.unknown())
  })
});
var turnRequestEventDataSchema = z13.object({
  direction: z13.literal("outbound"),
  requestId: clientTurnRequestIdSchema,
  // Retry provenance, written only when a `turn.failed` gate's retry row
  // dispatches. Both fields are present together or not at all: absence means
  // "this is an original dispatch", which is the overwhelmingly common case.
  // (Supersedes the pre-plugin `continuationOfRequestId` key, which the removed
  // core rate-limit recovery wrote and nothing ever read.)
  /** The original request this attempt re-submits, unchanged across attempts. */
  retryOfRequestId: clientTurnRequestIdSchema.optional(),
  /** Which attempt this is: 2 is the first retry of the original request. */
  retryAttempt: z13.number().int().min(2).optional(),
  source: z13.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  senderThreadId: z13.string().nullable(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
  input: z13.array(promptInputSchema),
  inputGroups: z13.array(z13.array(promptInputSchema).min(1)).min(1).optional(),
  target: turnRequestTargetSchema,
  request: z13.object({
    method: z13.enum(["thread/start", "turn/start"]),
    params: z13.record(z13.string(), z13.unknown())
  }),
  execution: turnRequestOptionsSchema
});
var turnRequestRejectedEventDataSchema = z13.object({
  requestId: clientTurnRequestIdSchema,
  reason: z13.string().min(1),
  message: z13.string().min(1)
});
var systemErrorEventDataSchema = z13.object({
  code: z13.string().optional(),
  message: z13.string(),
  detail: z13.string().optional()
});
var ownershipChangeOperationActionValues = [
  "assign",
  "release",
  "transfer"
];
var ownershipChangeOperationActionSchema = z13.enum(
  ownershipChangeOperationActionValues
);
var ownershipChangeOperationMetadataSchema = z13.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z13.string().nullable(),
  nextParentThreadTitle: z13.string().nullable(),
  previousParentThreadId: z13.string().nullable(),
  previousParentThreadTitle: z13.string().nullable()
});
var systemOperationEventDataSchema = z13.object({
  operation: z13.string(),
  status: z13.string(),
  message: z13.string(),
  operationId: z13.string(),
  metadata: z13.record(z13.string(), jsonValueSchema).optional()
});
var systemInteractionLifecycleEventDataSchema = z13.object({
  interaction: interactionLifecycleSchema
});
var systemPermissionGrantLifecycleEventDataSchema = z13.object({
  interactionId: z13.string(),
  providerId: z13.string(),
  providerRequestId: z13.string(),
  status: pendingInteractionStatusSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z13.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema
});
var systemUserQuestionLifecycleEventDataSchema = z13.object({
  interactionId: z13.string(),
  providerId: z13.string(),
  providerRequestId: z13.string(),
  status: pendingInteractionStatusSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z13.string().nullable().default(null),
  payload: userQuestionPendingInteractionPayloadSchema
});
var systemThreadInterruptedEventDataSchema = z13.object({
  reason: systemThreadInterruptedReasonSchema,
  cause: z13.literal("host-connection-lost").optional()
});
var provisioningTranscriptEntrySchema = z13.object({
  type: z13.enum(["step", "output"]),
  key: z13.string(),
  text: z13.string(),
  startedAt: z13.number().optional(),
  status: z13.enum(["started", "completed", "failed"]).optional(),
  metadata: z13.record(z13.string(), z13.unknown()).optional()
});
var systemThreadProvisioningStatusValues = [
  "active",
  "completed",
  "failed",
  "cancelled"
];
var systemThreadProvisioningStatusSchema = z13.enum(
  systemThreadProvisioningStatusValues
);
var systemThreadProvisioningEventDataSchema = z13.object({
  provisioningId: z13.string(),
  status: systemThreadProvisioningStatusSchema,
  environmentId: z13.string().nullable(),
  entries: z13.array(provisioningTranscriptEntrySchema)
});
var systemLegacyUserMessageEventDataSchema = z13.object({
  text: z13.string(),
  toolCallId: z13.string().optional(),
  turnId: z13.string().optional()
});
var systemProviderTurnWatchdogEventDataSchema = z13.object({
  reason: z13.literal("provider-turn-idle"),
  thresholdMs: z13.number().int().positive(),
  elapsedMs: z13.number().int().nonnegative(),
  activeTurnId: z13.string().min(1),
  activeTurnStartedAt: z13.number().int().nonnegative(),
  lastActivityEventSequence: z13.number().int().positive(),
  lastActivityEventType: z13.string().min(1),
  lastActivityEventAt: z13.number().int().nonnegative(),
  providerId: z13.string().min(1),
  providerThreadId: z13.string().min(1).nullable(),
  firedAt: z13.number().int().nonnegative()
});

// ../domain/src/thread-event-scope.ts
import { z as z14 } from "zod";
var threadEventScopeKindValues = ["thread", "turn"];
var threadEventScopeKindSchema = z14.enum(threadEventScopeKindValues);
var threadEventScopeSchema = z14.discriminatedUnion("kind", [
  z14.object({ kind: z14.literal("thread") }),
  z14.object({ kind: z14.literal("turn"), turnId: z14.string().min(1) })
]);
var threadEventScopePolicyValues = [
  "thread",
  "turn",
  "thread-or-turn"
];
var threadEventScopePolicySchema = z14.enum(threadEventScopePolicyValues);
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
import { z as z15 } from "zod";
var threadTimelineGoalStatusSchema = z15.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete"
]);
var threadTimelineGoalSchema = z15.object({
  sourceSeq: z15.number().int().nonnegative(),
  updatedAt: z15.number(),
  objective: z15.string(),
  status: threadTimelineGoalStatusSchema,
  tokenBudget: z15.number().nullable(),
  tokensUsed: z15.number(),
  timeUsedSeconds: z15.number()
});

// ../domain/src/provider-event.ts
var threadEventItemStatusSchema = z16.enum([
  "pending",
  "completed",
  "failed",
  "interrupted"
]);
var threadEventItemApprovalStatusSchema = z16.enum(["waiting_for_approval", "denied"]).nullable();
var threadEventTurnStatusSchema = z16.enum([
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
var providerErrorCategorySchema = z16.enum(providerErrorCategoryValues);
var providerErrorInfoSchema = z16.object({
  category: providerErrorCategorySchema,
  providerCode: z16.string().nullable(),
  httpStatusCode: z16.number().nullable()
});
var providerRateLimitStatusSchema = z16.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown"
]);
var providerRateLimitWindowSchema = z16.object({
  providerKey: z16.string().min(1).nullable(),
  label: z16.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z16.number().int().nonnegative().nullable()
});
var providerRateLimitStateSchema = z16.object({
  providerId: z16.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z16.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z16.array(providerRateLimitWindowSchema),
  reachedReason: z16.string().min(1).nullable(),
  overageStatus: z16.enum(["allowed", "warning", "rejected", "unavailable"]).nullable(),
  overageReason: z16.string().min(1).nullable()
});
var threadEventFileChangeKindSchema = z16.enum(["add", "delete", "update"]);
var threadEventFileChangeSchema = z16.object({
  path: z16.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z16.string().optional(),
  diff: z16.string().optional()
});
var threadEventPlanStepStatusSchema = z16.enum([
  "pending",
  "active",
  "completed",
  "failed"
]);
var threadEventPlanStepSchema = z16.object({
  step: z16.string(),
  status: threadEventPlanStepStatusSchema.optional()
});
var itemPresentationField = {
  presentation: threadEventItemPresentationSchema.optional()
};
var threadEventWebSearchItemSchema = z16.object({
  type: z16.literal("webSearch"),
  id: z16.string(),
  queries: z16.array(z16.string()).min(1),
  resultText: z16.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventWebFetchItemSchema = z16.object({
  type: z16.literal("webFetch"),
  id: z16.string(),
  url: z16.string(),
  prompt: z16.string().nullable(),
  pattern: z16.string().nullable(),
  resultText: z16.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventImageViewItemSchema = z16.object({
  type: z16.literal("imageView"),
  id: z16.string(),
  path: z16.string(),
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventFileReadItemSchema = z16.object({
  type: z16.literal("fileRead"),
  id: z16.string(),
  path: z16.string(),
  cmd: z16.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventSearchModeSchema = z16.enum(["content", "path", "list"]);
var threadEventSearchItemSchema = z16.object({
  type: z16.literal("search"),
  id: z16.string(),
  mode: threadEventSearchModeSchema,
  query: z16.string(),
  path: z16.string().optional(),
  cmd: z16.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventDelegationItemSchema = z16.object({
  type: z16.literal("delegation"),
  id: z16.string(),
  childRef: z16.string().min(1),
  label: z16.string(),
  status: threadEventItemStatusSchema,
  background: z16.boolean(),
  summary: z16.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventPlanStepsItemSchema = z16.object({
  type: z16.literal("planSteps"),
  id: z16.string(),
  steps: z16.array(threadEventPlanStepSchema),
  explanation: z16.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventExtensionItemSchema = z16.object({
  type: z16.literal("extension"),
  id: z16.string(),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
  status: threadEventItemStatusSchema,
  presentation: threadEventItemPresentationSchema,
  parentToolCallId: z16.string().optional()
});
var threadEventTextTruncationSchema = z16.object({
  originalLength: z16.number(),
  retainedHeadLength: z16.number(),
  retainedTailLength: z16.number(),
  truncatedAt: z16.number()
});
var threadEventItemTruncationSchema = z16.object({
  aggregatedOutput: threadEventTextTruncationSchema.optional(),
  result: threadEventTextTruncationSchema.optional(),
  resultText: threadEventTextTruncationSchema.optional()
});
var threadEventImageGenerationItemSchema = z16.object({
  type: z16.literal("imageGeneration"),
  id: z16.string(),
  status: threadEventItemStatusSchema,
  prompt: z16.string().nullable(),
  path: z16.string().nullable(),
  result: z16.string().optional(),
  error: z16.string().nullable(),
  transparentBackground: z16.boolean(),
  truncation: threadEventItemTruncationSchema.optional(),
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventUserContentSchema = z16.discriminatedUnion("type", [
  z16.object({ type: z16.literal("text"), text: z16.string() }),
  z16.object({ type: z16.literal("image"), url: z16.string() }),
  z16.object({ type: z16.literal("localImage"), path: z16.string() }),
  z16.object({ type: z16.literal("localFile"), path: z16.string() })
]);
var threadEventTokenUsageBreakdownSchema = z16.object({
  totalTokens: z16.number(),
  inputTokens: z16.number(),
  cachedInputTokens: z16.number(),
  cacheReadInputTokens: z16.number().nonnegative().optional(),
  cacheWriteInputTokens: z16.number().nonnegative().optional(),
  outputTokens: z16.number(),
  reasoningOutputTokens: z16.number()
});
var threadUsageCostSchema = z16.object({
  amount: z16.number().nonnegative(),
  currency: z16.string().min(1)
});
var threadEventContextWindowUsageSchema = z16.object({
  snapshot: contextSnapshotSchema.optional(),
  usedTokens: z16.number().nullable(),
  modelContextWindow: z16.number().nullable(),
  estimated: z16.boolean(),
  cost: threadUsageCostSchema.optional()
});
var threadEventTokenUsageSchema = z16.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z16.number().nullable()
});
var threadEventWarningCategorySchema = z16.enum([
  "deprecation",
  "config",
  "general",
  "compaction-skipped"
]);
var providerRawEventSchema = z16.object({
  jsonrpc: z16.literal("2.0"),
  id: z16.union([z16.string(), z16.number()]).optional(),
  method: z16.string(),
  params: jsonValueSchema.optional()
});
var providerUnhandledEventSchema = z16.object({
  type: z16.literal("provider/unhandled"),
  threadId: z16.string(),
  providerThreadId: z16.string(),
  providerId: z16.string(),
  rawType: z16.string(),
  rawEvent: providerRawEventSchema,
  parentToolCallId: z16.string().optional()
});
var toolCallProgressEventSchema = z16.object({
  type: z16.literal("item/toolCall/progress"),
  threadId: z16.string(),
  providerThreadId: z16.string(),
  itemId: z16.string(),
  message: z16.string().optional(),
  parentToolCallId: z16.string().optional()
});
var threadEventBackgroundTaskItemSchema = z16.object({
  type: z16.literal("backgroundTask"),
  id: z16.string(),
  familyId: z16.string().optional(),
  taskType: z16.string(),
  description: z16.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z16.boolean(),
  workflowName: z16.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z16.string().optional(),
  error: z16.string().optional(),
  outputFile: z16.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z16.string().optional()
});
var threadEventItemSchema = z16.discriminatedUnion("type", [
  z16.object({
    type: z16.literal("userMessage"),
    id: z16.string(),
    content: z16.array(threadEventUserContentSchema),
    clientRequestId: clientTurnRequestIdSchema.optional(),
    parentToolCallId: z16.string().optional()
  }).strict(),
  z16.object({
    type: z16.literal("agentMessage"),
    id: z16.string(),
    text: z16.string(),
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("commandExecution"),
    id: z16.string(),
    command: z16.string(),
    cwd: z16.string(),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    aggregatedOutput: z16.string().optional(),
    exitCode: z16.number().optional(),
    durationMs: z16.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("fileChange"),
    id: z16.string(),
    changes: z16.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  threadEventWebSearchItemSchema,
  threadEventWebFetchItemSchema,
  threadEventImageViewItemSchema,
  threadEventImageGenerationItemSchema,
  threadEventFileReadItemSchema,
  threadEventSearchItemSchema,
  z16.object({
    type: z16.literal("toolCall"),
    id: z16.string(),
    server: z16.string().optional(),
    tool: z16.string(),
    arguments: z16.record(z16.string(), z16.unknown()).optional(),
    status: threadEventItemStatusSchema,
    result: z16.unknown().optional(),
    error: z16.string().optional(),
    durationMs: z16.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("reasoning"),
    id: z16.string(),
    summary: z16.array(z16.string()),
    content: z16.array(z16.string()),
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("plan"),
    id: z16.string(),
    text: z16.string(),
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  threadEventPlanStepsItemSchema,
  z16.object({
    type: z16.literal("contextCompaction"),
    id: z16.string(),
    ...itemPresentationField,
    parentToolCallId: z16.string().optional()
  }),
  threadEventBackgroundTaskItemSchema,
  threadEventDelegationItemSchema,
  threadEventExtensionItemSchema
]);
function itemTextDeltaEventSchema(type) {
  return z16.object({
    type: z16.literal(type),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    itemId: z16.string(),
    delta: z16.string(),
    parentToolCallId: z16.string().optional()
  });
}
var unscopedProviderEventSchema = z16.discriminatedUnion("type", [
  z16.object({
    type: z16.literal("thread/started"),
    threadId: z16.string()
  }),
  z16.object({
    type: z16.literal("thread/identity"),
    threadId: z16.string(),
    providerThreadId: z16.string()
  }),
  z16.object({
    type: z16.literal("turn/started"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    parentToolCallId: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("turn/completed"),
    threadId: z16.string(),
    providerThreadId: z16.string().nullable(),
    status: threadEventTurnStatusSchema,
    error: z16.object({ message: z16.string() }).optional(),
    providerCheckpointId: z16.string().min(1).optional()
  }),
  z16.object({
    type: z16.literal("turn/input/accepted"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    clientRequestId: clientTurnRequestIdSchema,
    scope: threadEventScopeSchema
  }).strict(),
  z16.object({
    type: z16.literal("thread/name/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    threadName: z16.string(),
    source: z16.literal("agent").optional()
  }),
  z16.object({
    type: z16.literal("thread/compacted"),
    threadId: z16.string(),
    providerThreadId: z16.string()
  }),
  z16.object({
    type: z16.literal("thread/context/cleared"),
    threadId: z16.string(),
    providerThreadId: z16.string()
  }),
  z16.object({
    type: z16.literal("thread/goal/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    objective: z16.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z16.number().nullable(),
    tokensUsed: z16.number(),
    timeUsedSeconds: z16.number()
  }),
  z16.object({
    type: z16.literal("thread/goal/cleared"),
    threadId: z16.string(),
    providerThreadId: z16.string()
  }),
  z16.object({
    type: z16.literal("item/started"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    item: threadEventItemSchema
  }),
  z16.object({
    type: z16.literal("item/completed"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    item: threadEventItemSchema
  }),
  itemTextDeltaEventSchema("item/agentMessage/delta"),
  z16.object({
    type: z16.literal("item/commandExecution/outputDelta"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    itemId: z16.string(),
    delta: z16.string(),
    reset: z16.boolean().optional(),
    parentToolCallId: z16.string().optional()
  }),
  itemTextDeltaEventSchema("item/fileChange/outputDelta"),
  itemTextDeltaEventSchema("item/reasoning/summaryTextDelta"),
  itemTextDeltaEventSchema("item/reasoning/textDelta"),
  itemTextDeltaEventSchema("item/plan/delta"),
  z16.object({
    type: z16.literal("item/mcpToolCall/progress"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    itemId: z16.string(),
    message: z16.string().optional(),
    parentToolCallId: z16.string().optional()
  }),
  toolCallProgressEventSchema,
  z16.object({
    type: z16.literal("item/backgroundTask/progress"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z16.object({
    type: z16.literal("item/backgroundTask/completed"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z16.object({
    type: z16.literal("item/delegation/progress"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    item: threadEventDelegationItemSchema
  }),
  z16.object({
    type: z16.literal("item/delegation/completed"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    item: threadEventDelegationItemSchema
  }),
  z16.object({
    type: z16.literal("thread/tokenUsage/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    tokenUsage: threadEventTokenUsageSchema
  }),
  z16.object({
    type: z16.literal("thread/contextWindowUsage/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    contextWindowUsage: threadEventContextWindowUsageSchema
  }),
  z16.object({
    type: z16.literal("turn/plan/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    plan: z16.array(threadEventPlanStepSchema),
    explanation: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("turn/diff/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    diff: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("provider/error"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    message: z16.string(),
    detail: z16.string().optional(),
    willRetry: z16.boolean().optional(),
    errorInfo: providerErrorInfoSchema.optional()
  }),
  z16.object({
    type: z16.literal("provider/rateLimits/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    rateLimits: providerRateLimitStateSchema
  }),
  z16.object({
    type: z16.literal("provider.env-resolved"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    entries: z16.array(
      z16.object({
        name: z16.string(),
        source: z16.union([
          z16.literal("shell"),
          z16.object({ plugin: z16.string() }).strict(),
          z16.object({
            core: z16.enum([
              "machine-git",
              "machine-environment",
              "project-environment"
            ])
          }).strict()
        ]),
        value: z16.union([
          z16.string(),
          z16.object({ masked: z16.literal(true) }).strict()
        ]),
        reason: z16.string().optional()
      }).strict()
    )
  }),
  z16.object({
    type: z16.literal("thread/extensionState/updated"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    kind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z16.object({
    type: z16.literal("provider/warning"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    category: threadEventWarningCategorySchema,
    summary: z16.string().optional(),
    details: z16.string().optional()
  }),
  z16.object({
    type: z16.literal("provider/modelFallback"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    originalModel: z16.string().min(1),
    fallbackModel: z16.string().min(1),
    reason: z16.enum(["refusal", "provider"]),
    message: z16.string()
  }),
  z16.object({
    type: z16.literal("thread/execution/reported"),
    threadId: z16.string(),
    providerThreadId: z16.string(),
    execution: threadExecutionReportSchema
  }),
  providerUnhandledEventSchema
]);
var scopedEventDataSchema = z16.object({
  scope: threadEventScopeSchema
});
var providerEventSchema = unscopedProviderEventSchema.and(
  scopedEventDataSchema
);
var providerEventTypeValues = unscopedProviderEventSchema.options.map(
  (option) => option.shape.type.value
);
var unscopedSystemEventSchema = z16.discriminatedUnion("type", [
  z16.object({
    type: z16.literal("client/thread/start"),
    threadId: z16.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z16.object({
    type: z16.literal("client/turn/requested"),
    threadId: z16.string()
  }).merge(turnRequestEventDataSchema),
  z16.object({
    type: z16.literal("client/turn/rejected"),
    threadId: z16.string()
  }).merge(turnRequestRejectedEventDataSchema),
  z16.object({
    type: z16.literal("client/turn/start"),
    threadId: z16.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z16.object({
    type: z16.literal("system/error"),
    threadId: z16.string()
  }).merge(systemErrorEventDataSchema),
  z16.object({
    type: z16.literal("system/manager/user_message"),
    threadId: z16.string()
  }).merge(systemLegacyUserMessageEventDataSchema),
  z16.object({
    type: z16.literal("system/thread/interrupted"),
    threadId: z16.string()
  }).merge(systemThreadInterruptedEventDataSchema),
  z16.object({
    type: z16.literal("system/operation"),
    threadId: z16.string()
  }).merge(systemOperationEventDataSchema),
  z16.object({
    type: z16.literal("system/interaction/lifecycle"),
    threadId: z16.string()
  }).merge(systemInteractionLifecycleEventDataSchema),
  z16.object({
    type: z16.literal("system/permissionGrant/lifecycle"),
    threadId: z16.string()
  }).merge(systemPermissionGrantLifecycleEventDataSchema),
  z16.object({
    type: z16.literal("system/userQuestion/lifecycle"),
    threadId: z16.string()
  }).merge(systemUserQuestionLifecycleEventDataSchema),
  z16.object({
    type: z16.literal("system/thread-provisioning"),
    threadId: z16.string()
  }).merge(systemThreadProvisioningEventDataSchema),
  z16.object({
    type: z16.literal("system/provider-turn-watchdog"),
    threadId: z16.string()
  }).merge(systemProviderTurnWatchdogEventDataSchema)
]);
var systemEventSchema = unscopedSystemEventSchema.and(scopedEventDataSchema);
var threadEventSchema = z16.union([providerEventSchema, systemEventSchema]).superRefine((event, ctx) => {
  const result = validateThreadEventScope({
    type: event.type,
    scope: event.scope
  });
  if (!result.valid) {
    ctx.addIssue({
      code: z16.ZodIssueCode.custom,
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
var threadEventTypeSchema = z16.string().refine(
  (value) => threadEventTypeSet.has(value),
  "Invalid thread event type"
);

// ../domain/src/thread-provider-state.ts
import { z as z17 } from "zod";
var THREAD_PROVIDER_COMMANDS_STATE_KIND = "bb/provider-commands";
var THREAD_SESSION_OPTIONS_STATE_KIND = "bb/session-options";
var threadProviderCommandSchema = z17.object({
  name: z17.string().min(1),
  description: z17.string(),
  inputHint: z17.string().min(1).optional()
});
var threadProviderCommandsStateSchema = z17.object({
  commands: z17.array(threadProviderCommandSchema).max(500)
});
var threadSessionOptionValueSchema = z17.object({
  id: z17.string().min(1),
  label: z17.string().min(1),
  description: z17.string().min(1).optional(),
  group: z17.string().min(1).optional()
});
var threadSessionOptionBaseShape = {
  id: z17.string().min(1),
  label: z17.string().min(1),
  description: z17.string().min(1).optional(),
  category: z17.string().min(1).optional()
};
var threadSessionOptionSchema = z17.discriminatedUnion("type", [
  z17.object({
    ...threadSessionOptionBaseShape,
    type: z17.literal("select"),
    value: z17.string(),
    values: z17.array(threadSessionOptionValueSchema).max(1e3)
  }),
  z17.object({
    ...threadSessionOptionBaseShape,
    type: z17.literal("boolean"),
    value: z17.boolean(),
    fixed: z17.boolean().optional()
  })
]);
var threadSessionOptionsStateSchema = z17.object({
  options: z17.array(threadSessionOptionSchema).max(64)
});
var threadSessionOptionSelectionsStateSchema = z17.object({
  selections: sessionOptionSelectionsSchema
});
var CORE_THREAD_STATE_SCHEMAS = {
  [THREAD_PROVIDER_COMMANDS_STATE_KIND]: threadProviderCommandsStateSchema,
  [THREAD_SESSION_OPTIONS_STATE_KIND]: threadSessionOptionsStateSchema
};

// ../domain/src/provider-fork.ts
import { z as z18 } from "zod";
var PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"];
var providerForkSchema = z18.enum(PROVIDER_FORK_VALUES);

// ../domain/src/provider-types.ts
import { z as z19 } from "zod";
var modelReasoningEffortSchema = z19.object({
  reasoningEffort: reasoningLevelSchema,
  label: z19.string().min(1).optional(),
  description: z19.string()
});
var modelServiceTierSchema = z19.object({
  id: serviceTierSchema,
  label: z19.string().min(1).optional(),
  description: z19.string().min(1).optional()
});
var availableModelSchema = z19.object({
  id: z19.string(),
  model: z19.string(),
  displayName: z19.string(),
  routeProviderId: z19.string().min(1).optional(),
  description: z19.string(),
  supportedReasoningEfforts: z19.array(modelReasoningEffortSchema),
  defaultReasoningEffort: reasoningLevelSchema,
  supportedServiceTiers: z19.array(modelServiceTierSchema).optional(),
  sessionOptions: z19.array(threadSessionOptionSchema).max(64).optional(),
  isDefault: z19.boolean()
});
var providerModelCatalogScopeSchema = z19.enum(["host", "workspace"]);
var providerCapabilitiesSchema = z19.object({
  supportsThreadArchive: z19.boolean(),
  supportsThreadRename: z19.boolean(),
  supportsServiceTier: z19.boolean(),
  supportsNativeUserQuestion: z19.boolean(),
  supportsFork: z19.boolean(),
  supportsSessionRewind: z19.boolean(),
  permissionModes: z19.array(permissionModeSchema).min(1),
  modelCatalogScope: providerModelCatalogScopeSchema,
  reportsTokenUsage: z19.boolean().optional(),
  supportsNativeTerminal: z19.boolean().optional()
});
var providerComposerCommandSchema = z19.object({
  trigger: promptMentionCommandTriggerSchema,
  name: z19.string().min(1).regex(/^[^\s/$]+$/u),
  trailingText: z19.string().regex(/^\s*$/u)
});
var providerComposerActionSchema = z19.discriminatedUnion("kind", [
  z19.object({
    kind: z19.literal("skills"),
    trigger: promptMentionCommandTriggerSchema
  }),
  z19.object({
    kind: z19.literal("plan"),
    command: providerComposerCommandSchema
  }),
  z19.object({
    kind: z19.literal("goal"),
    command: providerComposerCommandSchema
  })
]);
var providerStringsSchema = z19.object({
  signInHint: z19.string().min(1),
  expiredHint: z19.string().min(1),
  installUrl: z19.string().min(1),
  brandPrefix: z19.string().min(1).optional(),
  planModeCopy: z19.string().min(1).optional(),
  iconTint: z19.object({ light: z19.string().min(1), dark: z19.string().min(1) }).optional()
});
var providerOptionDescriptorSchema = z19.object({
  id: z19.string().min(1),
  label: z19.string().min(1),
  description: z19.string().min(1).optional()
});
var providerExtensionKindInfoSchema = z19.object({
  item: z19.boolean(),
  state: z19.boolean()
});
var providerExtensionKindsSchema = z19.record(
  extensionKindSchema,
  providerExtensionKindInfoSchema
);
var providerInfoSchema = z19.object({
  id: z19.string(),
  pluginId: z19.string().min(1),
  displayName: z19.string(),
  family: z19.string().min(1).optional(),
  icon: z19.object({ glyph: z19.string().min(1) }).optional(),
  logoUrl: z19.string().min(1).nullable(),
  maintenance: z19.object({
    health: z19.boolean(),
    usage: z19.boolean(),
    installation: z19.boolean()
  }),
  capabilities: providerCapabilitiesSchema,
  composerActions: z19.array(providerComposerActionSchema),
  completedTurnDisplay: completedTurnDisplaySchema,
  available: z19.boolean(),
  strings: providerStringsSchema.optional(),
  serviceTiers: z19.array(providerOptionDescriptorSchema).optional(),
  reasoningLevels: z19.array(providerOptionDescriptorSchema).optional(),
  extensionKinds: providerExtensionKindsSchema.optional()
});
var providerRecoveryKindValues = [
  "sessionArchived",
  "authRequired",
  "restartRecommended",
  "staleTurn",
  "rateLimited"
];
var providerRecoveryKindSchema = z19.enum(providerRecoveryKindValues);
var toolCallOutputItemSchema = z19.discriminatedUnion("type", [
  z19.object({
    type: z19.literal("inputText"),
    text: z19.string()
  }),
  z19.object({
    type: z19.literal("inputImage"),
    imageUrl: z19.string()
  })
]);
var toolCallRequestSchema = z19.object({
  requestId: z19.union([z19.string().min(1), z19.number()]),
  threadId: z19.string().min(1),
  providerThreadId: z19.string().min(1),
  turnId: z19.string().min(1),
  callId: z19.string().min(1),
  tool: z19.string().min(1),
  arguments: z19.unknown().optional()
});
var toolCallResponseSchema = z19.object({
  contentItems: z19.array(toolCallOutputItemSchema),
  success: z19.boolean()
});
var dynamicToolSchema = z19.object({
  name: z19.string(),
  description: z19.string(),
  inputSchema: z19.unknown(),
  presentation: threadEventItemPresentationSchema.optional(),
  /** A tool awaiting a user-owned interaction may outlive turn completion. */
  waitsForUserInput: z19.boolean().optional()
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

// ../provider-bridge-acp/src/launch-spec.ts
import { z as z20 } from "zod";
var acpNativeSkillRootsSchema = z20.object({
  user: z20.array(providerNativeRootInputSchema).default([]),
  project: z20.array(providerNativeRootInputSchema).default([])
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
var acpLaunchSpecSchema = z20.object({
  displayName: z20.string().min(1),
  command: z20.string().min(1),
  args: z20.array(z20.string()),
  env: z20.record(z20.string().min(1), z20.string()),
  cwd: z20.string().min(1).optional(),
  modelCli: z20.object({
    listArgs: z20.array(z20.string()),
    selectFlag: z20.string().min(1).optional(),
    primaryModels: z20.array(z20.string())
  }).strict().transform(
    (modelCli) => modelCli.listArgs.length > 0 ? modelCli : void 0
  ).optional(),
  reasoningCli: acpReasoningCliSchema.optional(),
  nativeReasoning: acpNativeReasoningSchema.optional(),
  nativeSkillRoots: acpNativeSkillRootsSchema.optional(),
  permissionCli: acpPermissionCliSchema.optional()
}).strict();

// ../provider-bridge-protocol/src/version.ts
var PROVIDER_BRIDGE_PROTOCOL_VERSION = 2;
var THREAD_DELTA_GRAMMAR_V3 = 3;

// ../provider-bridge-protocol/src/handshake.ts
import { z as z21 } from "zod";
var bridgeGrammarVersionsSchema = z21.tuple([z21.number().int().positive(), z21.number().int().positive()]).refine(([min, max]) => min <= max, {
  message: "grammarVersions must be an ascending [min, max] range"
});
var bridgeSteerModeSchema = z21.enum(["inject", "queue"]);
var bridgeCapabilitiesSchema = z21.object({
  sessionRestore: z21.boolean().default(false),
  threadArchive: z21.boolean().default(false),
  threadRename: z21.boolean().default(false),
  threadGoalClear: z21.boolean().default(false),
  fork: providerForkSchema.default("none"),
  approvalEnforcedBy: z21.enum(["runtime", "provider"]).default("runtime"),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ]),
  steerMode: bridgeSteerModeSchema.default("queue"),
  skills: z21.object({ configure: z21.boolean().default(false) }).default({ configure: false })
}).passthrough();
var initializeParamsSchema = z21.object({
  protocolVersion: z21.number().int().positive(),
  client: z21.object({ name: z21.string().min(1), version: z21.string().min(1) }),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ])
}).passthrough();
var initializeResultSchema = z21.object({
  protocolVersion: z21.number().int().positive(),
  capabilities: z21.preprocess(
    (value) => value ?? {},
    bridgeCapabilitiesSchema
  )
}).passthrough();

// ../provider-bridge-protocol/src/execution-options.ts
import { z as z22 } from "zod";
var bridgeExecutionOptionsSchema = z22.object({
  model: z22.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  instructions: z22.string().optional(),
  envVars: z22.record(z22.string(), z22.string()).optional(),
  providerOptions: z22.record(z22.string(), z22.unknown()).optional()
}).and(runtimePermissionPolicySchema);

// ../provider-bridge-protocol/src/provider-maintenance.ts
import { z as z23 } from "zod";
var providerMaintenanceParamsSchema = z23.object({
  providerId: z23.string().min(1),
  cwd: z23.string().min(1).optional(),
  providerOptions: z23.record(z23.string(), z23.unknown()).optional()
}).passthrough();
var providerInstallationRequirementSchema = z23.enum(["thread_rewind"]);
var providerInstallationStatusParamsSchema = providerMaintenanceParamsSchema.extend({
  requirement: providerInstallationRequirementSchema.optional(),
  checkUpdates: z23.boolean().default(true)
});
var providerHealthSchema = z23.object({
  status: z23.enum([
    "ready",
    "not_installed",
    "unauthenticated",
    "expired",
    "unsupported_version",
    "unknown"
  ]),
  statusMessage: z23.string().min(1).nullable(),
  accountEmail: z23.string().nullable(),
  planLabel: z23.string().min(1).nullable(),
  installedVersion: z23.string().min(1).nullable(),
  minimumSupportedVersion: z23.string().min(1).nullable(),
  canInstall: z23.boolean(),
  canUpdate: z23.boolean(),
  loginCommand: z23.string().min(1).nullable(),
  localLoginCommand: z23.string().min(1).nullable().optional()
}).passthrough();
var providerUsageWindowSchema = z23.object({
  label: z23.string().min(1),
  usedPercent: z23.number().min(0).max(100),
  resetsAt: z23.string().min(1).nullable(),
  cost: z23.object({
    usedUsdCents: z23.number().int().nonnegative(),
    limitUsdCents: z23.number().int().positive()
  }).optional()
}).passthrough();
var providerUsageSchema = z23.discriminatedUnion("status", [
  z23.object({
    status: z23.literal("ok"),
    accountEmail: z23.string().email().nullable(),
    planLabel: z23.string().min(1).nullable(),
    windows: z23.array(providerUsageWindowSchema)
  }).passthrough(),
  z23.object({ status: z23.literal("not_installed") }).passthrough(),
  z23.object({ status: z23.literal("unauthenticated") }).passthrough(),
  z23.object({ status: z23.literal("expired") }).passthrough(),
  z23.object({
    status: z23.literal("error"),
    message: z23.string().min(1),
    planLabel: z23.string().min(1).nullable().default(null),
    accountEmail: z23.string().nullable().default(null)
  }).passthrough()
]);
var providerHealthResultSchema = z23.discriminatedUnion("supported", [
  z23.object({ supported: z23.literal(false) }).passthrough(),
  z23.object({
    supported: z23.literal(true),
    health: providerHealthSchema
  }).passthrough()
]);
var providerUsageResultSchema = z23.discriminatedUnion("supported", [
  z23.object({ supported: z23.literal(false) }).passthrough(),
  z23.object({
    supported: z23.literal(true),
    usage: providerUsageSchema
  }).passthrough()
]);
var providerInstallationActionKindSchema = z23.enum([
  "install",
  "update"
]);
var providerInstallationActionSchema = z23.object({
  kind: providerInstallationActionKindSchema,
  label: z23.enum(["Install", "Update"]),
  command: z23.string().min(1)
}).passthrough();
var providerInstallationSourceSchema = z23.enum([
  "notInstalled",
  "npmGlobal",
  "external"
]);
var providerInstallationStatusSchema = z23.object({
  executableName: z23.string().min(1),
  executablePath: z23.string().min(1).nullable(),
  installed: z23.boolean(),
  installSource: providerInstallationSourceSchema,
  currentVersion: z23.string().min(1).nullable(),
  latestVersion: z23.string().min(1).nullable(),
  minimumSupportedVersion: z23.string().min(1).nullable(),
  npmPackageName: z23.string().min(1).nullable(),
  npmGlobalPackageVersion: z23.string().min(1).nullable(),
  installAction: providerInstallationActionSchema.nullable(),
  needsUpdate: z23.boolean(),
  versionUnsupported: z23.boolean()
}).passthrough();
var providerInstallationRunParamsSchema = providerMaintenanceParamsSchema.extend({
  action: providerInstallationActionKindSchema
});
var providerInstallationCommandSchema = z23.object({
  command: z23.string().min(1),
  args: z23.array(z23.string()).max(64),
  displayCommand: z23.string().min(1)
}).passthrough();
var providerInstallationVerificationSchema = z23.discriminatedUnion(
  "kind",
  [
    z23.object({ kind: z23.literal("installed") }).passthrough(),
    z23.object({
      kind: z23.literal("version_changed"),
      previousVersion: z23.string().min(1)
    }).passthrough(),
    z23.object({
      kind: z23.literal("version_at_least"),
      version: z23.string().min(1)
    }).passthrough()
  ]
);
var providerInstallationRunResultSchema = z23.discriminatedUnion(
  "available",
  [
    z23.object({
      available: z23.literal(false),
      message: z23.string().min(1)
    }).passthrough(),
    z23.object({
      available: z23.literal(true),
      command: providerInstallationCommandSchema,
      verification: providerInstallationVerificationSchema
    }).passthrough()
  ]
);

// ../provider-bridge-protocol/src/requests.ts
import { z as z24 } from "zod";
var sessionConstructionFields = {
  threadId: z24.string().min(1),
  cwd: z24.string().min(1),
  options: bridgeExecutionOptionsSchema,
  dynamicTools: z24.array(dynamicToolSchema).optional(),
  disallowedTools: z24.array(z24.string().min(1)).optional(),
  instructionMode: instructionModeSchema
};
var modelListParamsSchema = z24.object({ cwd: z24.string().min(1).optional() }).passthrough();
var threadStartParamsSchema = z24.object({
  ...sessionConstructionFields,
  input: z24.array(promptInputSchema).optional()
}).passthrough();
var threadResumeParamsSchema = z24.object({
  ...sessionConstructionFields,
  providerThreadId: z24.string().min(1)
}).passthrough();
var threadForkParamsSchema = z24.object({
  ...sessionConstructionFields,
  sourceProviderThreadId: z24.string().min(1),
  sourceProviderCheckpointId: z24.string().min(1).optional()
}).passthrough();
var threadStopParamsSchema = z24.object({
  threadId: z24.string().min(1),
  providerThreadId: z24.string().min(1),
  intent: z24.enum(["interrupt", "release"]),
  activeTurnId: z24.string().min(1).nullable()
}).passthrough();
var threadRefParams = z24.object({
  threadId: z24.string().min(1),
  providerThreadId: z24.string().min(1)
}).passthrough();
var threadDiscardParamsSchema = threadRefParams;
var threadNameSetParamsSchema = z24.object({
  threadId: z24.string().min(1),
  providerThreadId: z24.string().min(1),
  title: z24.string().min(1)
}).passthrough();
var turnInputFields = {
  threadId: z24.string().min(1),
  providerThreadId: z24.string().min(1),
  input: z24.array(promptInputSchema),
  clientRequestId: clientTurnRequestIdSchema,
  options: bridgeExecutionOptionsSchema
};
var turnStartParamsSchema = z24.object(turnInputFields).passthrough();
var turnSteerParamsSchema = z24.object({
  ...turnInputFields,
  expectedTurnId: z24.string().min(1)
}).passthrough();
var skillsConfigureRootSchema = z24.object({
  id: z24.string().min(1),
  path: z24.string().min(1),
  skills: z24.array(
    z24.object({
      name: z24.string().min(1),
      description: z24.string()
    }).passthrough()
  )
}).passthrough();
var skillsConfigureParamsSchema = z24.object({
  roots: z24.array(skillsConfigureRootSchema)
}).passthrough();
var threadIdentityResultSchema = z24.object({
  providerThreadId: z24.string().min(1),
  sessionRestorable: z24.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
import { z as z26 } from "zod";

// ../provider-bridge-protocol/src/errors.ts
import { z as z25 } from "zod";
var BRIDGE_JSON_RPC_ERRORS = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  BRIDGE_ERROR: -32e3,
  NO_ACTIVE_TURN: -32001,
  SESSION_NOT_RESTORABLE: -32002,
  FORK_CHECKPOINT_UNSUPPORTED: -32003,
  MISSING_EXECUTABLE: -32004
};
var providerRecoveryHintSchema = z25.object({
  kind: providerRecoveryKindSchema,
  message: z25.string().min(1),
  retryable: z25.boolean()
});
var bridgeErrorDataSchema = z25.object({ recovery: providerRecoveryHintSchema.optional() }).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
var BRIDGE_NOTIFICATION_METHODS = {
  threadIdentity: "thread/identity",
  sessionReplaced: "session/replaced",
  providerRaw: "provider/raw",
  providerRecovery: "provider/recovery",
  error: "error"
};
var threadIdentityNotificationSchema = z26.object({
  threadId: z26.string().min(1),
  providerThreadId: z26.string().min(1),
  sessionRestorable: z26.boolean().optional()
}).passthrough();
var sessionReplacedNotificationSchema = z26.object({
  threadId: z26.string().min(1),
  providerThreadId: z26.string().min(1).nullable(),
  reason: z26.string().min(1),
  contextLost: z26.boolean().default(false),
  showRuntimeNote: z26.boolean().default(false)
}).passthrough();
var providerRecoveryNotificationSchema = z26.object({
  threadId: z26.string().min(1).optional(),
  ...providerRecoveryHintSchema.shape
}).passthrough();
var errorNotificationSchema = z26.object({
  threadId: z26.string().min(1).optional(),
  providerThreadId: z26.string().min(1).optional(),
  message: z26.string().min(1)
}).passthrough();

// ../provider-bridge-protocol/src/bridge-requests.ts
import { z as z27 } from "zod";
var BRIDGE_INBOUND_REQUEST_METHODS = {
  toolCall: "item/tool/call",
  interactionRequest: "interaction/request"
};
var toolCallRequestParamsSchema = z27.object({
  providerThreadId: z27.string().min(1),
  threadId: z27.string().min(1).optional(),
  turnId: z27.union([z27.string().min(1), z27.null()]),
  callId: z27.string().min(1),
  tool: z27.string().min(1),
  arguments: z27.unknown(),
  providerNativeIds: z27.boolean().optional()
}).passthrough();
var toolCallResultSchema = z27.object({
  success: z27.boolean(),
  contentItems: z27.array(
    z27.discriminatedUnion("type", [
      z27.object({ type: z27.literal("inputText"), text: z27.string() }),
      z27.object({
        type: z27.literal("inputImage"),
        imageUrl: z27.string().min(1)
      })
    ])
  )
}).passthrough();
var interactionRequestParamsSchema = z27.object({
  providerThreadId: z27.string().min(1),
  threadId: z27.string().min(1).optional(),
  turnId: z27.union([z27.string().min(1), z27.null()]),
  payload: pendingInteractionPayloadSchema,
  providerNativeIds: z27.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/thread-delta.ts
import { z as z28 } from "zod";
var THREAD_DELTA_NOTIFICATION_METHOD = "thread/delta";
var deltaPresentationSchema = threadEventItemPresentationSchema;
var THREAD_DELTA_KEY_SEPARATOR = "";
var deltaKeyPartSchema = z28.string().min(1).refine((value) => !value.includes(THREAD_DELTA_KEY_SEPARATOR), {
  message: "provider keys must not contain the internal key separator (\\u001f)"
});
var deltaItemKeySchema = z28.object({
  providerItemId: deltaKeyPartSchema.optional(),
  channel: deltaKeyPartSchema.optional(),
  parentRef: deltaKeyPartSchema.optional()
});
var providerTurnIdSchema = deltaKeyPartSchema;
var deltaFileChangeSchema = z28.object({
  path: z28.string(),
  kind: z28.enum(["add", "update", "delete"]),
  movePath: z28.string().optional(),
  diff: z28.string().optional(),
  oldText: z28.string().optional(),
  newText: z28.string().optional()
});
var deltaBackgroundTaskShapeSchema = z28.object({
  type: z28.literal("backgroundTask"),
  familyId: z28.string().min(1),
  taskType: z28.string(),
  description: z28.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z28.boolean(),
  workflowName: z28.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z28.string().optional(),
  error: z28.string().optional(),
  outputFile: z28.string().optional()
});
var deltaFileReadShapeSchema = z28.object({
  type: z28.literal("fileRead"),
  path: z28.string(),
  cmd: z28.string().optional()
});
var deltaSearchShapeSchema = z28.object({
  type: z28.literal("search"),
  mode: threadEventSearchModeSchema,
  query: z28.string(),
  path: z28.string().optional(),
  cmd: z28.string().optional()
});
var deltaDelegationShapeSchema = z28.object({
  type: z28.literal("delegation"),
  childRef: deltaKeyPartSchema,
  label: z28.string(),
  background: z28.boolean(),
  summary: z28.string().optional()
});
var deltaPlanStepsShapeSchema = z28.object({
  type: z28.literal("planSteps"),
  steps: z28.array(threadEventPlanStepSchema),
  explanation: z28.string().optional()
});
var deltaExtensionShapeSchema = z28.object({
  type: z28.literal("extension"),
  kind: extensionKindSchema,
  payload: jsonValueSchema
});
var deltaItemShapeSchema = z28.discriminatedUnion("type", [
  z28.object({
    type: z28.literal("command"),
    command: z28.string(),
    cwd: z28.string(),
    aggregatedOutput: z28.string().optional(),
    exitCode: z28.number().optional(),
    durationMs: z28.number().optional()
  }),
  z28.object({
    type: z28.literal("fileChange"),
    changes: z28.array(deltaFileChangeSchema)
  }),
  z28.object({
    type: z28.literal("tool"),
    tool: z28.string(),
    server: z28.string().optional(),
    args: z28.unknown().optional(),
    result: z28.unknown().optional(),
    error: z28.string().optional(),
    durationMs: z28.number().optional()
  }),
  z28.object({ type: z28.literal("compaction") }),
  z28.object({ type: z28.literal("agentMessage"), text: z28.string() }),
  z28.object({
    type: z28.literal("reasoning"),
    summary: z28.array(z28.string()),
    content: z28.array(z28.string())
  }),
  z28.object({ type: z28.literal("plan"), text: z28.string() }),
  z28.object({
    type: z28.literal("webSearch"),
    queries: z28.array(z28.string()).min(1)
  }),
  z28.object({
    type: z28.literal("webFetch"),
    url: z28.string(),
    prompt: z28.string().nullable().optional(),
    pattern: z28.string().nullable()
  }),
  z28.object({ type: z28.literal("imageView"), path: z28.string() }),
  z28.object({
    type: z28.literal("imageGeneration"),
    prompt: z28.string().nullable(),
    path: z28.string().nullable(),
    result: z28.string().optional(),
    error: z28.string().nullable(),
    transparentBackground: z28.boolean()
  }),
  deltaBackgroundTaskShapeSchema,
  deltaFileReadShapeSchema,
  deltaSearchShapeSchema,
  deltaDelegationShapeSchema,
  deltaPlanStepsShapeSchema,
  deltaExtensionShapeSchema
]);
var deltaProgressSnapshotSchema = z28.discriminatedUnion("type", [
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema
]);
var deltaTextChannelSchema = z28.enum([
  "agentMessage",
  "reasoningSummary",
  "reasoningText",
  "plan"
]);
var deltaOutputChannelSchema = z28.enum(["command", "fileChange"]);
var deltaErrorSchema = z28.object({ message: z28.string() });
var deltaAttachSchema = z28.enum(["open", "currentOrLast"]);
var deltaNoTurnFallbackSchema = z28.object({
  raw: providerRawEventSchema,
  rawType: z28.string()
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
var threadDeltaSchema = z28.discriminatedUnion("kind", [
  z28.object({
    kind: z28.literal("input.accepted"),
    clientRequestId: clientTurnRequestIdSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z28.object({
    kind: z28.literal("input.provider"),
    text: z28.string().min(1),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z28.object({
    kind: z28.literal("turn.open"),
    providerTurnId: providerTurnIdSchema.optional(),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z28.object({
    kind: z28.literal("turn.boundary"),
    status: threadEventTurnStatusSchema,
    error: deltaErrorSchema.optional(),
    providerCheckpointId: z28.string().min(1).optional(),
    claimIfIdle: z28.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z28.object({
    kind: z28.literal("item.open"),
    key: deltaItemKeySchema,
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    attach: deltaAttachSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z28.object({
    kind: z28.literal("item.close"),
    key: deltaItemKeySchema,
    status: threadEventItemStatusSchema,
    resultText: z28.string().optional(),
    exitCode: z28.number().optional(),
    aggregatedOutput: z28.string().optional(),
    approvalStatus: z28.literal("denied").optional(),
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z28.object({
    kind: z28.literal("item.progress"),
    key: deltaItemKeySchema,
    message: z28.string().optional(),
    snapshot: deltaProgressSnapshotSchema.optional(),
    flush: z28.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z28.object({
    kind: z28.literal("item.textDelta"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z28.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z28.object({
    kind: z28.literal("item.textClose"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z28.string().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z28.object({
    kind: z28.literal("item.outputDelta"),
    key: deltaItemKeySchema,
    channel: deltaOutputChannelSchema,
    text: z28.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z28.object({
    kind: z28.literal("command.outputSnapshot"),
    key: deltaItemKeySchema,
    text: z28.string(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z28.object({
    kind: z28.literal("usage"),
    total: threadEventTokenUsageBreakdownSchema,
    last: threadEventTokenUsageBreakdownSchema,
    modelContextWindow: z28.number().nullable(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z28.object({
    kind: z28.literal("contextWindow"),
    snapshot: contextSnapshotSchema.optional(),
    used: z28.number().nullable(),
    size: z28.number().nullable().optional(),
    estimated: z28.boolean(),
    cost: threadUsageCostSchema.optional(),
    attach: deltaAttachSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z28.object({
    kind: z28.literal("context.compacted"),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z28.object({ kind: z28.literal("context.cleared") }),
  z28.object({
    kind: z28.literal("turn.diff"),
    diff: z28.string(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z28.object({ kind: z28.literal("thread.started") }),
  z28.object({
    kind: z28.literal("thread.identity"),
    providerThreadId: z28.string().min(1)
  }),
  z28.object({
    kind: z28.literal("thread.name"),
    name: z28.string().min(1),
    source: z28.literal("agent").optional()
  }),
  z28.object({
    kind: z28.literal("extension.state"),
    extensionKind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z28.object({
    kind: z28.literal("provider.rateLimits"),
    rateLimits: providerRateLimitStateSchema
  }),
  z28.object({
    kind: z28.literal("provider.error"),
    message: z28.string(),
    detail: z28.string().optional(),
    willRetry: z28.boolean().optional(),
    category: providerErrorCategorySchema.optional(),
    errorInfo: providerErrorInfoSchema.optional(),
    settlesTurn: z28.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    threadScoped: z28.boolean().optional()
  }),
  z28.object({
    kind: z28.literal("provider.modelFallback"),
    originalModel: z28.string().min(1),
    fallbackModel: z28.string().min(1),
    reason: z28.enum(["refusal", "provider"]),
    message: z28.string()
  }),
  z28.object({
    kind: z28.literal("thread.execution"),
    execution: threadExecutionReportSchema
  }),
  z28.object({
    kind: z28.literal("provider.warning"),
    summary: z28.string().optional(),
    details: z28.string().optional(),
    category: threadEventWarningCategorySchema.optional(),
    vouchedTurn: z28.boolean().optional()
  }),
  z28.object({
    kind: z28.literal("unhandled"),
    raw: providerRawEventSchema,
    rawType: z28.string(),
    vouchedTurn: z28.boolean(),
    onlyIfNoTurn: z28.boolean().optional(),
    parentRef: deltaKeyPartSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z28.object({ kind: z28.literal("session.ended") }),
  z28.object({ kind: z28.literal("session.reset") })
]);
var threadDeltaNotificationParamsSchema = z28.object({
  threadId: z28.string().min(1),
  deltas: z28.array(threadDeltaSchema)
}).passthrough();

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
import { z as z30 } from "zod";

// ../provider-bridge-protocol/src/bridge-kit/tool-arg-schemas.ts
import { z as z29 } from "zod";
var bashArgsSchema = z29.object({
  command: z29.string().optional(),
  cwd: z29.string().optional()
}).passthrough();
var textBlockSchema = z29.object({
  type: z29.literal("text"),
  text: z29.string()
});

// ../provider-bridge-protocol/src/bridge-kit/provider-visibility-helpers.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function getStringProperty(value, key) {
  const next = value[key];
  return typeof next === "string" ? next : void 0;
}

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
var contentWrapperSchema = z30.object({
  content: z30.array(z30.unknown())
}).passthrough();
var shellEnvironmentVariableKeySchema = z30.string().regex(/^[A-Z_][A-Z0-9_]*$/i);
function toOptionalString(value) {
  return typeof value === "string" ? value : void 0;
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
  const path13 = getStringProperty(block, "path");
  const toolName = getStringProperty(block, "tool_name");
  const url = getStringProperty(block, "url") ?? getStringProperty(block, "imageUrl");
  if (path13) {
    return `[${type}: ${path13}]`;
  }
  if (toolName) {
    return `[${type}: ${toolName}]`;
  }
  if (url) {
    return `[${type}: ${url}]`;
  }
  return `[${type}]`;
}

// ../provider-bridge-protocol/src/bridge-kit/bounded-line-reader.ts
var MAX_JSON_RPC_LINE_BYTES = 64 * 1024 * 1024;

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
  const send2 = (message) => {
    write(`${JSON.stringify(message)}
`);
  };
  return {
    send: send2,
    sendError: (id, code, message, data) => {
      send2({
        jsonrpc: "2.0",
        id,
        error: { code, message, ...data === void 0 ? {} : { data } }
      });
    },
    sendResult: (id, result) => {
      send2({ jsonrpc: "2.0", id, result });
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
import { StringDecoder } from "node:string_decoder";
var PROVIDER_BRIDGE_RECORD_DIR_ENV = "BB_PROVIDER_BRIDGE_RECORD_DIR";
var BRIDGE_RECORDING_PROCESS_SCOPE = "_process";
function bridgeRecordingFileName(direction) {
  return `${direction}.ndjson`;
}
function createRecordingLineSplitter(onLine, maxLineBytes = MAX_JSON_RPC_LINE_BYTES) {
  const decoder = new StringDecoder("utf8");
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
import { z as z31 } from "zod";
var bridgeRequestEnvelopeSchema = z31.object({
  jsonrpc: z31.literal("2.0"),
  id: z31.union([z31.string(), z31.number()]),
  method: z31.string(),
  params: z31.record(z31.string(), z31.unknown()).optional()
});
var jsonRpcErrorSchema = z31.object({
  code: z31.number(),
  message: z31.string().optional(),
  data: z31.unknown().optional()
});
var jsonRpcSuccessResponseSchema = z31.object({
  jsonrpc: z31.literal("2.0"),
  id: z31.union([z31.string(), z31.number()]),
  result: z31.unknown()
});
var jsonRpcErrorResponseSchema = z31.object({
  jsonrpc: z31.literal("2.0"),
  id: z31.union([z31.string(), z31.number()]),
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
import { z as z32 } from "zod";
var recordSchema = z32.record(z32.string(), z32.unknown());
var jsonRpcEnvelopeSchema = z32.object({
  jsonrpc: z32.literal("2.0"),
  method: z32.string(),
  params: recordSchema.optional()
}).passthrough();
var sdkMessageEnvelopeSchema = z32.object({
  jsonrpc: z32.literal("2.0"),
  method: z32.literal("sdk/message"),
  params: z32.object({
    message: z32.unknown(),
    threadId: z32.string().optional(),
    parent_tool_use_id: z32.string().optional()
  }).passthrough()
}).passthrough();
var threadIdentityEnvelopeSchema = z32.object({
  jsonrpc: z32.literal("2.0"),
  method: z32.literal("thread/identity"),
  params: z32.object({
    threadId: z32.string().optional(),
    providerThreadId: z32.string().optional()
  }).passthrough()
}).passthrough();
var threadContextWindowUsageEnvelopeSchema = z32.object({
  jsonrpc: z32.literal("2.0"),
  method: z32.literal("thread/contextWindowUsage/updated"),
  params: z32.object({
    threadId: z32.string().optional(),
    contextWindowUsage: z32.object({
      usedTokens: z32.number().nullable(),
      modelContextWindow: z32.number().nullable(),
      estimated: z32.boolean()
    })
  }).passthrough()
}).passthrough();
var errorEnvelopeSchema = z32.object({
  jsonrpc: z32.literal("2.0"),
  method: z32.literal("error"),
  params: z32.object({
    message: z32.string().optional()
  }).passthrough().optional()
}).passthrough();

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
  const firstLine = text.trim().split("\n", 1)[0]?.trim() ?? "";
  if (firstLine.length === 0) {
    return void 0;
  }
  return firstLine.length > PRESENTATION_TITLE_MAX_LENGTH ? `${sliceUtf16Head(firstLine, PRESENTATION_TITLE_MAX_LENGTH - 1)}\u2026` : firstLine;
}
function withTitle(presentation, title) {
  return title === void 0 ? presentation : { ...presentation, title };
}
function presentationFileName(path13) {
  const segments = path13.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? path13;
}
var COMPACTION_PRESENTATION = {
  label: { pending: "Compacting context", completed: "Compacted context" },
  icon: { glyph: "Archive" }
};
var REASONING_PRESENTATION = {
  label: { pending: "Thinking", completed: "Thought" },
  icon: { glyph: "Brain" }
};
function fileReadPresentation(path13) {
  return withTitle(
    {
      label: { pending: "Reading file", completed: "Read file" },
      icon: { glyph: "FileText" }
    },
    presentationTitle(presentationFileName(path13))
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
function assertPortablePipedProcess(child) {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach piped stdio");
  }
}
function spawnPortablePipedProcess(request) {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["pipe", "pipe", "pipe"]
  });
  assertPortablePipedProcess(child);
  return child;
}

// ../process-utils/src/windows-process-tree.ts
import { execFile } from "node:child_process";
import path from "node:path";
function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}
function terminateWindowsProcessTrees(pids) {
  if (pids.length === 0) return Promise.resolve(true);
  return new Promise((resolve5) => {
    let timer;
    let killer;
    let settled = false;
    const finish = (terminated) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve5(terminated);
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
  return new Promise((resolve5, reject) => {
    const onExit2 = () => {
      clearTimeout(timer);
      resolve5();
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
function spawnManagedProcess(request) {
  const child = spawnPortablePipedProcess({
    ...request,
    detached: supportsProcessGroups()
  });
  return { child, stop: createProcessStop(child) };
}
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
function isClosedProcessStdinError(error) {
  return "code" in error && (error.code === "EPIPE" || error.code === "EOF" || error.code === "ERR_STREAM_DESTROYED");
}

// ../../node_modules/.pnpm/is-plain-obj@4.1.0/node_modules/is-plain-obj/index.js
function isPlainObject(value) {
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
  const [commandArguments, options] = isPlainObject(rawArguments) ? [[], rawArguments] : [rawArguments, rawOptions];
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
  if (!isPlainObject(options)) {
    throw new TypeError(`Last argument must be an options object: ${options}`);
  }
  return [filePath, normalizedArguments, options];
};

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/methods/template.js
import { ChildProcess } from "node:child_process";

// ../../node_modules/.pnpm/execa@9.6.1/node_modules/execa/lib/utils/uint-array.js
import { StringDecoder as StringDecoder2 } from "node:string_decoder";
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
  const decoder = new StringDecoder2(encoding);
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
  if (isPlainObject(expression) && ("stdout" in expression || "isMaxBuffer" in expression)) {
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
var normalizeFdSpecificValue = (optionValue, optionArray, optionName) => isPlainObject(optionValue) ? normalizeOptionObject(optionValue, optionArray, optionName) : optionArray.fill(optionValue);
var normalizeOptionObject = (optionValue, optionArray, optionName) => {
  for (const fdName of Object.keys(optionValue).sort(compareFdName)) {
    for (const fdNumber of parseFdName(fdName, optionName, optionArray)) {
      optionArray[fdNumber] = optionValue[fdName];
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
var addDefaultValue = (optionArray, optionName) => optionArray.map((optionValue) => optionValue === void 0 ? DEFAULT_OPTIONS[optionName] : optionValue);
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
  const promise = new Promise((resolve5, reject) => {
    Object.assign(methods, { resolve: resolve5, reject });
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
  const { optionName, optionValue } = getInvalidStdioOption(fdNumber, options);
  return `The "${optionName}: ${serializeOptionValue(optionValue)}" option is incompatible with using "${getOptionName(isWritable)}: ${serializeOptionValue(fdName)}".
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
  const errorCode2 = originalError?.code;
  const prefix = getErrorPrefix({
    originalError,
    timedOut,
    timeout,
    isMaxBuffer,
    maxBuffer,
    errorCode: errorCode2,
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
  errorCode: errorCode2,
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
  if (errorCode2 !== void 0) {
    return `Command failed with ${errorCode2}${forcefulSuffix}`;
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
var isTransformOptions = (value) => isPlainObject(value) && (value.transform !== void 0 || value.final !== void 0);
var isUrl = (value) => Object.prototype.toString.call(value) === "[object URL]";
var isRegularUrl = (value) => isUrl(value) && value.protocol !== "file:";
var isFilePathObject = (value) => isPlainObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => FILE_PATH_KEYS.has(key)) && isFilePathString(value.file);
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
  const { transform, objectMode } = isPlainObject(value) ? value : { transform: value };
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
  } = isPlainObject(value) ? value : { transform: value };
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
import { StringDecoder as StringDecoder3 } from "node:string_decoder";
var getEncodingTransformGenerator = (binary, encoding, skipped) => {
  if (skipped) {
    return;
  }
  if (binary) {
    return { transform: encodingUint8ArrayGenerator.bind(void 0, new TextEncoder()) };
  }
  const stringDecoder = new StringDecoder3(encoding);
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
  for (const { path: path13, append } of stdioItems.filter(({ type }) => FILE_TYPES.has(type))) {
    const pathString = typeof path13 === "string" ? path13 : path13.toString();
    if (append || outputFiles.has(pathString)) {
      appendFileSync(path13, serializedResult);
    } else {
      outputFiles.add(pathString);
      writeFileSync(path13, serializedResult);
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
  if (isPlainObject(pipeArguments[0])) {
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
  const resolve5 = promise.resolve.bind(promise);
  return { resolve: resolve5, promises };
};
var waitForConcurrentStreams = async ({ resolve: resolve5, promises }, subprocess) => {
  resolve5();
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
    Object.entries(options).map(([optionName, optionValue]) => [
      optionName,
      mergeOption(optionName, boundOptions[optionName], optionValue)
    ])
  );
  return { ...boundOptions, ...newOptions };
};
var mergeOption = (optionName, boundOptionValue, optionValue) => {
  if (DEEP_OPTIONS.has(optionName) && isPlainObject(boundOptionValue) && isPlainObject(optionValue)) {
    return { ...boundOptionValue, ...optionValue };
  }
  return optionValue;
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
  if (isPlainObject(firstArgument)) {
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

// ../process-utils/src/paths.ts
import { isAbsolute, relative, resolve as resolve2, sep } from "node:path";
function isPathWithinDirectory(directoryPath, candidatePath) {
  const relativePath = relative(directoryPath, candidatePath);
  return relativePath === "" || relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
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
import { z as z33 } from "zod";
var execFileAsync2 = promisify4(execFile3);
var CLI_PROBE_TIMEOUT_MS = 5e3;
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
import { z as z34 } from "zod";
var providerToolCallCancellationSchema = z34.object({
  requestId: z34.union([z34.string(), z34.number().int()])
});
var PROVIDER_TOOL_CALL_CANCELLED_METHOD = "notifications/cancelled";

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
import { z as z35 } from "zod";
var ignoredJsonRpcResultSchema = z35.unknown();

// ../provider-bridge-acp/src/bridge/bridge.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { promises as fs4, readFileSync as readFileSync3 } from "node:fs";
import { createServer } from "node:net";
import { dirname as dirname2, isAbsolute as isAbsolute2, basename as basename3, relative as relative2, resolve as resolve4 } from "node:path";
import { fileURLToPath as fileURLToPath3 } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z as z44 } from "zod";

// ../provider-bridge-acp/src/bridge-protocol.ts
import { z as z37 } from "zod";

// ../provider-bridge-acp/src/wire.ts
import { z as z36 } from "zod";
var acpTextContentBlockSchema = z36.object({
  type: z36.literal("text"),
  text: z36.string()
}).passthrough();
var acpOtherContentBlockSchema = z36.object({
  type: z36.string()
}).passthrough();
var acpContentBlockSchema = z36.union([
  acpTextContentBlockSchema,
  acpOtherContentBlockSchema
]);
function extractAcpContentText(content) {
  if (!content) {
    return void 0;
  }
  const parsed = acpTextContentBlockSchema.safeParse(content);
  return parsed.success ? parsed.data.text : void 0;
}
var ACP_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other"
];
var acpToolKindSchema = z36.enum(ACP_TOOL_KINDS);
var ACP_TOOL_KIND_SET = new Set(ACP_TOOL_KINDS);
var ACP_TOOL_CALL_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled"
];
var acpToolCallStatusSchema = z36.enum(ACP_TOOL_CALL_STATUSES);
var ACP_TOOL_CALL_STATUS_SET = new Set(
  ACP_TOOL_CALL_STATUSES
);
var acpToolCallContentSchema = z36.union([
  z36.object({
    type: z36.literal("content"),
    content: acpContentBlockSchema
  }).passthrough(),
  z36.object({
    type: z36.literal("diff"),
    path: z36.string(),
    oldText: z36.string().nullable().optional(),
    newText: z36.string()
  }).passthrough(),
  z36.object({
    type: z36.literal("terminal"),
    terminalId: z36.string()
  }).passthrough()
]);
var acpToolCallContentListSchema = z36.array(z36.unknown()).transform(
  (entries) => entries.flatMap((entry) => {
    const parsed = acpToolCallContentSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  })
);
var acpToolCallLocationSchema = z36.object({
  path: z36.string(),
  line: z36.number().optional().nullable()
}).passthrough();
var acpToolCallNameSchema = z36.union([z36.string(), z36.null()]).transform((value) => value ?? void 0).optional();
var acpToolCallFieldsSchema = z36.object({
  toolCallId: z36.string(),
  title: z36.string().optional(),
  name: acpToolCallNameSchema,
  kind: acpToolKindSchema.optional(),
  rawKind: z36.string().optional(),
  status: acpToolCallStatusSchema.optional(),
  content: acpToolCallContentListSchema.optional(),
  locations: z36.array(acpToolCallLocationSchema).optional(),
  rawInput: z36.unknown().optional(),
  rawOutput: z36.unknown().optional()
});
function openAcpToolCallEnums(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const fields = value;
  const { kind, status, ...rest } = fields;
  const next = rest;
  if (typeof kind === "string") {
    if (ACP_TOOL_KIND_SET.has(kind)) {
      next["kind"] = kind;
    } else {
      next["kind"] = "other";
      next["rawKind"] = kind;
    }
  } else if (kind !== void 0 && kind !== null) {
    next["kind"] = kind;
  }
  if (typeof status === "string") {
    next["status"] = ACP_TOOL_CALL_STATUS_SET.has(status) ? status : "pending";
  } else if (status !== void 0 && status !== null) {
    next["status"] = status;
  }
  return next;
}
var acpAgentMessageChunkUpdateSchema = z36.object({
  sessionUpdate: z36.literal("agent_message_chunk"),
  content: acpContentBlockSchema
}).passthrough();
var acpAgentThoughtChunkUpdateSchema = z36.object({
  sessionUpdate: z36.literal("agent_thought_chunk"),
  content: acpContentBlockSchema
}).passthrough();
var acpToolCallUpdateEventSchema = z36.preprocess(
  openAcpToolCallEnums,
  acpToolCallFieldsSchema.extend({
    sessionUpdate: z36.enum(["tool_call", "tool_call_update"])
  }).passthrough()
);
var acpPlanEntryStatusSchema = z36.enum([
  "pending",
  "in_progress",
  "completed"
]);
var acpPlanUpdateSchema = z36.object({
  sessionUpdate: z36.literal("plan"),
  entries: z36.array(
    z36.object({
      content: z36.string(),
      status: acpPlanEntryStatusSchema.optional()
    }).passthrough()
  )
}).passthrough();
var acpUsageUpdateSchema = z36.object({
  sessionUpdate: z36.literal("usage_update"),
  used: z36.number().int().nonnegative(),
  size: z36.number().int().nonnegative()
}).passthrough();
var acpOtherSessionUpdateSchema = z36.object({
  sessionUpdate: z36.string()
}).passthrough();
var acpSessionUpdateSchema = z36.union([
  acpAgentMessageChunkUpdateSchema,
  acpAgentThoughtChunkUpdateSchema,
  acpToolCallUpdateEventSchema,
  acpPlanUpdateSchema,
  acpUsageUpdateSchema,
  acpOtherSessionUpdateSchema
]);
var acpSessionNotificationParamsSchema = z36.object({
  sessionId: z36.string(),
  update: acpSessionUpdateSchema
}).passthrough();
var ACP_PROTOCOL_VERSION = 1;
var acpInitializeResultSchema = z36.object({
  protocolVersion: z36.number(),
  agentCapabilities: z36.object({
    loadSession: z36.boolean().optional(),
    sessionCapabilities: z36.object({
      fork: z36.object({}).passthrough().nullable().optional()
    }).passthrough().optional(),
    promptCapabilities: z36.object({
      image: z36.boolean().optional()
    }).passthrough().optional()
  }).passthrough().optional(),
  authMethods: z36.array(z36.object({ id: z36.string() }).passthrough()).optional()
}).passthrough();
var acpOptionalString = z36.union([z36.string(), z36.null()]).transform((value) => value ?? void 0).optional();
var acpConfigOptionSelectOptionSchema = z36.object({
  value: z36.string(),
  name: acpOptionalString
}).passthrough();
var acpConfigOptionSchema = z36.object({
  id: z36.string(),
  name: acpOptionalString,
  category: acpOptionalString,
  type: z36.string(),
  currentValue: acpOptionalString,
  options: z36.array(acpConfigOptionSelectOptionSchema).optional()
}).passthrough();
var acpSessionModelSchema = z36.object({
  modelId: z36.string(),
  name: acpOptionalString,
  description: acpOptionalString
}).passthrough();
var acpSessionModelsSchema = z36.object({
  currentModelId: acpOptionalString,
  availableModels: z36.array(acpSessionModelSchema).optional()
}).passthrough();
var acpLooseConfigOptionSchema = z36.object({
  id: z36.string().optional(),
  name: z36.unknown().optional(),
  category: acpOptionalString,
  type: z36.unknown().optional(),
  currentValue: z36.unknown().optional(),
  options: z36.unknown().optional()
}).passthrough();
var acpConfigOptionSelectGroupSchema = z36.object({
  group: z36.string(),
  options: z36.array(z36.unknown())
}).passthrough();
function flattenAcpConfigOptionGroups(option) {
  if (typeof option !== "object" || option === null) {
    return option;
  }
  const { options } = option;
  if (!Array.isArray(options)) {
    return option;
  }
  return {
    ...option,
    options: options.flatMap((entry) => {
      const group = acpConfigOptionSelectGroupSchema.safeParse(entry);
      return group.success ? group.data.options : [entry];
    })
  };
}
function parseAcpConfigOptions(options, ctx) {
  if (options == null) {
    return void 0;
  }
  const parsedOptions = [];
  for (const rawOption of options) {
    const option = flattenAcpConfigOptionGroups(rawOption);
    const loose = acpLooseConfigOptionSchema.safeParse(option);
    if (!loose.success) {
      continue;
    }
    const isModelOption = loose.data.category === "model" || loose.data.id === "model";
    if (isModelOption) {
      const strict = acpConfigOptionSchema.safeParse(option);
      if (strict.success) {
        parsedOptions.push(strict.data);
        continue;
      }
      ctx.addIssue({
        code: "custom",
        message: `Invalid ACP model config option: ${strict.error.message}`
      });
      continue;
    }
    if (loose.data.id === void 0) {
      continue;
    }
    parsedOptions.push({
      id: loose.data.id,
      ...typeof loose.data.name === "string" ? { name: loose.data.name } : {},
      ...loose.data.category !== void 0 ? { category: loose.data.category } : {},
      type: typeof loose.data.type === "string" ? loose.data.type : "",
      ...typeof loose.data.currentValue === "string" ? { currentValue: loose.data.currentValue } : {},
      ...Array.isArray(loose.data.options) ? {
        options: loose.data.options.flatMap((selectOption) => {
          const parsed = acpConfigOptionSelectOptionSchema.safeParse(selectOption);
          return parsed.success ? [parsed.data] : [];
        })
      } : {}
    });
  }
  return parsedOptions;
}
var acpSessionNewResultSchema = z36.object({
  sessionId: z36.string(),
  models: acpSessionModelsSchema.optional(),
  configOptions: z36.array(z36.unknown()).nullable().optional().transform((options, ctx) => parseAcpConfigOptions(options, ctx))
}).passthrough();
var acpConfigStateResultSchema = z36.object({
  models: acpSessionModelsSchema.optional(),
  configOptions: z36.array(z36.unknown()).nullable().optional().transform((options, ctx) => parseAcpConfigOptions(options, ctx))
}).passthrough();
var acpSessionForkResultSchema = acpConfigStateResultSchema.extend({
  sessionId: z36.string()
});
var acpStopReasonSchema = z36.enum([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled"
]);
var acpPromptResultSchema = z36.object({
  stopReason: acpStopReasonSchema
}).passthrough();
var acpPermissionOptionKindSchema = z36.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always"
]);
var acpPermissionOptionSchema = z36.object({
  optionId: z36.string(),
  name: z36.string(),
  kind: acpPermissionOptionKindSchema
}).passthrough();
var acpRequestPermissionParamsSchema = z36.object({
  sessionId: z36.string(),
  toolCall: z36.preprocess(
    openAcpToolCallEnums,
    acpToolCallFieldsSchema.partial().passthrough()
  ).optional(),
  options: z36.array(acpPermissionOptionSchema).min(1)
}).passthrough();
var acpReadTextFileParamsSchema = z36.object({
  sessionId: z36.string(),
  path: z36.string(),
  line: z36.number().nullable().optional(),
  limit: z36.number().nullable().optional()
}).passthrough();
var acpWriteTextFileParamsSchema = z36.object({
  sessionId: z36.string(),
  path: z36.string(),
  content: z36.string()
}).passthrough();

// ../provider-bridge-acp/src/bridge-protocol.ts
var ACP_DEFAULT_MODEL_ID = "acp-default";
var acpModelListParamsSchema = modelListParamsSchema.extend({
  providerOptions: z37.record(z37.string(), z37.unknown()).optional()
});
var acpBridgeCommandSchema = z37.discriminatedUnion("method", [
  z37.object({
    method: z37.literal("initialize"),
    params: initializeParamsSchema
  }),
  z37.object({
    method: z37.literal("model/list"),
    params: acpModelListParamsSchema
  }),
  z37.object({
    method: z37.literal("provider/health"),
    params: providerMaintenanceParamsSchema
  }),
  z37.object({
    method: z37.literal("provider/usage"),
    params: providerMaintenanceParamsSchema
  }),
  z37.object({
    method: z37.literal("provider/installation/status"),
    params: providerInstallationStatusParamsSchema
  }),
  z37.object({
    method: z37.literal("provider/installation/run"),
    params: providerInstallationRunParamsSchema
  }),
  z37.object({
    method: z37.literal("thread/start"),
    params: threadStartParamsSchema
  }),
  z37.object({
    method: z37.literal("thread/resume"),
    params: threadResumeParamsSchema
  }),
  z37.object({
    method: z37.literal("thread/fork"),
    params: threadForkParamsSchema
  }),
  z37.object({
    method: z37.literal("turn/start"),
    params: turnStartParamsSchema
  }),
  z37.object({
    method: z37.literal("turn/steer"),
    params: turnSteerParamsSchema
  }),
  z37.object({
    method: z37.literal("thread/stop"),
    params: threadStopParamsSchema
  }),
  z37.object({
    method: z37.literal("thread/discard"),
    params: threadDiscardParamsSchema
  }),
  z37.object({
    method: z37.literal("skills/configure"),
    params: skillsConfigureParamsSchema
  })
]);
var acpBridgeCommandMethodValues = acpBridgeCommandSchema.options.map(
  (option) => option.shape.method.value
);
var ACP_TURN_STARTED_METHOD = "acp/turn/started";
var ACP_TURN_COMPLETED_METHOD = "acp/turn/completed";
var ACP_COMPACTION_STARTED_METHOD = "acp/compaction/started";
var ACP_COMPACTION_COMPLETED_METHOD = "acp/compaction/completed";
var ACP_UPDATE_METHOD = "acp/update";
var ACP_FS_WRITE_METHOD = "acp/fs/write";
var ACP_WARNING_METHOD = "acp/warning";
var acpTurnStartedNotificationParamsSchema = z37.object({
  threadId: z37.string().min(1)
}).passthrough();
var acpTurnCompletedNotificationParamsSchema = z37.object({
  threadId: z37.string().min(1),
  stopReason: acpStopReasonSchema
}).passthrough();
var acpCompactionCompletedNotificationParamsSchema = z37.discriminatedUnion("status", [
  z37.object({
    threadId: z37.string().min(1),
    status: z37.literal("completed")
  }).passthrough(),
  z37.object({
    threadId: z37.string().min(1),
    status: z37.literal("interrupted")
  }).passthrough(),
  z37.object({
    threadId: z37.string().min(1),
    status: z37.literal("skipped"),
    detail: z37.string().min(1)
  }).passthrough(),
  z37.object({
    threadId: z37.string().min(1),
    status: z37.literal("failed"),
    error: z37.string().min(1)
  }).passthrough()
]);
var acpUpdateNotificationParamsSchema = z37.object({
  threadId: z37.string().min(1),
  update: acpSessionUpdateSchema
}).passthrough();
var acpFsWriteNotificationParamsSchema = z37.object({
  threadId: z37.string().min(1),
  path: z37.string().min(1),
  kind: z37.enum(["add", "update"]),
  oldText: z37.string().optional(),
  content: z37.string()
}).passthrough();
var acpWarningNotificationParamsSchema = z37.object({
  threadId: z37.string().min(1),
  summary: z37.string().min(1),
  details: z37.string().optional()
}).passthrough();

// ../provider-bridge-acp/src/dialect.ts
import { basename } from "node:path";
import { z as z42 } from "zod";

// ../provider-bridge-acp/src/bridge/provider-maintenance.ts
import { execFile as execFile4 } from "node:child_process";
import { existsSync } from "node:fs";
import fs3 from "node:fs/promises";
import os2 from "node:os";
import path10 from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { promisify as promisify5 } from "node:util";
import { z as z39 } from "zod";

// ../provider-bridge-acp/src/bridge/opencode-usage.ts
import fs2 from "node:fs/promises";
import os from "node:os";
import path9 from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z as z38 } from "zod";
var apiCredentialSchema = z38.object({
  type: z38.literal("api"),
  key: z38.string().trim().min(1)
});
var storedKeySchema = apiCredentialSchema.extend({ type: z38.literal("key") });
var credentialsSchema = z38.record(z38.string(), z38.unknown());
var accountSchema = z38.object({
  id: z38.string().min(1),
  email: z38.email().nullable().catch(null),
  url: z38.url(),
  access_token: z38.string().min(1),
  token_expiry: z38.number().nullable(),
  active_org_id: z38.string().min(1).nullable()
});
var storedOAuthSchema = z38.object({
  type: z38.literal("oauth"),
  methodID: z38.literal("device"),
  access: z38.string().min(1),
  expires: z38.number().nonnegative(),
  metadata: z38.object({
    server: z38.url().default("https://opencode.ai/console"),
    accountID: z38.string().min(1),
    email: z38.email().nullable().catch(null),
    orgID: z38.string().min(1)
  })
});
function isOfficialConsole(url) {
  const issuer = new URL(url);
  return issuer.origin === "https://opencode.ai" && ["/", "/console", "/console/"].includes(issuer.pathname);
}
var windowSchema = z38.object({
  status: z38.enum(["ok", "rate-limited"]),
  percent: z38.number().nonnegative(),
  resetsAt: z38.iso.datetime({ offset: true })
});
var usageSchema = z38.object({
  usage: z38.object({
    rolling: windowSchema,
    weekly: windowSchema,
    monthly: windowSchema
  })
});
function dataDirectory(env) {
  const dataHome = env.XDG_DATA_HOME;
  return path9.join(
    dataHome && path9.isAbsolute(dataHome) ? dataHome : path9.join(env.HOME || os.homedir(), ".local", "share"),
    "opencode"
  );
}
async function openDatabase(env) {
  const databasePath = path9.join(dataDirectory(env), "opencode.db");
  try {
    await fs2.access(databasePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
  return new DatabaseSync(databasePath, { readOnly: true });
}
function readAccount(database) {
  const tables = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('account', 'account_state')"
  ).all();
  if (tables.length !== 2) return null;
  const row = database.prepare(
    "SELECT a.id, a.email, a.url, a.access_token, a.token_expiry, s.active_org_id FROM account a JOIN account_state s ON s.active_account_id = a.id WHERE s.id = 1"
  ).get();
  if (!row) return null;
  const account = accountSchema.parse(row);
  if (!isOfficialConsole(account.url) || account.active_org_id === null)
    return null;
  return account;
}
function readStoredCredential(database) {
  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'"
  ).get();
  if (!table) return null;
  const query = database.prepare(
    "SELECT value FROM credential WHERE integration_id = ? AND active = 1 ORDER BY time_created DESC, id DESC LIMIT 1"
  );
  for (const provider of ["opencode-go", "opencode"]) {
    const row = query.get(provider);
    if (!row) continue;
    const value = z38.string().parse(row.value);
    const parsed = JSON.parse(value);
    const credential = storedKeySchema.safeParse(parsed);
    if (credential.success)
      return { apiKey: credential.data.key, account: null };
    const oauth = storedOAuthSchema.safeParse(parsed);
    if (!oauth.success || !isOfficialConsole(oauth.data.metadata.server))
      continue;
    const { access: access2, expires, metadata } = oauth.data;
    return {
      apiKey: access2,
      account: {
        id: metadata.accountID,
        email: metadata.email,
        url: metadata.server,
        access_token: access2,
        token_expiry: expires,
        active_org_id: metadata.orgID
      }
    };
  }
  return null;
}
async function readLegacyApiKey(env) {
  let content = env.OPENCODE_AUTH_CONTENT;
  if (content) {
    try {
      JSON.parse(content);
    } catch {
      content = void 0;
    }
  }
  if (!content) {
    try {
      content = await fs2.readFile(
        path9.join(dataDirectory(env), "auth.json"),
        "utf8"
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  const credentials = credentialsSchema.parse(JSON.parse(content));
  for (const provider of ["opencode-go", "opencode"]) {
    const credential = apiCredentialSchema.safeParse(credentials[provider]);
    if (credential.success) return credential.data.key;
  }
  return null;
}
async function readOpenCodeGoUsage(env) {
  const failure = (message) => ({
    supported: true,
    usage: {
      status: "error",
      message,
      planLabel: "OpenCode Go",
      accountEmail: null
    }
  });
  let apiKey;
  let account = null;
  try {
    apiKey = env.OPENCODE_API_KEY?.trim() || null;
    if (apiKey === null) {
      const database = await openDatabase(env);
      if (database) {
        try {
          account = readAccount(database);
          if (account) {
            apiKey = account.access_token;
          } else {
            const stored = readStoredCredential(database);
            apiKey = stored?.apiKey ?? null;
            account = stored?.account ?? null;
          }
        } finally {
          database.close();
        }
      }
      apiKey ??= await readLegacyApiKey(env);
    }
  } catch {
    return failure("OpenCode credentials could not be read.");
  }
  if (apiKey === null)
    return { supported: true, usage: { status: "unauthenticated" } };
  if (account?.token_expiry != null && account.token_expiry <= Date.now())
    return { supported: true, usage: { status: "expired" } };
  try {
    const response = await fetch(
      account ? "https://opencode.ai/inference/go/v1/usage" : "https://opencode.ai/zen/go/v1/usage",
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
          "User-Agent": "bb-provider-acp",
          ...account?.active_org_id ? { "x-opencode-org-id": account.active_org_id } : {}
        },
        redirect: "error",
        signal: AbortSignal.timeout(15e3)
      }
    );
    if (response.status === 401)
      return { supported: true, usage: { status: "expired" } };
    if (response.status === 403)
      return failure(
        "OpenCode Go usage access was denied. Check that the account has an active Go subscription."
      );
    if (!response.ok)
      return failure(
        `OpenCode Go usage request failed (HTTP ${response.status}).`
      );
    const parsed = usageSchema.safeParse(await response.json());
    if (!parsed.success)
      return failure("OpenCode Go returned invalid usage information.");
    const { rolling, weekly, monthly } = parsed.data.usage;
    return {
      supported: true,
      usage: {
        status: "ok",
        accountEmail: account?.email ?? null,
        accountKey: account ? `opencode:organization:${account.active_org_id}:account:${account.id}` : null,
        planLabel: "OpenCode Go",
        windows: [
          { label: "5 hour", kind: "five-hour", window: rolling },
          { label: "Weekly", kind: "weekly", window: weekly },
          { label: "Monthly", kind: "custom", window: monthly }
        ].map(({ label, kind, window }) => ({
          label,
          kind,
          model: null,
          usedPercent: Math.min(100, window.percent),
          resetsAt: window.resetsAt
        }))
      }
    };
  } catch {
    return failure("OpenCode Go usage could not be collected. Try again.");
  }
}

// ../provider-bridge-acp/src/bridge/provider-maintenance.ts
var execFileAsync3 = promisify5(execFile4);
var USAGE_FETCH_TIMEOUT_MS = 15e3;
var CURSOR_DASHBOARD_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService";
var CURSOR_KEYCHAIN_ACCOUNT = "cursor-user";
var CURSOR_ACCESS_TOKEN_SERVICE = "cursor-access-token";
var CURSOR_INSTALL_SCRIPT_URL = "https://cursor.com/install";
function cursorAuthFilePath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path10.join(os2.homedir(), "AppData", "Roaming");
    return path10.join(appData, "Cursor", "auth.json");
  }
  if (process.platform === "darwin") {
    return path10.join(os2.homedir(), ".cursor", "auth.json");
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path10.join(os2.homedir(), ".config");
  return path10.join(configHome, "cursor", "auth.json");
}
async function readKeychainAccessToken() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await execFileAsync3(
      "security",
      [
        "find-generic-password",
        "-s",
        CURSOR_ACCESS_TOKEN_SERVICE,
        "-a",
        CURSOR_KEYCHAIN_ACCOUNT,
        "-w"
      ],
      { timeout: 1e4 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
var cursorFileCredentialsSchema = z39.object({
  accessToken: z39.string().min(1).nullish()
});
async function readAccessToken() {
  const keychain = await readKeychainAccessToken();
  if (keychain) return keychain;
  try {
    const parsed = cursorFileCredentialsSchema.safeParse(
      JSON.parse(await fs3.readFile(cursorAuthFilePath(), "utf8"))
    );
    return parsed.success ? parsed.data.accessToken ?? null : null;
  } catch {
    return null;
  }
}
function cursorStateDatabasePath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path10.join(os2.homedir(), "AppData", "Roaming");
    return path10.join(appData, "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "darwin") {
    return path10.join(
      os2.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  const configHome = process.env.XDG_CONFIG_HOME ?? path10.join(os2.homedir(), ".config");
  return path10.join(
    configHome,
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb"
  );
}
function readAccountEmail() {
  const databasePath = cursorStateDatabasePath();
  if (!existsSync(databasePath)) return null;
  let database = null;
  try {
    database = new DatabaseSync2(databasePath);
    database.exec("PRAGMA query_only = true");
    const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/cachedEmail");
    const parsed = z39.object({ value: z39.string().email() }).safeParse(row);
    return parsed.success ? parsed.data.value : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
function healthResult(args) {
  const maintained = args.maintenance !== void 0;
  return {
    supported: true,
    health: {
      status: args.status,
      statusMessage: args.statusMessage ?? null,
      accountEmail: args.accountEmail ?? null,
      planLabel: null,
      installedVersion: args.installedVersion ?? null,
      minimumSupportedVersion: null,
      canInstall: maintained,
      canUpdate: maintained && args.status !== "not_installed",
      loginCommand: args.maintenance?.loginCommand ?? null
    }
  };
}
async function getAcpProviderHealth(args) {
  const maintenance = args.maintenance;
  if (args.command === null) {
    return healthResult({
      maintenance,
      status: "unknown",
      statusMessage: "The ACP provider has no launch command."
    });
  }
  if (await resolveExecutablePath(args.command) === null) {
    return healthResult({ maintenance, status: "not_installed" });
  }
  const version = await readCliVersion(args.command);
  if (maintenance === void 0) {
    return healthResult({
      maintenance,
      status: "ready",
      installedVersion: version
    });
  }
  try {
    const account = await maintenance.readAccount();
    return healthResult({
      maintenance,
      status: account === null ? "unauthenticated" : "ready",
      accountEmail: account?.email ?? null,
      installedVersion: version
    });
  } catch (error) {
    return healthResult({
      maintenance,
      status: "unknown",
      installedVersion: version,
      statusMessage: error instanceof Error ? error.message : String(error)
    });
  }
}
async function getAcpProviderInstallationStatus(args) {
  const executableName = args.command ?? "";
  const resolvedExecutable = args.command === null ? null : await resolveExecutablePath(args.command);
  const installed = resolvedExecutable !== null;
  const currentVersion = installed && args.command !== null ? await readCliVersion(args.command) : null;
  const installAction = args.maintenance !== void 0 && !installed ? {
    kind: "install",
    label: "Install",
    command: args.maintenance.installer().displayCommand
  } : null;
  return {
    executableName,
    executablePath: resolvedExecutable,
    installed,
    installSource: installed ? "external" : "notInstalled",
    currentVersion,
    latestVersion: null,
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction,
    needsUpdate: false,
    versionUnsupported: false
  };
}
async function getAcpProviderInstallationRun(args) {
  const status = await getAcpProviderInstallationStatus(args);
  return buildAcpProviderInstallationRun(status, args);
}
function buildAcpProviderInstallationRun(status, args) {
  if (status.installAction?.kind !== args.action || args.maintenance === void 0) {
    return {
      available: false,
      message: `${args.command ?? "This ACP agent"} ${args.action} is not available on this host.`
    };
  }
  return {
    available: true,
    command: args.maintenance.installer(),
    verification: { kind: "installed" }
  };
}
var cursorNonNegativeIntegerSchema = z39.union([
  z39.number().int().nonnegative(),
  z39.string().regex(/^\d+$/u).transform(Number)
]).refine(Number.isSafeInteger);
var cursorUsageResponseSchema = z39.object({
  billingCycleEnd: cursorNonNegativeIntegerSchema.nullish(),
  planUsage: z39.object({ totalPercentUsed: z39.number().nonnegative().default(0) }).nullish(),
  spendLimitUsage: z39.object({
    overallLimit: cursorNonNegativeIntegerSchema.nullish(),
    overallUsed: cursorNonNegativeIntegerSchema.nullish(),
    individualLimit: cursorNonNegativeIntegerSchema.nullish(),
    individualUsed: cursorNonNegativeIntegerSchema.nullish(),
    pooledLimit: cursorNonNegativeIntegerSchema.nullish(),
    pooledUsed: cursorNonNegativeIntegerSchema.nullish()
  }).nullish()
}).passthrough();
var cursorPlanResponseSchema = z39.object({
  planInfo: z39.object({ planName: z39.string().min(1) }).nullish()
}).passthrough();
function normalizeUsage(rawUsage, rawPlan, accountEmail = null) {
  const usage = cursorUsageResponseSchema.safeParse(rawUsage);
  if (!usage.success) {
    return {
      status: "error",
      message: "Cursor usage response was malformed.",
      planLabel: null,
      accountEmail
    };
  }
  const plan = cursorPlanResponseSchema.safeParse(rawPlan);
  const resetsAt = usage.data.billingCycleEnd == null ? null : new Date(usage.data.billingCycleEnd).toISOString();
  const windows = [];
  if (usage.data.planUsage?.totalPercentUsed != null) {
    windows.push({
      label: "Plan usage",
      usedPercent: clampPercent(usage.data.planUsage.totalPercentUsed),
      resetsAt
    });
  }
  const spend = usage.data.spendLimitUsage;
  const pair = spend?.overallLimit != null ? { limit: spend.overallLimit, used: spend.overallUsed ?? 0 } : spend?.individualLimit != null ? { limit: spend.individualLimit, used: spend.individualUsed ?? 0 } : spend?.pooledLimit != null ? { limit: spend.pooledLimit, used: spend.pooledUsed ?? 0 } : null;
  if (pair && pair.limit > 0) {
    windows.push({
      label: "On-demand spend",
      usedPercent: clampPercent(pair.used / pair.limit * 100),
      resetsAt,
      cost: { usedUsdCents: pair.used, limitUsdCents: pair.limit }
    });
  }
  return {
    status: "ok",
    accountEmail,
    planLabel: plan.success ? plan.data.planInfo?.planName ?? null : null,
    windows
  };
}
function fetchDashboard(method, accessToken) {
  return fetch(`${CURSOR_DASHBOARD_URL}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "x-cursor-client-type": "cli",
      "x-cursor-client-version": "cli-bb-provider-acp"
    },
    body: "{}",
    signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS)
  });
}
async function getAcpProviderUsage(args) {
  const readUsage = args.dialectId === "opencode" ? () => readOpenCodeGoUsage(args.env) : args.maintenance?.readUsage;
  if (readUsage === void 0) return { supported: false };
  if (args.command === null || await resolveExecutablePath(args.command) === null) {
    return { supported: true, usage: { status: "not_installed" } };
  }
  return readUsage();
}
var CURSOR_ACP_MAINTENANCE = {
  loginCommand: "cursor-agent login",
  installer: () => downloadedInstallerCommand(CURSOR_INSTALL_SCRIPT_URL),
  readAccount: async () => {
    const accessToken = await readAccessToken();
    return accessToken === null ? null : { email: readAccountEmail() };
  },
  readUsage: readCursorUsage
};
async function readCursorUsage() {
  const accessToken = await readAccessToken();
  if (!accessToken) {
    return { supported: true, usage: { status: "unauthenticated" } };
  }
  try {
    const [usageResponse, planResponse] = await Promise.all([
      fetchDashboard("GetCurrentPeriodUsage", accessToken),
      fetchDashboard("GetPlanInfo", accessToken)
    ]);
    if (usageResponse.status === 401 || planResponse.status === 401) {
      return { supported: true, usage: { status: "expired" } };
    }
    if (!usageResponse.ok) {
      return {
        supported: true,
        usage: {
          status: "error",
          message: `Cursor usage request failed (HTTP ${usageResponse.status}).`,
          planLabel: null,
          accountEmail: readAccountEmail()
        }
      };
    }
    return {
      supported: true,
      usage: normalizeUsage(
        await usageResponse.json(),
        planResponse.ok ? await planResponse.json() : {},
        readAccountEmail()
      )
    };
  } catch (error) {
    return {
      supported: true,
      usage: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        planLabel: null,
        accountEmail: readAccountEmail()
      }
    };
  }
}

// ../provider-bridge-acp/src/presentation.ts
function stripCodeTicks(text) {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1) : trimmed;
}
function commandPresentation(command) {
  return withTitle(
    {
      label: { pending: "Running command", completed: "Ran command" },
      icon: { glyph: "Terminal" }
    },
    presentationTitle(stripCodeTicks(command))
  );
}
function fileChangePresentation(args) {
  const names = [...new Set(args.paths.map(presentationFileName))];
  const plural = names.length > 1;
  const label = args.verb === "add" ? {
    pending: plural ? "Writing files" : "Writing file",
    completed: plural ? "Wrote files" : "Wrote file"
  } : args.verb === "delete" ? {
    pending: plural ? "Deleting files" : "Deleting file",
    completed: plural ? "Deleted files" : "Deleted file"
  } : {
    pending: plural ? "Editing files" : "Editing file",
    completed: plural ? "Edited files" : "Edited file"
  };
  return withTitle(
    {
      label,
      icon: { glyph: args.verb === "delete" ? "Trash2" : "EditFile" }
    },
    names.length === 0 ? void 0 : presentationTitle(names.join(", "))
  );
}
function delegationPresentation(args) {
  const presentation = withTitle(
    {
      label: { pending: "Running subagent", completed: "Subagent finished" },
      icon: { glyph: "UserRound" }
    },
    presentationTitle(args.label)
  );
  return args.detail === void 0 ? presentation : { ...presentation, detail: args.detail };
}
var KIND_PRESENTATIONS = {
  read: {
    label: { pending: "Reading file", completed: "Read file" },
    glyph: "FileText"
  },
  edit: {
    label: { pending: "Editing file", completed: "Edited file" },
    glyph: "EditFile"
  },
  delete: {
    label: { pending: "Deleting file", completed: "Deleted file" },
    glyph: "Trash2"
  },
  move: {
    label: { pending: "Moving file", completed: "Moved file" },
    glyph: "FolderEdit"
  },
  search: {
    label: { pending: "Searching", completed: "Searched" },
    glyph: "Search"
  },
  execute: {
    label: { pending: "Running command", completed: "Ran command" },
    glyph: "Terminal"
  },
  think: {
    label: { pending: "Thinking", completed: "Thought" },
    glyph: "Brain"
  },
  fetch: {
    label: { pending: "Fetching", completed: "Fetched" },
    glyph: "Globe"
  },
  switch_mode: {
    label: { pending: "Switching mode", completed: "Switched mode" },
    glyph: "SlidersHorizontal"
  },
  other: {
    label: { pending: "Running tool", completed: "Ran tool" },
    glyph: "Toolbox"
  }
};
function toolKindPresentation(args) {
  const spec = KIND_PRESENTATIONS[args.kind ?? "other"];
  const label = args.name === void 0 ? spec.label : { pending: `Running ${args.name}`, completed: `Ran ${args.name}` };
  return withTitle(
    { label, icon: { glyph: spec.glyph } },
    args.title === void 0 ? void 0 : presentationTitle(args.title)
  );
}

// ../provider-bridge-acp/src/tool-classification.ts
import { z as z41 } from "zod";

// ../provider-bridge-acp/src/tool-call-operation.ts
import path11 from "node:path";
import { z as z40 } from "zod";
var acpRawInputCommandSchema = z40.object({ command: z40.string() }).passthrough();
var acpRawInputPathSchema = z40.object({
  path: z40.string().optional(),
  filePath: z40.string().optional(),
  file_path: z40.string().optional(),
  target_file: z40.string().optional()
}).passthrough();
function resolveAcpToolCallPath(value, options) {
  const cwd = options?.cwd;
  if (cwd === void 0 || path11.isAbsolute(value) || value.startsWith("~")) {
    return value;
  }
  return path11.resolve(cwd, value);
}
function extractAcpCommand(event) {
  const parsed = acpRawInputCommandSchema.safeParse(event.rawInput);
  if (parsed.success && parsed.data.command.trim().length > 0) {
    return parsed.data.command;
  }
  return toOptionalString(event.title);
}
function isNonBlank(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function extractAcpToolCallPaths(event, options) {
  const paths = [];
  for (const entry of event.content ?? []) {
    if (entry.type === "diff" && isNonBlank(entry.path)) {
      paths.push(resolveAcpToolCallPath(entry.path, options));
    }
  }
  for (const location of event.locations ?? []) {
    if (isNonBlank(location.path)) {
      paths.push(resolveAcpToolCallPath(location.path, options));
    }
  }
  if (paths.length > 0) {
    return paths;
  }
  const parsed = acpRawInputPathSchema.safeParse(event.rawInput);
  if (!parsed.success) {
    return [];
  }
  const rawInputPath = [
    parsed.data.path,
    parsed.data.filePath,
    parsed.data.file_path,
    parsed.data.target_file
  ].find(isNonBlank);
  return rawInputPath === void 0 ? [] : [resolveAcpToolCallPath(rawInputPath, options)];
}
function classifyAcpToolCall(event, options) {
  if (event.kind === "execute") {
    const command = extractAcpCommand(event);
    if (command) {
      return { kind: "command", command };
    }
  }
  const paths = extractAcpToolCallPaths(event, options);
  const hasDiff = (event.content ?? []).some((entry) => entry.type === "diff");
  if (hasDiff || event.kind === "edit") {
    return { kind: "file_change", changeKind: "update", paths };
  }
  if (event.kind === "delete") {
    return { kind: "file_change", changeKind: "delete", paths };
  }
  return { kind: "generic" };
}
function resolveAcpFileChangeWriteScope(paths) {
  const normalized = paths.filter(isNonBlank).map((entry) => {
    const value = path11.normalize(entry);
    return value !== path11.parse(value).root && value.endsWith(path11.sep) ? value.slice(0, -1) : value;
  });
  const [first, ...rest] = normalized;
  if (first === void 0) {
    return null;
  }
  let candidate = first;
  for (const entry of rest) {
    if (entry.length < candidate.length) {
      candidate = entry;
    }
  }
  for (const entry of normalized) {
    if (!isPathWithinDirectory(candidate, entry)) {
      return null;
    }
  }
  return candidate;
}

// ../provider-bridge-acp/src/tool-classification.ts
var BB_TOOL_SERVER = "bb";
function isInjectedToolCandidate(event) {
  if (event.kind !== void 0 && event.kind !== "other") {
    return false;
  }
  return classifyAcpToolCall(event).kind === "generic";
}
var INLINE_IMAGE_DATA_URL_PATTERN = /data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,[a-z0-9+/_=-]+/giu;
var ACP_TOOL_PAYLOAD_MAX_CHARS = 64 * 1024;
function scrubInlineImageDataUrls(text) {
  return text.replace(INLINE_IMAGE_DATA_URL_PATTERN, "[image]");
}
function scrubToolPayloadStrings(value) {
  if (typeof value === "string") {
    return scrubInlineImageDataUrls(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubToolPayloadStrings);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        scrubToolPayloadStrings(entry)
      ])
    );
  }
  return value;
}
function truncatedPayloadText(text) {
  if (text.length <= ACP_TOOL_PAYLOAD_MAX_CHARS) {
    return text;
  }
  const removed = text.length - ACP_TOOL_PAYLOAD_MAX_CHARS;
  return `${text.slice(0, ACP_TOOL_PAYLOAD_MAX_CHARS)}
\u2026[${removed.toLocaleString("en-US")} more characters truncated]`;
}
function boundAcpToolPayload(value) {
  if (value === void 0) {
    return void 0;
  }
  const scrubbed = scrubToolPayloadStrings(value);
  const serialized = JSON.stringify(scrubbed);
  if (serialized === void 0) {
    return void 0;
  }
  if (serialized.length <= ACP_TOOL_PAYLOAD_MAX_CHARS) {
    return scrubbed;
  }
  return truncatedPayloadText(
    typeof scrubbed === "string" ? scrubbed : extractResultText(scrubbed)
  );
}
function boundAcpToolArgs(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const bounded = boundAcpToolPayload(value);
  if (typeof bounded === "string") {
    return { truncated: bounded };
  }
  return bounded !== null && typeof bounded === "object" && !Array.isArray(bounded) ? bounded : void 0;
}
function extractAcpToolCallContentText(event) {
  const chunks = [];
  for (const entry of event.content ?? []) {
    if (entry.type !== "content") {
      continue;
    }
    const text = extractAcpContentText(entry.content);
    if (text) {
      chunks.push(text);
    }
  }
  return chunks.length > 0 ? chunks.join("\n") : void 0;
}
function extractAcpToolCallOutputText(event) {
  const contentText = extractAcpToolCallContentText(event);
  if (contentText !== void 0) {
    return contentText;
  }
  if (event.rawOutput === void 0) {
    return void 0;
  }
  const rawOutputText = scrubInlineImageDataUrls(
    extractResultText(event.rawOutput)
  ).trim();
  return rawOutputText.length > 0 ? rawOutputText : void 0;
}
var commandRawOutputSchema = z41.object({
  exitCode: z41.number().int().nullable().optional(),
  exit_code: z41.number().int().nullable().optional(),
  stdout: z41.string().optional(),
  stderr: z41.string().optional(),
  output_for_prompt: z41.string().optional(),
  signal: z41.string().nullable().optional(),
  timed_out: z41.boolean().optional()
}).passthrough();
function emptyToUndefined(value) {
  return value === void 0 || value.length === 0 ? void 0 : value;
}
function joinStreams(stdout, stderr) {
  if (stdout.length === 0 && stderr.length === 0) {
    return void 0;
  }
  if (stdout.length === 0 || stderr.length === 0) {
    return stdout.length > 0 ? stdout : stderr;
  }
  return stdout.endsWith("\n") ? `${stdout}${stderr}` : `${stdout}
${stderr}`;
}
function acpCommandOutputSoFar(event, raw) {
  const content = extractAcpToolCallContentText(event);
  if (content !== void 0) {
    return { reported: true, output: content };
  }
  if (typeof event.rawOutput === "string") {
    return {
      reported: true,
      output: emptyToUndefined(
        scrubInlineImageDataUrls(event.rawOutput).trim()
      )
    };
  }
  if (raw === void 0) {
    return { reported: false, output: void 0 };
  }
  if (raw.stdout !== void 0 || raw.stderr !== void 0) {
    return {
      reported: true,
      output: joinStreams(raw.stdout ?? "", raw.stderr ?? "")
    };
  }
  if (raw.output_for_prompt !== void 0) {
    return { reported: true, output: emptyToUndefined(raw.output_for_prompt) };
  }
  return { reported: false, output: void 0 };
}
function extractAcpStreamedCommandOutput(event) {
  const parsed = commandRawOutputSchema.safeParse(event.rawOutput);
  const { output } = acpCommandOutputSoFar(
    event,
    parsed.success ? parsed.data : void 0
  );
  return output === void 0 ? void 0 : scrubInlineImageDataUrls(output);
}
function extractAcpCommandResult(event) {
  const parsed = commandRawOutputSchema.safeParse(event.rawOutput);
  const raw = parsed.success ? parsed.data : void 0;
  const exitCode = raw?.exitCode ?? raw?.exit_code ?? void 0;
  const reported = acpCommandOutputSoFar(event, raw);
  let output = reported.reported ? reported.output : extractAcpToolCallOutputText(event);
  const notes = [
    ...raw?.timed_out === true ? ["[timed out]"] : [],
    ...raw?.signal ? [`[signal ${raw.signal}]`] : []
  ];
  if (notes.length > 0) {
    const body = output ?? "";
    output = `${body}${body.length > 0 && !body.endsWith("\n") ? "\n" : ""}${notes.join(" ")}`;
  }
  return {
    ...exitCode === void 0 ? {} : { exitCode },
    ...output === void 0 ? {} : { output: scrubInlineImageDataUrls(output) }
  };
}
var optionalNonBlank = z41.string().optional().transform(
  (value) => value !== void 0 && value.trim().length > 0 ? value : void 0
);
var searchRawInputSchema = z41.object({
  pattern: optionalNonBlank,
  query: optionalNonBlank,
  regex: optionalNonBlank,
  glob: optionalNonBlank,
  globPattern: optionalNonBlank,
  path: optionalNonBlank,
  directory: optionalNonBlank
}).passthrough();
var fetchRawInputSchema = z41.object({ url: optionalNonBlank, uri: optionalNonBlank }).passthrough();
var thinkRawInputSchema = z41.object({ thought: optionalNonBlank, thinking: optionalNonBlank }).passthrough();
var SINGLE_TICKED_TOKEN_PATTERN = /^[^`]*`([^`\n]+)`[^`]*$/;
var URL_PATTERN = /https?:\/\/[^\s`'"<>]+/g;
function tickedTokenFromTitle(title) {
  if (title === void 0) {
    return void 0;
  }
  const match = SINGLE_TICKED_TOKEN_PATTERN.exec(title);
  const token = match?.[1]?.trim();
  return token !== void 0 && token.length > 0 ? token : void 0;
}
function urlFromTitle(title) {
  if (title === void 0) {
    return void 0;
  }
  const urls = title.match(URL_PATTERN);
  return urls !== null && urls.length === 1 ? urls[0] : void 0;
}
function looksLikePath(token) {
  return token.startsWith("/") || token.startsWith("~") || token.startsWith(".");
}
function fileChangeVerb(changes, fallback) {
  if (changes.length === 0) {
    return fallback;
  }
  if (changes.every((change) => change.kind === "add")) {
    return "add";
  }
  if (changes.every((change) => change.kind === "delete")) {
    return "delete";
  }
  return "update";
}
function buildAcpFileChanges(event, operation, options) {
  const changes = [];
  for (const entry of event.content ?? []) {
    if (entry.type !== "diff") {
      continue;
    }
    const oldText = entry.oldText ?? void 0;
    changes.push({
      path: resolveAcpToolCallPath(entry.path, options),
      kind: oldText === void 0 ? "add" : "update",
      ...oldText === void 0 ? {} : { oldText },
      newText: entry.newText
    });
  }
  if (changes.length > 0) {
    return changes;
  }
  const [path13] = operation.paths;
  return path13 === void 0 ? [] : [{ path: path13, kind: operation.changeKind }];
}
function fileChangeItem(changes, fallbackVerb) {
  return {
    item: { type: "fileChange", changes },
    presentation: fileChangePresentation({
      verb: fileChangeVerb(changes, fallbackVerb),
      paths: changes.map((change) => change.path)
    })
  };
}
function fileReadItem(event, title, options) {
  const ticked = tickedTokenFromTitle(title);
  const path13 = extractAcpToolCallPaths(event, options)[0] ?? (ticked !== void 0 && looksLikePath(ticked) ? ticked : void 0);
  if (path13 === void 0) {
    return null;
  }
  return {
    item: { type: "fileRead", path: path13 },
    presentation: fileReadPresentation(path13)
  };
}
function searchItem(event) {
  const parsed = searchRawInputSchema.safeParse(event.rawInput);
  if (!parsed.success) {
    return null;
  }
  const input = parsed.data;
  const glob = input.glob ?? input.globPattern;
  const contentQuery = input.pattern ?? input.query ?? input.regex;
  const mode = contentQuery !== void 0 ? "content" : "path";
  const query = contentQuery ?? glob;
  if (query === void 0) {
    return null;
  }
  const root = input.path ?? input.directory;
  return {
    item: {
      type: "search",
      mode,
      query,
      ...root === void 0 ? {} : { path: root }
    },
    presentation: searchPresentation({ mode, query })
  };
}
function webFetchItem(event, title) {
  const parsed = fetchRawInputSchema.safeParse(event.rawInput);
  const url = (parsed.success ? parsed.data.url ?? parsed.data.uri : void 0) ?? urlFromTitle(title);
  if (url === void 0) {
    return null;
  }
  return {
    item: { type: "webFetch", url, pattern: null },
    presentation: webFetchPresentation(url)
  };
}
function reasoningItem(event) {
  const parsed = thinkRawInputSchema.safeParse(event.rawInput);
  const thought = extractAcpToolCallOutputText(event) ?? (parsed.success ? parsed.data.thought ?? parsed.data.thinking : void 0);
  return {
    item: {
      type: "reasoning",
      summary: [],
      content: thought === void 0 ? [] : [thought]
    },
    presentation: REASONING_PRESENTATION
  };
}
function genericToolFields(event) {
  const args = boundAcpToolArgs(event.rawInput);
  const result = boundAcpToolPayload(event.rawOutput);
  const error = event.status === "failed" ? extractAcpToolCallOutputText(event) : void 0;
  return {
    ...args === void 0 ? {} : { args },
    ...result === void 0 ? {} : { result },
    ...error === void 0 ? {} : { error }
  };
}
function genericToolItem(event, title) {
  const name = toOptionalString(event.name);
  return {
    item: {
      type: "tool",
      tool: name ?? event.rawKind ?? event.kind ?? "tool",
      ...genericToolFields(event)
    },
    presentation: toolKindPresentation({ kind: event.kind, name, title })
  };
}
function bbToolItem(event, injected) {
  return {
    item: {
      type: "tool",
      tool: injected.name,
      server: BB_TOOL_SERVER,
      ...genericToolFields(event)
    },
    presentation: injected.presentation ?? toolPresentation(injected.name)
  };
}
function classifyAcpToolCall2(event, injected, options) {
  if (injected !== void 0 && isInjectedToolCandidate(event)) {
    return bbToolItem(event, injected);
  }
  const operation = classifyAcpToolCall(event, options);
  if (operation.kind === "command") {
    const cwd = toOptionalString(options?.cwd);
    if (cwd !== void 0) {
      return {
        item: { type: "command", command: operation.command, cwd },
        presentation: commandPresentation(operation.command)
      };
    }
  }
  if (operation.kind === "file_change") {
    const changes = buildAcpFileChanges(event, operation, options);
    return fileChangeItem(changes, operation.changeKind);
  }
  const title = toOptionalString(event.title);
  switch (event.kind) {
    case "read":
      return fileReadItem(event, title, options) ?? genericToolItem(event, title);
    case "search":
      return searchItem(event) ?? genericToolItem(event, title);
    case "fetch":
      return webFetchItem(event, title) ?? genericToolItem(event, title);
    case "think":
      return reasoningItem(event);
    case "execute":
    case "edit":
    case "delete":
    case "move":
    case "switch_mode":
    case "other":
    case void 0:
      return genericToolItem(event, title);
  }
}

// ../provider-bridge-acp/src/dialect.ts
var GENERIC_ACP_DIALECT = { id: "acp" };
var grokToolMetaSchema = z42.object({
  "x.ai/tool": z42.object({
    name: z42.string().optional(),
    kind: z42.string().optional()
  }).passthrough()
}).passthrough();
function grokToolIdentity(event) {
  const meta = grokToolMetaSchema.safeParse(event["_meta"]);
  if (!meta.success) {
    return void 0;
  }
  const tool = meta.data["x.ai/tool"];
  const kind = acpToolKindSchema.safeParse(tool.kind);
  return {
    ...tool.name !== void 0 && tool.name.length > 0 ? { name: tool.name } : {},
    ...kind.success ? { kind: kind.data } : {}
  };
}
var GROK_SPAWN_SUBAGENT_TOOL = "spawn_subagent";
var grokSpawnSubagentInputSchema = z42.object({
  description: z42.string().optional(),
  prompt: z42.string().optional(),
  subagent_type: z42.string().optional()
}).passthrough();
function grokClassifyToolCall(event) {
  if (grokToolIdentity(event)?.name !== GROK_SPAWN_SUBAGENT_TOOL) {
    return void 0;
  }
  const parsed = grokSpawnSubagentInputSchema.safeParse(event.rawInput);
  const input = parsed.success ? parsed.data : void 0;
  const label = input?.description ?? input?.prompt ?? event.title ?? "Subagent";
  const shape = {
    type: "delegation",
    childRef: event.toolCallId,
    label,
    background: false
  };
  return {
    item: shape,
    presentation: delegationPresentation({
      label,
      ...input?.subagent_type === void 0 ? {} : { detail: input.subagent_type }
    })
  };
}
var GROK_ACP_DIALECT = {
  id: "grok",
  toolIdentity: grokToolIdentity,
  classifyToolCall: grokClassifyToolCall
};
var grokModelMetaSchema = z42.object({
  totalContextTokens: z42.number().int().positive()
}).passthrough();
var grokPromptMetaSchema = z42.object({
  inputTokens: z42.number().int().nonnegative().optional(),
  totalTokens: z42.number().int().nonnegative().optional(),
  usage: z42.object({
    inputTokens: z42.number().int().nonnegative().optional(),
    totalTokens: z42.number().int().nonnegative().optional()
  }).passthrough().optional()
}).passthrough();
var grokPromptResultSchema = z42.object({
  _meta: grokPromptMetaSchema.optional()
}).passthrough();
var grokSessionModelSchema = z42.object({
  modelId: z42.string(),
  _meta: grokModelMetaSchema.optional()
}).passthrough();
var grokSessionModelsSchema = z42.object({
  currentModelId: z42.string().optional(),
  availableModels: z42.array(grokSessionModelSchema).optional()
}).passthrough();
function grokContextWindowSizeFromSessionModels(models) {
  const parsed = grokSessionModelsSchema.safeParse(models);
  if (!parsed.success) {
    return void 0;
  }
  const available = parsed.data.availableModels ?? [];
  const currentId = parsed.data.currentModelId;
  const ordered = [
    ...currentId === void 0 ? [] : available.filter((model) => model.modelId === currentId),
    ...available
  ];
  for (const model of ordered) {
    if (model._meta !== void 0) {
      return model._meta.totalContextTokens;
    }
  }
  return void 0;
}
function grokContextUsageFromPromptResult(result) {
  const parsed = grokPromptResultSchema.safeParse(result);
  if (!parsed.success) {
    return void 0;
  }
  const meta = parsed.data._meta;
  const used = meta?.usage?.inputTokens ?? meta?.inputTokens ?? meta?.usage?.totalTokens ?? meta?.totalTokens;
  return used === void 0 ? void 0 : { used };
}
var CURSOR_TASK_TOOL = "task";
var cursorTaskRawInputSchema = z42.object({ _toolName: z42.string().optional() }).passthrough();
var CURSOR_TASK_METHOD = "cursor/task";
var cursorTaskParamsSchema = z42.object({
  toolCallId: z42.string(),
  description: z42.string().optional(),
  prompt: z42.string().optional(),
  agentId: z42.string().optional(),
  model: z42.string().optional()
}).passthrough();
function cursorClassifyToolCall(event) {
  const parsed = cursorTaskRawInputSchema.safeParse(event.rawInput);
  if (!parsed.success || parsed.data._toolName !== CURSOR_TASK_TOOL) {
    return void 0;
  }
  const label = event.title ?? "Subagent task";
  const shape = {
    type: "delegation",
    childRef: event.toolCallId,
    label,
    background: false
  };
  return {
    item: shape,
    presentation: delegationPresentation({ label })
  };
}
function cursorHandleClientRequest(method, params) {
  if (method !== CURSOR_TASK_METHOD) {
    return void 0;
  }
  const parsed = cursorTaskParamsSchema.safeParse(params);
  if (!parsed.success) {
    return { result: {} };
  }
  const task = parsed.data;
  const label = task.description ?? task.prompt;
  if (label === void 0) {
    return { result: {} };
  }
  return {
    result: {},
    delegation: {
      toolCallId: task.toolCallId,
      childRef: task.agentId ?? task.toolCallId,
      label,
      ...task.model === void 0 ? {} : { detail: `model ${task.model}` }
    }
  };
}
var CURSOR_ACP_DIALECT = {
  id: "cursor",
  classifyToolCall: cursorClassifyToolCall,
  handleClientRequest: cursorHandleClientRequest,
  maintenance: CURSOR_ACP_MAINTENANCE
};
var ompBashRawInputSchema = z42.object({
  command: z42.string(),
  async: z42.boolean().optional()
}).passthrough();
var ompBashRawOutputSchema = commandRawOutputSchema.extend({
  content: z42.array(
    z42.object({
      type: z42.literal("text"),
      text: z42.string()
    }).passthrough()
  ),
  details: z42.object({
    exitCode: z42.number().int().optional(),
    wallTimeMs: z42.number().nonnegative().optional(),
    timedOut: z42.boolean().optional(),
    signal: z42.unknown().optional(),
    async: z42.unknown().optional()
  }).passthrough()
});
function stripOmpTrailingNotice(text, notice) {
  const suffix = `

${notice}`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length) : text;
}
function ompCommandResult(event) {
  if (event.kind !== "execute") {
    return void 0;
  }
  const parsedInput = ompBashRawInputSchema.safeParse(event.rawInput);
  const parsedOutput = ompBashRawOutputSchema.safeParse(event.rawOutput);
  if (!parsedInput.success || parsedInput.data.command.trim().length === 0 || !parsedOutput.success) {
    return void 0;
  }
  const rawOutput = parsedOutput.data;
  const details = rawOutput.details;
  const hasGenericCommandResult = rawOutput.exitCode !== void 0 || rawOutput.exit_code !== void 0 || rawOutput.stdout !== void 0 || rawOutput.stderr !== void 0 || rawOutput.output_for_prompt !== void 0 || rawOutput.signal !== void 0 && rawOutput.signal !== null || rawOutput.timed_out === true;
  if (parsedInput.data.async === true || details.async !== void 0 || hasGenericCommandResult) {
    return void 0;
  }
  if (details.exitCode === void 0 && details.wallTimeMs === void 0) {
    return void 0;
  }
  let output = rawOutput.content.map((block) => block.text).join("\n");
  if (details.exitCode !== void 0) {
    output = stripOmpTrailingNotice(
      output,
      `Command exited with code ${String(details.exitCode)}`
    );
  }
  if (details.wallTimeMs !== void 0) {
    output = stripOmpTrailingNotice(
      output,
      `Wall time: ${(details.wallTimeMs / 1e3).toFixed(2)} seconds`
    );
  }
  const isCompletedForegroundBash = event.status === "completed" && details.timedOut !== true && (details.signal === void 0 || details.signal === null);
  const exitCode = details.exitCode ?? (isCompletedForegroundBash ? 0 : void 0);
  return {
    ...exitCode === void 0 ? {} : { exitCode },
    ...output.length === 0 ? {} : { output }
  };
}
var OMP_COMPACTION_FAILURE_PATTERN = /\bcompaction failed\b/i;
var OMP_COMPACTION_NOOP_PATTERN = /\b(?:nothing to compact|already compacted)\b/i;
function compactionOutcomeForEndTurn(dialect, agentMessage) {
  if (dialect.id !== "omp") {
    return { status: "completed" };
  }
  const text = agentMessage.trim();
  if (!OMP_COMPACTION_FAILURE_PATTERN.test(text)) {
    return { status: "completed" };
  }
  return OMP_COMPACTION_NOOP_PATTERN.test(text) ? { status: "skipped", detail: text } : { status: "failed", error: text };
}
var OMP_ACP_DIALECT = {
  id: "omp",
  commandResult: ompCommandResult
};
var openCodeCommandRawOutputSchema = z42.object({
  output: z42.unknown().optional(),
  metadata: z42.object({
    exit: z42.number().int().nullable().optional(),
    output: z42.string().optional()
  }).passthrough().optional()
}).passthrough();
function normalizeOpenCodeCommandEvent(event) {
  const parsed = openCodeCommandRawOutputSchema.safeParse(event.rawOutput);
  if (!parsed.success) {
    return event;
  }
  const rawOutput = parsed.data;
  const output = typeof rawOutput.output === "string" ? rawOutput.output : rawOutput.metadata?.output;
  const hasSharedOutput = rawOutput["stdout"] !== void 0 || rawOutput["stderr"] !== void 0 || rawOutput["output_for_prompt"] !== void 0;
  const hasSharedExitCode = rawOutput["exitCode"] !== void 0 || rawOutput["exit_code"] !== void 0;
  const exitCode = rawOutput.metadata?.exit ?? void 0;
  if ((output === void 0 || hasSharedOutput) && (exitCode === void 0 || hasSharedExitCode)) {
    return event;
  }
  return {
    ...event,
    rawOutput: {
      ...rawOutput,
      ...output === void 0 || hasSharedOutput ? {} : { stdout: output },
      ...exitCode === void 0 || hasSharedExitCode ? {} : { exitCode }
    }
  };
}
var OPENCODE_ACP_DIALECT = {
  id: "opencode",
  normalizeCommandEvent: normalizeOpenCodeCommandEvent
};
var DIALECTS_BY_ID = /* @__PURE__ */ new Map([
  [CURSOR_ACP_DIALECT.id, CURSOR_ACP_DIALECT],
  [GROK_ACP_DIALECT.id, GROK_ACP_DIALECT],
  [OMP_ACP_DIALECT.id, OMP_ACP_DIALECT],
  [OPENCODE_ACP_DIALECT.id, OPENCODE_ACP_DIALECT]
]);
var DIALECT_IDS_BY_COMMAND = {
  "cursor-agent": CURSOR_ACP_DIALECT.id,
  grok: GROK_ACP_DIALECT.id,
  omp: OMP_ACP_DIALECT.id,
  opencode: OPENCODE_ACP_DIALECT.id
};
function resolveAcpDialect(launch) {
  if (launch.dialectId !== void 0) {
    return DIALECTS_BY_ID.get(launch.dialectId) ?? GENERIC_ACP_DIALECT;
  }
  const byCommand = DIALECT_IDS_BY_COMMAND[basename(launch.command)];
  return byCommand === void 0 ? GENERIC_ACP_DIALECT : DIALECTS_BY_ID.get(byCommand) ?? GENERIC_ACP_DIALECT;
}

// ../provider-bridge-acp/src/visibility.ts
var NORMALIZED_ACP_METHODS = /* @__PURE__ */ new Set([
  "thread/identity",
  "error",
  ACP_TURN_STARTED_METHOD,
  ACP_TURN_COMPLETED_METHOD,
  ACP_FS_WRITE_METHOD,
  ACP_WARNING_METHOD
]);
var NORMALIZED_ACP_UPDATE_KINDS = /* @__PURE__ */ new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "usage_update"
]);
var NOISE_ACP_UPDATE_KINDS = /* @__PURE__ */ new Set([
  "user_message_chunk",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update"
]);
function parseAcpRawEvent(event) {
  if (event.method !== ACP_UPDATE_METHOD) {
    return { kind: "method", method: event.method };
  }
  if (!isRecord(event.params)) {
    return { kind: "update/unknown" };
  }
  const update = event.params["update"];
  const updateKind = isRecord(update) ? getStringProperty(update, "sessionUpdate") : void 0;
  if (!updateKind) {
    return { kind: "update/unknown" };
  }
  return { kind: "update", updateKind };
}
function describeParsedAcpRawEvent(event) {
  switch (event.kind) {
    case "method":
      return {
        kind: event.method,
        coverage: NORMALIZED_ACP_METHODS.has(event.method) ? "normalized" : "unknown"
      };
    case "update":
      if (NORMALIZED_ACP_UPDATE_KINDS.has(event.updateKind)) {
        return {
          kind: `acp/update:${event.updateKind}`,
          coverage: "normalized"
        };
      }
      if (NOISE_ACP_UPDATE_KINDS.has(event.updateKind)) {
        return { kind: `acp/update:${event.updateKind}`, coverage: "noise" };
      }
      return { kind: `acp/update:${event.updateKind}`, coverage: "unknown" };
    case "update/unknown":
      return { kind: "acp/update", coverage: "unknown" };
  }
}
var acpVisibilityMetadata = createProviderVisibilityMetadata({
  parseRawEvent: parseAcpRawEvent,
  describeParsedRawEvent: describeParsedAcpRawEvent
});

// ../provider-bridge-acp/src/delta-translation.ts
var ASSISTANT_STREAM_KEY = "assistant";
var THOUGHT_STREAM_KEY = "thought";
var ACP_PLAN_STEP_STATUS_BY_ENTRY_STATUS = {
  pending: "pending",
  in_progress: "active",
  completed: "completed"
};
var PLAN_STEPS_CHANNEL = "planSteps";
function isTerminalAcpStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}
function mapAcpToolCallStatus(status) {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "interrupted";
    default:
      return "pending";
  }
}
function mergeAcpToolCallEvents(started, update) {
  if (!started) {
    return update;
  }
  const { rawKind: startedRawKind, ...startedRest } = started;
  const kindFields = update.kind !== void 0 ? {
    kind: update.kind,
    ...update.rawKind !== void 0 ? { rawKind: update.rawKind } : {}
  } : startedRawKind !== void 0 ? { rawKind: startedRawKind } : {};
  return {
    ...startedRest,
    ...kindFields,
    ...update.title !== void 0 ? { title: update.title } : {},
    ...update.name !== void 0 ? { name: update.name } : {},
    ...update.status !== void 0 ? { status: update.status } : {},
    ...update.content !== void 0 ? { content: update.content } : {},
    ...update.locations !== void 0 ? { locations: update.locations } : {},
    ...update.rawInput !== void 0 ? { rawInput: update.rawInput } : {},
    ...update.rawOutput !== void 0 ? { rawOutput: update.rawOutput } : {}
  };
}
function createAcpDeltaTranslator(options = {}) {
  const dialect = options.dialect ?? GENERIC_ACP_DIALECT;
  const pathOptions = { cwd: options.cwd };
  const mergedToolCalls = /* @__PURE__ */ new Map();
  let injectedToolsByName = /* @__PURE__ */ new Map();
  const injectedToolBindings = /* @__PURE__ */ new Map();
  const pendingInjectedCalls = /* @__PURE__ */ new Map();
  function callKey(context, toolCallId) {
    return `${context?.threadId ?? ""} ${toolCallId}`;
  }
  function threadCallEntries(context) {
    const prefix = `${context?.threadId ?? ""} `;
    return [...mergedToolCalls.entries()].filter(
      ([key]) => key.startsWith(prefix)
    );
  }
  function withDialectIdentity(event) {
    if (dialect.toolIdentity === void 0) {
      return event;
    }
    const identity3 = dialect.toolIdentity(event);
    if (identity3 === void 0) {
      return event;
    }
    return {
      ...event,
      ...event.kind === void 0 && identity3.kind !== void 0 ? { kind: identity3.kind } : {},
      ...event.name === void 0 && identity3.name !== void 0 ? { name: identity3.name } : {}
    };
  }
  function clearThreadCalls(context) {
    for (const [key] of threadCallEntries(context)) {
      mergedToolCalls.delete(key);
      injectedToolBindings.delete(key);
    }
    pendingInjectedCalls.delete(context?.threadId ?? "");
  }
  function configureInjectedTools(tools) {
    injectedToolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }
  function injectedToolNamedBy(event) {
    const title = event.title;
    if (title === void 0 || injectedToolsByName.size === 0) {
      return void 0;
    }
    for (const tool of injectedToolsByName.values()) {
      if (title.includes(tool.name)) {
        return tool;
      }
    }
    return void 0;
  }
  function bindAnnouncedCall(context, event) {
    if (!isInjectedToolCandidate(event)) {
      return void 0;
    }
    const named = injectedToolNamedBy(event);
    if (named !== void 0) {
      return named;
    }
    return pendingInjectedCalls.get(context?.threadId ?? "")?.shift();
  }
  function noteInjectedToolCall(threadId, toolName) {
    const tool = injectedToolsByName.get(toolName) ?? { name: toolName };
    const candidates = threadCallEntries({ threadId }).filter(
      ([key, open]) => !injectedToolBindings.has(key) && isInjectedToolCandidate(open.event)
    );
    const chosen = candidates.find(([, open]) => open.event.title?.includes(tool.name)) ?? candidates.find(([, open]) => /\bmcp\b/i.test(open.event.title ?? "")) ?? candidates[0];
    if (chosen !== void 0) {
      injectedToolBindings.set(chosen[0], tool);
      return;
    }
    const queue = pendingInjectedCalls.get(threadId) ?? [];
    queue.push(tool);
    pendingInjectedCalls.set(threadId, queue);
  }
  function classifyCall(context, event) {
    const injected = injectedToolBindings.get(
      callKey(context, event.toolCallId)
    );
    if (injected === void 0) {
      const dialectShape = dialect.classifyToolCall?.(event);
      if (dialectShape !== void 0) {
        return dialectShape;
      }
    }
    return classifyAcpToolCall2(event, injected, pathOptions);
  }
  function withClientFileWrites(event, writes) {
    if (writes.length === 0) {
      return event;
    }
    const paths = new Set(
      writes.map((write) => resolveAcpToolCallPath(write.path, pathOptions))
    );
    return {
      ...event,
      content: [
        ...(event.content ?? []).filter(
          (entry) => entry.type !== "diff" || !paths.has(resolveAcpToolCallPath(entry.path, pathOptions))
        ),
        ...writes
      ]
    };
  }
  function mergeFsWriteIntoOpenToolCall(context, write) {
    const writePath = resolveAcpToolCallPath(write.path, pathOptions);
    const fileChangeCalls = threadCallEntries(context).flatMap(
      ([key, open]) => {
        if (open.openedType !== "fileChange") {
          return [];
        }
        const classified = classifyCall(context, open.event);
        return classified.item.type === "fileChange" ? [
          {
            key,
            open,
            paths: classified.item.changes.map((change) => change.path)
          }
        ] : [];
      }
    );
    const exactMatches = fileChangeCalls.filter(
      ({ paths }) => paths.includes(writePath)
    );
    const pathPendingMatches = fileChangeCalls.filter(
      ({ paths }) => paths.length === 0
    );
    const matching = exactMatches.length === 1 ? exactMatches[0] : exactMatches.length === 0 && pathPendingMatches.length === 1 ? pathPendingMatches[0] : void 0;
    if (matching === void 0) {
      return false;
    }
    const previous = matching.open.clientFileWrites?.find(
      (entry) => resolveAcpToolCallPath(entry.path, pathOptions) === writePath
    );
    const oldText = previous === void 0 ? write.oldText : previous.oldText;
    const diff = {
      type: "diff",
      path: write.path,
      ...oldText === void 0 ? {} : { oldText },
      newText: write.content
    };
    const clientFileWrites = [
      ...(matching.open.clientFileWrites ?? []).filter(
        (entry) => resolveAcpToolCallPath(entry.path, pathOptions) !== writePath
      ),
      diff
    ];
    mergedToolCalls.set(matching.key, {
      ...matching.open,
      clientFileWrites,
      event: withClientFileWrites(matching.open.event, clientFileWrites)
    });
    return true;
  }
  function toRawEvent(rawEvent) {
    const parsed = providerRawEventSchema.safeParse(rawEvent);
    if (parsed.success) {
      return parsed.data;
    }
    return {
      jsonrpc: "2.0",
      ...rawEvent.id !== void 0 ? { id: rawEvent.id } : {},
      method: rawEvent.method,
      params: {
        serializationError: "Provider raw event params were not JSON-serializable."
      }
    };
  }
  function noTurnFallbackFor(rawEvent) {
    return {
      raw: toRawEvent(rawEvent),
      rawType: acpVisibilityMetadata.describeRawEvent(rawEvent).kind
    };
  }
  function updateEnvelope(context, update) {
    return {
      jsonrpc: "2.0",
      method: ACP_UPDATE_METHOD,
      params: {
        ...context?.threadId ? { threadId: context.threadId } : {},
        update
      }
    };
  }
  function suppressedUnhandled(rawEvent) {
    const fallback = noTurnFallbackFor(rawEvent);
    return [
      {
        kind: "unhandled",
        raw: fallback.raw,
        rawType: fallback.rawType,
        vouchedTurn: false,
        onlyIfNoTurn: true
      }
    ];
  }
  function unhandledDeltas(rawEvent) {
    const description = acpVisibilityMetadata.describeRawEvent(rawEvent);
    if (description.coverage !== "unknown") {
      return [];
    }
    return [
      {
        kind: "unhandled",
        raw: toRawEvent(rawEvent),
        rawType: description.kind,
        vouchedTurn: true
      }
    ];
  }
  function closeThoughtStream() {
    return {
      kind: "item.textClose",
      key: { channel: THOUGHT_STREAM_KEY },
      channel: "reasoningText"
    };
  }
  function closeAssistantStream() {
    return {
      kind: "item.textClose",
      key: { channel: ASSISTANT_STREAM_KEY },
      channel: "agentMessage"
    };
  }
  function withDelegationReport(classified, report) {
    if (report === void 0 || classified.item.type !== "delegation") {
      return classified;
    }
    return {
      item: {
        ...classified.item,
        childRef: report.childRef,
        label: report.label
      },
      presentation: delegationPresentation({
        label: report.label,
        ...report.detail === void 0 ? {} : { detail: report.detail }
      })
    };
  }
  function withPermissionTitle(classified, permissionTitle) {
    const title = permissionTitle === void 0 ? void 0 : presentationTitle(permissionTitle);
    return title === void 0 ? classified : {
      item: classified.item,
      presentation: { ...classified.presentation, title }
    };
  }
  function toolCallClose(args) {
    const classified = withPermissionTitle(
      withDelegationReport(
        classifyCall(args.context, args.event),
        args.delegation
      ),
      args.permissionTitle
    );
    injectedToolBindings.delete(callKey(args.context, args.event.toolCallId));
    const closeFields = classified.item.type === "command" ? commandCloseFields(args.event, args.status) : genericCloseFields(args.event);
    return {
      kind: "item.close",
      key: {
        providerItemId: args.event.toolCallId
      },
      status: args.status,
      ...closeFields,
      item: classified.item,
      presentation: classified.presentation,
      ...args.noTurnFallback ? { noTurnFallback: args.noTurnFallback } : {}
    };
  }
  function commandCloseFields(event, status) {
    const normalizedEvent = dialect.normalizeCommandEvent?.(event) ?? event;
    const result = dialect.commandResult?.(normalizedEvent) ?? extractAcpCommandResult(normalizedEvent);
    const exitCode = result.exitCode ?? (status === "failed" ? 1 : void 0);
    return {
      ...result.output === void 0 ? {} : { aggregatedOutput: result.output, resultText: result.output },
      ...exitCode === void 0 ? {} : { exitCode }
    };
  }
  function genericCloseFields(event) {
    const outputText = extractAcpToolCallOutputText(event);
    return outputText === void 0 ? {} : { resultText: outputText };
  }
  function drainOpenToolCalls(context, status) {
    const deltas = [];
    for (const [key, open] of threadCallEntries(context)) {
      mergedToolCalls.delete(key);
      deltas.push(
        toolCallClose({
          context,
          event: open.event,
          status,
          permissionTitle: open.permissionTitle,
          delegation: open.delegation
        })
      );
    }
    return deltas;
  }
  function flushOpenTurnWork(context, status) {
    return [
      closeThoughtStream(),
      closeAssistantStream(),
      ...drainOpenToolCalls(context, status)
    ];
  }
  function translateUpdate(update, context) {
    const rawEvent = updateEnvelope(context, update);
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const parsed = acpAgentMessageChunkUpdateSchema.safeParse(update);
        const text = parsed.success ? extractAcpContentText(parsed.data.content) : void 0;
        if (text === void 0) {
          return suppressedUnhandled(rawEvent);
        }
        return [
          closeThoughtStream(),
          {
            kind: "item.textDelta",
            key: { channel: ASSISTANT_STREAM_KEY },
            channel: "agentMessage",
            text,
            noTurnFallback: noTurnFallbackFor(rawEvent)
          }
        ];
      }
      case "agent_thought_chunk": {
        const parsed = acpAgentThoughtChunkUpdateSchema.safeParse(update);
        const text = parsed.success ? extractAcpContentText(parsed.data.content) : void 0;
        if (text === void 0) {
          return suppressedUnhandled(rawEvent);
        }
        return [
          {
            kind: "item.textDelta",
            key: { channel: THOUGHT_STREAM_KEY },
            channel: "reasoningText",
            text,
            noTurnFallback: noTurnFallbackFor(rawEvent)
          }
        ];
      }
      case "tool_call": {
        const parsed = acpToolCallUpdateEventSchema.safeParse(update);
        if (!parsed.success) {
          return suppressedUnhandled(rawEvent);
        }
        const event = withDialectIdentity(parsed.data);
        const flush = [closeThoughtStream(), closeAssistantStream()];
        const announcedKey = callKey(context, event.toolCallId);
        const bound = bindAnnouncedCall(context, event);
        if (bound !== void 0) {
          injectedToolBindings.set(announcedKey, bound);
        }
        if (isTerminalAcpStatus(event.status)) {
          return [
            ...flush,
            toolCallClose({
              context,
              event,
              status: mapAcpToolCallStatus(event.status),
              noTurnFallback: noTurnFallbackFor(rawEvent)
            })
          ];
        }
        const classified = classifyCall(context, event);
        mergedToolCalls.set(announcedKey, {
          event,
          openedType: classified.item.type
        });
        return [
          ...flush,
          {
            kind: "item.open",
            key: {
              providerItemId: event.toolCallId
            },
            item: classified.item,
            presentation: classified.presentation,
            noTurnFallback: noTurnFallbackFor(rawEvent)
          }
        ];
      }
      case "tool_call_update": {
        const parsed = acpToolCallUpdateEventSchema.safeParse(update);
        if (!parsed.success) {
          return suppressedUnhandled(rawEvent);
        }
        const event = withDialectIdentity(parsed.data);
        const key = callKey(context, event.toolCallId);
        const open = mergedToolCalls.get(key);
        const merged = withClientFileWrites(
          mergeAcpToolCallEvents(open?.event, event),
          open?.clientFileWrites ?? []
        );
        if (isTerminalAcpStatus(merged.status)) {
          mergedToolCalls.delete(key);
          return [
            toolCallClose({
              context,
              event: merged,
              status: mapAcpToolCallStatus(merged.status),
              permissionTitle: open?.permissionTitle,
              delegation: open?.delegation,
              noTurnFallback: noTurnFallbackFor(rawEvent)
            })
          ];
        }
        const mergedType = classifyCall(context, merged).item.type;
        mergedToolCalls.set(key, {
          event: merged,
          openedType: open?.openedType ?? mergedType,
          ...open?.permissionTitle === void 0 ? {} : { permissionTitle: open.permissionTitle },
          ...open?.delegation === void 0 ? {} : { delegation: open.delegation },
          ...open?.clientFileWrites === void 0 ? {} : { clientFileWrites: open.clientFileWrites }
        });
        if (event.status === "in_progress" && mergedType === "command" && open?.openedType === "command") {
          const normalizedEvent = dialect.normalizeCommandEvent?.(event) ?? event;
          const streamed = extractAcpStreamedCommandOutput(normalizedEvent);
          return streamed === void 0 ? suppressedUnhandled(rawEvent) : [
            {
              kind: "command.outputSnapshot",
              key: { providerItemId: event.toolCallId },
              text: streamed
            }
          ];
        }
        const progressText = extractAcpToolCallOutputText(event);
        if (progressText === void 0) {
          return suppressedUnhandled(rawEvent);
        }
        if (mergedType !== "command" && mergedType !== "fileChange") {
          return [
            {
              kind: "item.progress",
              key: {
                providerItemId: event.toolCallId
              },
              message: progressText,
              noTurnFallback: noTurnFallbackFor(rawEvent)
            }
          ];
        }
        return suppressedUnhandled(rawEvent);
      }
      case "plan": {
        const parsed = acpPlanUpdateSchema.safeParse(update);
        if (!parsed.success) {
          return suppressedUnhandled(rawEvent);
        }
        const steps = parsed.data.entries.map(
          (entry) => ({
            step: entry.content,
            ...entry.status ? { status: ACP_PLAN_STEP_STATUS_BY_ENTRY_STATUS[entry.status] } : {}
          })
        );
        return [
          {
            kind: "item.close",
            key: { channel: PLAN_STEPS_CHANNEL },
            status: "completed",
            item: { type: "planSteps", steps },
            presentation: planStepsPresentation(steps),
            noTurnFallback: noTurnFallbackFor(rawEvent)
          }
        ];
      }
      case "usage_update": {
        const parsed = acpUsageUpdateSchema.safeParse(update);
        if (!parsed.success) {
          return [];
        }
        return [
          {
            kind: "contextWindow",
            used: parsed.data.used,
            size: parsed.data.size,
            estimated: false,
            attach: "open"
          }
        ];
      }
      default:
        return unhandledDeltas(rawEvent);
    }
  }
  function turnStatusForStopReason(stopReason) {
    return stopReason === "end_turn" ? "completed" : stopReason === "cancelled" ? "interrupted" : "failed";
  }
  function itemStatusForTurnStatus(status) {
    return status === "completed" ? "completed" : status === "interrupted" ? "interrupted" : "failed";
  }
  function translateTurnCompleted(stopReason, context) {
    const status = turnStatusForStopReason(stopReason);
    return [
      ...flushOpenTurnWork(context, itemStatusForTurnStatus(status)),
      {
        kind: "turn.boundary",
        status,
        ...status === "failed" ? { error: { message: `Agent stopped the turn: ${stopReason}` } } : {},
        claimIfIdle: true
      }
    ];
  }
  function translateAcpEvent(event, context) {
    const errorEnvelope = errorEnvelopeSchema.safeParse(event);
    if (errorEnvelope.success) {
      clearThreadCalls(context);
      return [
        {
          kind: "provider.error",
          message: "Provider error",
          detail: errorEnvelope.data.params?.message ?? "unknown error",
          settlesTurn: true
        }
      ];
    }
    const envelope = jsonRpcEnvelopeSchema.safeParse(event);
    if (!envelope.success) {
      return [];
    }
    switch (envelope.data.method) {
      case ACP_TURN_STARTED_METHOD: {
        const params = acpTurnStartedNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        clearThreadCalls(context);
        return [{ kind: "turn.open" }];
      }
      case ACP_TURN_COMPLETED_METHOD: {
        const params = acpTurnCompletedNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        return translateTurnCompleted(params.data.stopReason, context);
      }
      case ACP_COMPACTION_STARTED_METHOD: {
        const params = acpTurnStartedNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        clearThreadCalls(context);
        return [
          { kind: "turn.open" },
          {
            kind: "item.open",
            key: { channel: "compaction" },
            item: { type: "compaction" },
            presentation: COMPACTION_PRESENTATION
          }
        ];
      }
      case ACP_COMPACTION_COMPLETED_METHOD: {
        const params = acpCompactionCompletedNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        const status = params.data.status;
        const turnStatus = status === "skipped" ? "completed" : status;
        return [
          ...flushOpenTurnWork(context, itemStatusForTurnStatus(turnStatus)),
          ...status === "completed" ? [{ kind: "context.compacted" }] : [],
          ...status === "skipped" ? [
            {
              kind: "provider.warning",
              category: "compaction-skipped",
              summary: "Context compaction skipped",
              details: params.data.detail,
              vouchedTurn: true
            }
          ] : [],
          {
            kind: "turn.boundary",
            status: turnStatus,
            ...status === "failed" ? { error: { message: params.data.error } } : {}
          }
        ];
      }
      case ACP_UPDATE_METHOD: {
        const params = acpUpdateNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        return translateUpdate(params.data.update, context);
      }
      case ACP_FS_WRITE_METHOD: {
        const params = acpFsWriteNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        if (mergeFsWriteIntoOpenToolCall(context, params.data)) {
          return [];
        }
        const rawEvent = {
          jsonrpc: "2.0",
          method: ACP_FS_WRITE_METHOD,
          params: params.data
        };
        return [
          {
            kind: "item.close",
            key: { channel: "fs-write" },
            status: "completed",
            item: {
              type: "fileChange",
              changes: [
                {
                  path: params.data.path,
                  kind: params.data.kind,
                  ...params.data.oldText === void 0 ? {} : { oldText: params.data.oldText },
                  newText: params.data.content
                }
              ]
            },
            presentation: fileChangePresentation({
              verb: params.data.kind,
              paths: [params.data.path]
            }),
            noTurnFallback: noTurnFallbackFor(rawEvent)
          }
        ];
      }
      case ACP_WARNING_METHOD: {
        const params = acpWarningNotificationParamsSchema.safeParse(
          envelope.data.params
        );
        if (!params.success) {
          return [];
        }
        return [
          {
            kind: "provider.warning",
            summary: params.data.summary,
            ...params.data.details ? { details: params.data.details } : {},
            vouchedTurn: true
          }
        ];
      }
      default:
        return unhandledDeltas({
          jsonrpc: "2.0",
          method: envelope.data.method,
          ...envelope.data.params ? { params: envelope.data.params } : {}
        });
    }
  }
  function notePermissionToolCall(threadId, toolCall) {
    const context = { threadId };
    const ownKey = callKey(context, toolCall.toolCallId);
    let boundKey = mergedToolCalls.has(ownKey) ? ownKey : void 0;
    if (boundKey === void 0) {
      const sameKind = threadCallEntries(context).filter(
        ([, open2]) => toolCall.kind !== void 0 && open2.event.kind === toolCall.kind
      );
      boundKey = sameKind.length === 1 ? sameKind[0]?.[0] : void 0;
    }
    const open = boundKey === void 0 ? void 0 : mergedToolCalls.get(boundKey);
    if (boundKey === void 0 || open === void 0) {
      return { toolCallId: toolCall.toolCallId, event: void 0 };
    }
    if (classifyCall(context, open.event).item.type !== "tool") {
      return { toolCallId: open.event.toolCallId, event: open.event };
    }
    const kind = toolCall.kind !== void 0 && (toolCall.kind !== "other" || open.event.kind === void 0) ? toolCall.kind : void 0;
    const merged = mergeAcpToolCallEvents(open.event, {
      sessionUpdate: "tool_call_update",
      toolCallId: open.event.toolCallId,
      ...toolCall.title !== void 0 ? { title: toolCall.title } : {},
      ...kind !== void 0 ? { kind } : {},
      ...kind === "other" && toolCall.rawKind !== void 0 ? { rawKind: toolCall.rawKind } : {},
      ...toolCall.locations !== void 0 ? { locations: toolCall.locations } : {},
      ...toolCall.rawInput !== void 0 ? { rawInput: toolCall.rawInput } : {},
      ...toolCall.rawOutput !== void 0 ? { rawOutput: toolCall.rawOutput } : {}
    });
    if (classifyCall(context, merged).item.type === open.openedType) {
      mergedToolCalls.set(boundKey, { ...open, event: merged });
      return { toolCallId: merged.toolCallId, event: merged };
    }
    mergedToolCalls.set(boundKey, {
      ...open,
      ...toolCall.title === void 0 ? {} : { permissionTitle: toolCall.title }
    });
    return { toolCallId: open.event.toolCallId, event: merged };
  }
  function noteDelegationReport(threadId, report) {
    const context = { threadId };
    const key = callKey(context, report.toolCallId);
    const open = mergedToolCalls.get(key);
    if (open === void 0) {
      return [];
    }
    const classified = classifyCall(context, open.event);
    if (classified.item.type !== "delegation") {
      return [];
    }
    const item = {
      ...classified.item,
      childRef: report.childRef,
      label: report.label
    };
    mergedToolCalls.set(key, { ...open, delegation: report });
    return [
      {
        kind: "item.open",
        key: { providerItemId: report.toolCallId },
        item,
        presentation: delegationPresentation({
          label: report.label,
          ...report.detail === void 0 ? {} : { detail: report.detail }
        })
      }
    ];
  }
  function getInjectedToolBinding(threadId, toolCallId) {
    return injectedToolBindings.get(callKey({ threadId }, toolCallId));
  }
  return {
    configureInjectedTools,
    getInjectedToolBinding,
    noteDelegationReport,
    noteInjectedToolCall,
    notePermissionToolCall,
    translateAcpEvent
  };
}

// ../provider-bridge-acp/src/interactions.ts
function classifyAcpPermission(toolCall, options) {
  const own = classifyAcpToolCall(toolCall, options);
  if (own.kind !== "generic" || !toolCall.startedToolCall) {
    return own;
  }
  return classifyAcpToolCall(toolCall.startedToolCall, options);
}
function permissionToolCallEvent(toolCall) {
  return {
    sessionUpdate: "tool_call",
    toolCallId: toolCall.toolCallId,
    ...toolCall.title !== void 0 ? { title: toolCall.title } : {},
    ...toolCall.kind !== void 0 ? { kind: toolCall.kind } : {},
    ...toolCall.rawKind !== void 0 ? { rawKind: toolCall.rawKind } : {},
    ...toolCall.content !== void 0 ? { content: [...toolCall.content] } : {},
    ...toolCall.locations !== void 0 ? { locations: [...toolCall.locations] } : {},
    ...toolCall.rawInput !== void 0 ? { rawInput: toolCall.rawInput } : {}
  };
}
function buildToolUseSubject(toolCall, options, dialectClassify) {
  if (toolCall === void 0) {
    return {
      kind: "tool_use",
      itemId: "acp-permission",
      tool: "tool",
      presentation: toolKindPresentation({
        kind: void 0,
        title: "ACP permission request"
      })
    };
  }
  const classify = (event) => (toolCall.injectedTool === void 0 ? dialectClassify?.(event) : void 0) ?? classifyAcpToolCall2(event, toolCall.injectedTool, options);
  const own = classify(permissionToolCallEvent(toolCall));
  const described = own.presentation.title === void 0 && toolCall.startedToolCall ? classify(toolCall.startedToolCall) : own;
  return {
    kind: "tool_use",
    itemId: toolCall.toolCallId,
    tool: described.item.type === "tool" ? described.item.tool : toolCall.kind ?? toolCall.startedToolCall?.kind ?? described.item.type,
    presentation: described.presentation
  };
}
function permissionReason(toolCall) {
  if (toolCall === void 0 || toolCall.content === void 0) {
    return void 0;
  }
  return extractAcpToolCallOutputText({
    sessionUpdate: "tool_call",
    toolCallId: toolCall.toolCallId,
    content: [...toolCall.content]
  });
}
function buildAcpApprovalDecisions(options) {
  const kinds = new Set(options.map((option) => option.kind));
  const decisions = [];
  if (kinds.has("allow_once")) {
    decisions.push("allow_once");
  }
  if (kinds.has("allow_always")) {
    decisions.push("allow_for_session");
  }
  if (kinds.has("reject_once") || kinds.has("reject_always")) {
    decisions.push("deny");
  }
  return decisions.length > 0 ? decisions : ["deny"];
}
function buildAcpPermissionInteractionPayload(args) {
  const toolCall = args.toolCall;
  const pathOptions = { cwd: args.cwd };
  const availableDecisions = buildAcpApprovalDecisions(args.options);
  const reason = permissionReason(toolCall) ?? null;
  const operation = toolCall ? classifyAcpPermission(toolCall, pathOptions) : void 0;
  if (toolCall && operation?.kind === "file_change") {
    const ownPaths = extractAcpToolCallPaths(toolCall, pathOptions);
    return {
      kind: "approval",
      subject: {
        kind: "file_change",
        itemId: toolCall.toolCallId,
        writeScope: resolveAcpFileChangeWriteScope(
          ownPaths.length > 0 ? ownPaths : operation.paths
        ),
        sessionGrant: null
      },
      reason,
      availableDecisions
    };
  }
  if (toolCall && operation?.kind === "command") {
    return {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: toolCall.toolCallId,
        command: operation.command,
        cwd: null,
        actions: [{ type: "unknown", command: operation.command }],
        sessionGrant: null
      },
      reason,
      availableDecisions
    };
  }
  return {
    kind: "approval",
    subject: buildToolUseSubject(toolCall, pathOptions, args.classifyToolCall),
    reason,
    availableDecisions
  };
}
function resolveAcpPermissionDecision(args) {
  if (!isApprovalPendingInteractionPayload(args.payload) || !isApprovalPendingInteractionResolution(args.resolution)) {
    return null;
  }
  return { decision: args.resolution.decision };
}

// ../provider-bridge-acp/src/session-params.ts
import path12 from "node:path";

// ../provider-bridge-acp/src/bridge/model-catalog.ts
var ACP_NATIVE_REASONING_EFFORTS = [
  {
    reasoningEffort: "medium",
    description: "Reasoning effort is managed by the connected ACP agent."
  }
];
var MODEL_LINE_PATTERN = /^(\S+) - (.+)$/;
var BARE_PROVIDER_MODEL_LINE_PATTERN = /^\S+\/\S+$/;
var BULLETED_MODEL_LINE_PATTERN = /^[*-]\s+(\S+)(?:\s+\([^)]*\))?$/u;
var EFFORT_TOKENS = [
  ["extra-high", "xhigh"],
  ["medium", "medium"],
  ["xhigh", "xhigh"],
  ["high", "high"],
  ["low", "low"],
  ["max", "max"],
  ["none", "none"]
];
var FAST_TAIL = "-fast";
var FAST_SERVICE_TIER = "fast";
var THINKING_TOKEN = "thinking";
function parseAgentModelLines(stdout) {
  const models = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    const match = MODEL_LINE_PATTERN.exec(trimmed);
    if (!match) {
      const bulletMatch = BULLETED_MODEL_LINE_PATTERN.exec(trimmed);
      if (bulletMatch) {
        const [, id2] = bulletMatch;
        models.push({ id: id2, displayName: id2 });
        continue;
      }
      if (BARE_PROVIDER_MODEL_LINE_PATTERN.test(trimmed)) {
        models.push({ id: trimmed, displayName: trimmed });
      }
      continue;
    }
    const [, id, displayName] = match;
    models.push({ id, displayName });
  }
  return models;
}
function findAcpModelConfigOption(configOptions) {
  const options = configOptions ?? [];
  return options.find((option) => option.category === "model") ?? options.find((option) => option.id === "model");
}
function findAcpThoughtLevelConfigOption(configOptions) {
  return (configOptions ?? []).find(
    (option) => option.category === "thought_level"
  );
}
var ACP_NATIVE_REASONING_LEVEL_BY_VALUE = {
  none: "none",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  ultracode: "ultracode",
  max: "max",
  ultra: "ultra"
};
var ACP_NATIVE_REASONING_VALUE_CANDIDATES_BY_LEVEL = {
  none: ["none"],
  low: ["low", "minimal"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh"],
  ultracode: ["ultracode", "xhigh"],
  max: ["max", "xhigh"],
  ultra: ["ultra", "max"]
};
function acpNativeValueToReasoningLevel(value) {
  return value === void 0 ? void 0 : ACP_NATIVE_REASONING_LEVEL_BY_VALUE[value];
}
function acpNativeReasoningLevelToValue(level, thoughtLevelOption) {
  const candidateValues = ACP_NATIVE_REASONING_VALUE_CANDIDATES_BY_LEVEL[level];
  if (candidateValues === void 0) {
    return void 0;
  }
  const values = new Set(
    (thoughtLevelOption.options ?? []).map((o2) => o2.value)
  );
  return candidateValues.find((value) => values.has(value));
}
function buildAcpNativeReasoningSupport(thoughtLevelOption) {
  const options = thoughtLevelOption?.options ?? [];
  const seen = /* @__PURE__ */ new Set();
  const matchedValueByLevel = /* @__PURE__ */ new Map();
  const supportedReasoningEfforts = [];
  for (const option of options) {
    const level = acpNativeValueToReasoningLevel(option.value);
    if (level === void 0) {
      continue;
    }
    if (seen.has(level)) {
      const previousValue = matchedValueByLevel.get(level);
      if (previousValue !== level && option.value === level) {
        const effort = supportedReasoningEfforts.find(
          (candidate) => candidate.reasoningEffort === level
        );
        if (effort) {
          effort.description = option.name ?? option.value;
        }
        matchedValueByLevel.set(level, option.value);
      }
      continue;
    }
    seen.add(level);
    matchedValueByLevel.set(level, option.value);
    supportedReasoningEfforts.push({
      reasoningEffort: level,
      description: option.name ?? option.value
    });
  }
  supportedReasoningEfforts.sort(
    (a2, b) => compareReasoningLevels(a2.reasoningEffort, b.reasoningEffort)
  );
  if (supportedReasoningEfforts.length === 0) {
    return {
      supportedReasoningEfforts: thoughtLevelOption === void 0 ? ACP_NATIVE_REASONING_EFFORTS : [],
      defaultReasoningEffort: "medium"
    };
  }
  const currentLevel = acpNativeValueToReasoningLevel(
    thoughtLevelOption?.currentValue
  );
  const supportedLevels = supportedReasoningEfforts.map(
    (effort) => effort.reasoningEffort
  );
  return {
    supportedReasoningEfforts,
    defaultReasoningEffort: currentLevel !== void 0 && supportedLevels.includes(currentLevel) ? currentLevel : supportedReasoningEfforts[0].reasoningEffort
  };
}
function buildModelCatalogFromConfigOptions(modelOption, reasoningByModel) {
  const options = modelOption?.options ?? [];
  if (options.length === 0) {
    return [];
  }
  const currentValue = modelOption?.currentValue;
  const models = options.map((option, index) => {
    const isDefault = currentValue !== void 0 ? option.value === currentValue : index === 0;
    const reasoning = reasoningByModel?.get(option.value) ?? {
      supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
      defaultReasoningEffort: "medium"
    };
    return {
      id: option.value,
      model: option.value,
      displayName: option.name ?? option.value,
      description: "",
      supportedReasoningEfforts: reasoning.supportedReasoningEfforts,
      defaultReasoningEffort: reasoning.defaultReasoningEffort,
      isDefault
    };
  });
  return models.some((model) => model.isDefault) ? models : models.map(
    (model, index) => index === 0 ? { ...model, isDefault: true } : model
  );
}
function buildModelCatalogFromSessionModels(sessionModels) {
  const availableModels = sessionModels?.availableModels ?? [];
  if (availableModels.length === 0) {
    return [];
  }
  const currentModelId = sessionModels?.currentModelId;
  const models = availableModels.map((model, index) => {
    const isDefault = currentModelId !== void 0 ? model.modelId === currentModelId : index === 0;
    return {
      id: model.modelId,
      model: model.modelId,
      displayName: model.name ?? model.modelId,
      description: model.description ?? "",
      supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
      defaultReasoningEffort: "medium",
      isDefault
    };
  });
  return models.some((model) => model.isDefault) ? models : models.map(
    (model, index) => index === 0 ? { ...model, isDefault: true } : model
  );
}
function splitVariant(id) {
  let rest = id;
  let fast = false;
  if (rest.endsWith(FAST_TAIL)) {
    fast = true;
    rest = rest.slice(0, -FAST_TAIL.length);
  }
  let thinking = false;
  if (rest.endsWith(`-${THINKING_TOKEN}`)) {
    thinking = true;
    rest = rest.slice(0, -(THINKING_TOKEN.length + 1));
  } else if (rest.includes(`-${THINKING_TOKEN}-`)) {
    thinking = true;
    rest = rest.replace(`-${THINKING_TOKEN}-`, "-");
  }
  for (const [token, effort] of EFFORT_TOKENS) {
    if (rest.endsWith(`-${token}`)) {
      return {
        familyKey: rest.slice(0, -(token.length + 1)),
        effort,
        effortToken: token,
        fast,
        thinking
      };
    }
  }
  return {
    familyKey: rest,
    effort: "medium",
    effortToken: void 0,
    fast,
    thinking
  };
}
function agentModelFamilyId(id) {
  return splitVariant(id).familyKey;
}
var EFFORT_DISPLAY_WORDS = {
  "extra-high": "Extra High",
  medium: "Medium",
  xhigh: "Extra High",
  high: "High",
  low: "Low",
  max: "Max",
  ultra: "Ultra",
  none: "None"
};
function familyDisplayName(displayName, effortToken) {
  const word = effortToken ? EFFORT_DISPLAY_WORDS[effortToken] : void 0;
  if (!word) {
    return cleanDisplayName(displayName);
  }
  return cleanDisplayName(
    displayName.replace(new RegExp(`(^|\\s)${word}(?=\\s|$)`), "$1")
  );
}
function cleanDisplayName(name) {
  return name.replace(/\s*\((?:NO ZDR|default|current)\)/gi, "").replace(/(^|\s)(?:1M|Thinking)(?=\s|$)/g, "$1").replace(/\s{2,}/g, " ").trim();
}
function buildAgentModelCatalog(rawModels) {
  const families = /* @__PURE__ */ new Map();
  for (const raw of rawModels) {
    const { familyKey, effort, effortToken, fast, thinking } = splitVariant(
      raw.id
    );
    const members = families.get(familyKey) ?? [];
    members.push({ ...raw, effort, effortToken, fast, thinking });
    families.set(familyKey, members);
  }
  if (families.size === 0) {
    return null;
  }
  const models = [];
  const variantsByFamilyId = /* @__PURE__ */ new Map();
  const defaultEffortByFamilyId = /* @__PURE__ */ new Map();
  for (const members of families.values()) {
    const hasThinking = members.some((m) => m.thinking);
    const leveled = members.map((member) => ({
      member,
      level: member.thinking ? member.effort : hasThinking ? "none" : member.effort
    }));
    const byLevel = /* @__PURE__ */ new Map();
    const repEffortByCell = /* @__PURE__ */ new Map();
    for (const { member, level } of leveled) {
      const slot = member.fast ? "fast" : "normal";
      const tier = byLevel.get(level) ?? {};
      const cellKey = `${level}:${slot}`;
      const upgradesNoneRep = level === "none" && member.effort === "medium" && repEffortByCell.get(cellKey) !== "medium";
      if (tier[slot] === void 0 || upgradesNoneRep) {
        tier[slot] = member.id;
        repEffortByCell.set(cellKey, member.effort);
        byLevel.set(level, tier);
      }
    }
    const nonFast = leveled.filter((entry) => !entry.member.fast);
    const pool = nonFast.length > 0 ? nonFast : leveled;
    const defaultEntry = pool.find((entry) => entry.level === "medium") ?? pool.find((entry) => entry.level !== "none") ?? pool[0];
    const defaultVariant = defaultEntry.member;
    const levelsInLadderOrder = [...byLevel.keys()].sort(
      compareReasoningLevels
    );
    const nameByLevel = /* @__PURE__ */ new Map();
    for (const { member, level } of leveled) {
      if (!nameByLevel.has(level)) {
        nameByLevel.set(level, member.displayName);
      }
    }
    models.push({
      id: defaultVariant.id,
      model: defaultVariant.id,
      displayName: familyDisplayName(
        defaultVariant.displayName,
        defaultVariant.effortToken
      ),
      description: "",
      supportedReasoningEfforts: levelsInLadderOrder.map((level) => ({
        reasoningEffort: level,
        description: nameByLevel.get(level) ?? ""
      })),
      defaultReasoningEffort: defaultEntry.level,
      supportedServiceTiers: [...byLevel.values()].some(
        (tier) => tier.fast !== void 0
      ) ? [{ id: FAST_SERVICE_TIER }] : [],
      isDefault: models.length === 0
    });
    variantsByFamilyId.set(defaultVariant.id, byLevel);
    defaultEffortByFamilyId.set(defaultVariant.id, defaultEntry.level);
  }
  return {
    models,
    resolveVariant({ model, reasoningLevel, serviceTier }) {
      const byLevel = variantsByFamilyId.get(model);
      if (!byLevel) {
        return void 0;
      }
      const level = reasoningLevel ?? defaultEffortByFamilyId.get(model);
      const tier = level === void 0 ? void 0 : byLevel.get(level);
      if (!tier) {
        return void 0;
      }
      if (serviceTier === "fast" && tier.fast !== void 0) {
        return tier.fast;
      }
      return tier.normal ?? tier.fast;
    }
  };
}
function splitPrimaryModels(catalogModels, primaryModels) {
  const primaryIds = new Set(primaryModels);
  const modelsById = new Map(catalogModels.map((model) => [model.id, model]));
  const models = primaryModels.flatMap((id) => {
    const model = modelsById.get(id);
    return model ? [model] : [];
  });
  if (models.length === 0) {
    return { models: [...catalogModels], selectedOnlyModels: [] };
  }
  const selectedOnlyModels = catalogModels.filter(
    (model) => !primaryIds.has(model.id)
  );
  if (models.some((model) => model.isDefault)) {
    return {
      models,
      selectedOnlyModels: selectedOnlyModels.map(
        (model) => model.isDefault ? { ...model, isDefault: false } : model
      )
    };
  }
  return {
    models: models.map(
      (model, index) => index === 0 ? { ...model, isDefault: true } : model
    ),
    selectedOnlyModels: selectedOnlyModels.map(
      (model) => model.isDefault ? { ...model, isDefault: false } : model
    )
  };
}

// ../provider-bridge-acp/src/cursor-model-selection.ts
var CURSOR_LEGACY_FAMILY_SELECTIONS = {
  "claude-4-sonnet": { modelId: "claude-sonnet-4" },
  "claude-4.5-opus": { modelId: "claude-opus-4-5" },
  "claude-4.5-sonnet": { modelId: "claude-sonnet-4-5" },
  "claude-4.6-opus": { modelId: "claude-opus-4-6" },
  "claude-4.6-sonnet": { modelId: "claude-sonnet-4-6" },
  "gemini-3.6-flash-minimal": {
    modelId: "gemini-3.6-flash",
    reasoningLevel: "low"
  },
  "gpt-5.1-codex-max": { modelId: "gpt-5.1" }
};
function bareCursorFamilyId(model) {
  const familyId = model === "auto" ? "default" : agentModelFamilyId(model);
  return familyId.startsWith("cursor-") ? familyId.slice("cursor-".length) : familyId;
}
function cursorParameterizedSelection(model, reasoningLevel) {
  const familyId = bareCursorFamilyId(model);
  const selection = CURSOR_LEGACY_FAMILY_SELECTIONS[familyId] ?? {
    modelId: familyId
  };
  return selection.reasoningLevel !== void 0 || reasoningLevel === void 0 ? selection : { ...selection, reasoningLevel };
}
function cursorCatalogModel(model) {
  const selection = cursorParameterizedSelection(
    model.id,
    model.defaultReasoningEffort
  );
  const efforts = /* @__PURE__ */ new Map();
  for (const effort of model.supportedReasoningEfforts) {
    const level = cursorParameterizedSelection(model.id, effort.reasoningEffort).reasoningLevel ?? effort.reasoningEffort;
    if (!efforts.has(level)) {
      efforts.set(level, { ...effort, reasoningEffort: level });
    }
  }
  return {
    model: {
      ...model,
      id: selection.modelId,
      model: selection.modelId,
      supportedReasoningEfforts: [...efforts.values()].sort(
        (a2, b) => compareReasoningLevels(a2.reasoningEffort, b.reasoningEffort)
      ),
      defaultReasoningEffort: selection.reasoningLevel ?? model.defaultReasoningEffort
    },
    directFamily: bareCursorFamilyId(model.id) === selection.modelId
  };
}
function mergeSupportedServiceTiers(current, candidate) {
  if (current.supportedServiceTiers === void 0 || candidate.supportedServiceTiers === void 0) {
    return void 0;
  }
  const tiers = new Map(
    [...current.supportedServiceTiers, ...candidate.supportedServiceTiers].map(
      (tier) => [tier.id, tier]
    )
  );
  return [...tiers.values()];
}
function buildCursorParameterizedModelCatalog(models) {
  const normalized = /* @__PURE__ */ new Map();
  for (const model of models) {
    const candidate = cursorCatalogModel(model);
    const current = normalized.get(candidate.model.id);
    if (current === void 0) {
      normalized.set(candidate.model.id, candidate);
      continue;
    }
    const preferred = candidate.directFamily && !current.directFamily ? candidate : current;
    const efforts = new Map(
      preferred.model.supportedReasoningEfforts.map((effort) => [
        effort.reasoningEffort,
        effort
      ])
    );
    for (const effort of [
      ...current.model.supportedReasoningEfforts,
      ...candidate.model.supportedReasoningEfforts
    ]) {
      if (!efforts.has(effort.reasoningEffort)) {
        efforts.set(effort.reasoningEffort, effort);
      }
    }
    const serviceTiers = mergeSupportedServiceTiers(
      current.model,
      candidate.model
    );
    normalized.set(candidate.model.id, {
      model: {
        ...preferred.model,
        supportedReasoningEfforts: [...efforts.values()].sort(
          (a2, b) => compareReasoningLevels(a2.reasoningEffort, b.reasoningEffort)
        ),
        ...serviceTiers === void 0 ? {} : { supportedServiceTiers: serviceTiers },
        isDefault: current.model.isDefault || candidate.model.isDefault
      },
      directFamily: preferred.directFamily
    });
  }
  return [...normalized.values()].map((entry) => entry.model);
}

// ../provider-bridge-acp/src/session-params.ts
function sanitizeAcpSkillDescription(description) {
  const sanitized = description.replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").replace(/[<>]/gu, "").trim();
  return sanitized.length > 0 ? sanitized : "(description unavailable)";
}
function buildAcpSkillsInstructions(skillRoots) {
  if (!skillRoots || skillRoots.length === 0) {
    return void 0;
  }
  const skillLines = skillRoots.flatMap((skillRoot) => {
    return skillRoot.skills.map((skill) => {
      const skillFilePath = path12.join(
        skillRoot.skillDirectoryRootPath,
        skill.name,
        "SKILL.md"
      );
      return `- ${skill.name}: ${sanitizeAcpSkillDescription(skill.description)} (SKILL.md: ${skillFilePath})`;
    });
  });
  if (skillLines.length === 0) {
    return void 0;
  }
  return [
    "bb skills are reusable instruction folders. When the current task matches a listed skill description, read that skill's SKILL.md at the absolute path before proceeding; you may read supporting files in the same skill directory that SKILL.md references. If a listed path does not exist, the list is stale and should be ignored.",
    "",
    "Available bb skills:",
    ...skillLines
  ].join("\n");
}
function buildAcpSessionInstructions(options) {
  const baseInstructions = options.instructions?.trim();
  const skillsInstructions = buildAcpSkillsInstructions(options.skillRoots);
  const instructions = [baseInstructions, skillsInstructions].filter(
    (value) => value !== void 0 && value.length > 0
  );
  return instructions.length > 0 ? instructions.join("\n\n") : void 0;
}
function launchEnvVars(launchSpec) {
  return Object.keys(launchSpec.env).length > 0 ? { envVars: launchSpec.env } : {};
}
function buildAcpModelListCommand(launchSpec) {
  if (!launchSpec.modelCli || launchSpec.modelCli.listArgs.length === 0) {
    return void 0;
  }
  return {
    command: launchSpec.command,
    args: [...launchSpec.modelCli.listArgs],
    ...launchSpec.cwd !== void 0 ? { cwd: launchSpec.cwd } : {},
    ...launchEnvVars(launchSpec)
  };
}
function buildAcpModelDiscoveryAgentCommand(launchSpec) {
  if (buildAcpModelListCommand(launchSpec) !== void 0) {
    return void 0;
  }
  return {
    command: launchSpec.command,
    args: [...launchSpec.args],
    ...launchSpec.cwd !== void 0 ? { cwd: launchSpec.cwd } : {},
    ...launchEnvVars(launchSpec)
  };
}
function buildAcpModelListParams(launchSpec, options) {
  const primaryModels = [
    ...options.primaryModels ?? launchSpec?.modelCli?.primaryModels ?? []
  ];
  const reasoningProbePriorityModelIds = [
    ...options.reasoningProbePriorityModelIds
  ];
  if (launchSpec === null) {
    return {
      primaryModels,
      reasoningProbePriorityModelIds,
      parameterizedModelPicker: options.parameterizedModelPicker
    };
  }
  const listCommand = buildAcpModelListCommand(launchSpec);
  const agent = buildAcpModelDiscoveryAgentCommand(launchSpec);
  return {
    ...listCommand !== void 0 ? { listCommand } : {},
    ...agent !== void 0 ? { agent } : {},
    primaryModels,
    reasoningProbePriorityModelIds,
    parameterizedModelPicker: options.parameterizedModelPicker,
    ...launchSpec.reasoningCli !== void 0 ? { reasoningCli: launchSpec.reasoningCli } : {},
    ...launchSpec.nativeReasoning !== void 0 ? { nativeReasoning: launchSpec.nativeReasoning } : {}
  };
}
function buildAcpModelSelectionParams(launchSpec, options, parameterizedModelPicker, dialectId) {
  const modelSelection = buildAcpModelSelection(
    launchSpec,
    options,
    parameterizedModelPicker,
    dialectId
  );
  return {
    ...modelSelection !== void 0 ? { modelSelection } : {},
    ...launchSpec.reasoningCli !== void 0 && options.reasoningLevel !== void 0 ? { launchReasoningLevel: options.reasoningLevel } : {}
  };
}
function buildAcpModelSelection(launchSpec, options, parameterizedModelPicker, dialectId) {
  const model = options.model;
  const listCommand = buildAcpModelListCommand(launchSpec);
  if (!model || model === ACP_DEFAULT_MODEL_ID) {
    return void 0;
  }
  if (parameterizedModelPicker || !listCommand || !launchSpec.modelCli?.selectFlag) {
    const modelSelection = parameterizedModelPicker && dialectId === "cursor" ? cursorParameterizedSelection(model, options.reasoningLevel) : {
      modelId: model,
      ...options.reasoningLevel !== void 0 ? { reasoningLevel: options.reasoningLevel } : {}
    };
    return {
      ...modelSelection,
      ...parameterizedModelPicker && options.serviceTier !== void 0 ? { serviceTier: options.serviceTier } : {}
    };
  }
  return {
    listCommand,
    selectFlag: launchSpec.modelCli.selectFlag,
    model,
    ...options.reasoningLevel !== void 0 ? { reasoningLevel: options.reasoningLevel } : {},
    ...options.serviceTier === "fast" ? { serviceTier: options.serviceTier } : {}
  };
}
function buildAcpSessionParams(args) {
  const { options, launchSpec } = args;
  const instructions = buildAcpSessionInstructions(options);
  const cwd = launchSpec.cwd ?? args.cwd;
  const envVars = {
    ...launchSpec.env,
    ...options.envVars ?? {}
  };
  if (options.permissionMode === "auto") {
    throw new Error(
      `Provider "${args.providerLabel}" does not support permission mode "auto".`
    );
  }
  return {
    threadId: args.threadId,
    cwd,
    agent: {
      command: launchSpec.command,
      args: [...launchSpec.args]
    },
    ...args.dialectId === void 0 ? {} : { dialectId: args.dialectId },
    ...buildAcpModelSelectionParams(
      launchSpec,
      options,
      args.parameterizedModelPicker,
      args.dialectId
    ),
    parameterizedModelPicker: args.parameterizedModelPicker,
    ...launchSpec.reasoningCli !== void 0 ? { reasoningCli: launchSpec.reasoningCli } : {},
    ...launchSpec.nativeReasoning !== void 0 ? { nativeReasoning: launchSpec.nativeReasoning } : {},
    ...launchSpec.permissionCli !== void 0 ? { permissionCli: launchSpec.permissionCli } : {},
    permissionMode: options.permissionMode,
    workspaceWriteRoots: [cwd, ...args.additionalWorkspaceWriteRoots],
    ...Object.keys(envVars).length > 0 ? { envVars } : {},
    ...instructions ? { instructions } : {},
    ...args.dynamicTools && args.dynamicTools.length > 0 ? { dynamicTools: args.dynamicTools } : {}
  };
}

// ../provider-bridge-acp/src/bridge/agent-connection.ts
import { createInterface } from "node:readline";
var STDERR_TAIL_MAX_CHUNKS = 40;
var AcpAgentExitedError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "AcpAgentExitedError";
  }
};
var AcpAgentResponseError = class extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.name = "AcpAgentResponseError";
    this.code = code;
  }
};
function formatAgentError(error) {
  const message = error.message ?? `ACP agent returned error code ${error.code ?? "unknown"}`;
  const details = formatAgentErrorData(error.data);
  return details === void 0 ? message : `${message}: ${details}`;
}
function formatAgentErrorData(data) {
  if (data === void 0 || data === null) {
    return void 0;
  }
  if (typeof data === "string") {
    return data.trim() === "" ? void 0 : data;
  }
  if (typeof data === "object" && "details" in data && typeof data.details === "string" && data.details.trim() !== "") {
    return data.details;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return void 0;
  }
}
function parseAgentLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}
function createAcpAgentConnection(options) {
  const managed = spawnManagedProcess({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env
  });
  const { child } = managed;
  experimental_recordProviderChildIo(child, {
    threadId: options.recordThreadId
  });
  const pending = /* @__PURE__ */ new Map();
  const stderrChunks = [];
  let nextRequestId = 1;
  let exited = false;
  let stopping = false;
  let stopPromise;
  function stopAgent(gracePeriodMs = 1e3) {
    stopPromise ??= managed.stop({ gracePeriodMs }).then((result) => {
      if (result.treeTermination === "unverified") {
        stderrChunks.push(
          "ACP agent exited, but descendant cleanup could not be confirmed"
        );
      }
    });
    return stopPromise;
  }
  function rejectAllPending(error) {
    for (const [, request] of pending) {
      request.reject(error);
    }
    pending.clear();
  }
  function closeForAgentStdin(error) {
    if (exited) {
      return;
    }
    exited = true;
    const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
    const detail = `stdin closed${code}: ${error.message}`;
    rejectAllPending(
      new AcpAgentExitedError(`ACP agent "${options.command}" ${detail}`)
    );
    const reportExit = (cleanupError) => {
      const cleanupDetail = cleanupError === null ? [] : [`Agent cleanup failed: ${String(cleanupError)}`];
      options.onExit({
        code: null,
        signal: null,
        stderrTail: [...stderrChunks, detail, ...cleanupDetail].join("\n")
      });
    };
    void stopAgent(0).then(() => reportExit(null), reportExit);
  }
  function writeLine(message) {
    if (stopping) {
      return;
    }
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      closeForAgentStdin(new Error("stdin is not writable"));
      return;
    }
    stdin.write(JSON.stringify(message) + "\n");
  }
  child.stdin?.on("error", (error) => {
    if (!isClosedProcessStdinError(error)) {
      throw error;
    }
    if (stopping) {
      return;
    }
    closeForAgentStdin(error);
  });
  if (child.stdout) {
    const stdoutLines = createInterface({
      input: child.stdout,
      terminal: false
    });
    stdoutLines.on("line", (line) => {
      if (stopping) {
        return;
      }
      const message = parseAgentLine(line);
      if (!message) {
        return;
      }
      const id = message.id;
      if ((typeof id === "string" || typeof id === "number") && message.method === void 0) {
        const numericId = typeof id === "number" ? id : Number(id);
        const request = pending.get(numericId);
        if (!request) {
          return;
        }
        pending.delete(numericId);
        if (message.error) {
          request.reject(
            new AcpAgentResponseError(
              formatAgentError(message.error),
              message.error.code
            )
          );
        } else {
          request.resolve(message.result);
        }
        return;
      }
      if (typeof message.method !== "string") {
        return;
      }
      if (typeof id === "string" || typeof id === "number") {
        let settled = false;
        options.onRequest(message.method, message.params, {
          result(value) {
            if (settled) return;
            settled = true;
            writeLine({ jsonrpc: "2.0", id, result: value ?? null });
          },
          error(code, errorMessage) {
            if (settled) return;
            settled = true;
            writeLine({
              jsonrpc: "2.0",
              id,
              error: { code, message: errorMessage }
            });
          }
        });
        return;
      }
      options.onNotification(message.method, message.params);
    });
  }
  if (child.stderr) {
    const stderrLines = createInterface({
      input: child.stderr,
      terminal: false
    });
    stderrLines.on("line", (line) => {
      stderrChunks.push(line);
      if (stderrChunks.length > STDERR_TAIL_MAX_CHUNKS) {
        stderrChunks.shift();
      }
    });
  }
  child.on("error", (error) => {
    if (exited) {
      return;
    }
    exited = true;
    rejectAllPending(
      new AcpAgentExitedError(
        `Failed to launch ACP agent "${options.command}": ${error.message}`
      )
    );
    options.onExit({ code: null, signal: null, stderrTail: error.message });
  });
  child.on("exit", (code, signal) => {
    if (exited) {
      return;
    }
    exited = true;
    const stderrTail = stderrChunks.join("\n");
    rejectAllPending(
      new AcpAgentExitedError(
        `ACP agent "${options.command}" exited (code ${code ?? "null"}, signal ${signal ?? "null"})${stderrTail ? `: ${stderrTail}` : ""}`
      )
    );
    const reportExit = (cleanupError) => {
      const cleanupDetail = cleanupError === null ? [] : [`Agent cleanup failed: ${String(cleanupError)}`];
      options.onExit({
        code,
        signal,
        stderrTail: [...stderrChunks, ...cleanupDetail].join("\n")
      });
    };
    void stopAgent().then(() => reportExit(null), reportExit);
  });
  return {
    get exited() {
      return stopping || exited;
    },
    request({ method, params, resultSchema }) {
      if (stopping || exited) {
        return Promise.reject(
          new AcpAgentExitedError(
            `ACP agent "${options.command}" is not running`
          )
        );
      }
      const id = nextRequestId;
      nextRequestId += 1;
      return new Promise((resolve5, reject) => {
        pending.set(id, {
          resolve: (value) => {
            const parsed = resultSchema.safeParse(value);
            if (parsed.success) {
              resolve5(parsed.data);
            } else {
              reject(
                new Error(
                  `ACP agent returned an unexpected ${method} result: ${parsed.error.message}`
                )
              );
            }
          },
          reject
        });
        writeLine({ jsonrpc: "2.0", id, method, params });
      });
    },
    notify(method, params) {
      if (stopping || exited) {
        return;
      }
      writeLine({ jsonrpc: "2.0", method, params });
    },
    kill() {
      if (stopping || exited) return stopAgent();
      stopping = true;
      rejectAllPending(
        new AcpAgentExitedError(
          `ACP agent "${options.command}" is not running`
        )
      );
      return stopAgent();
    }
  };
}
function acpClientCapabilities(parameterizedModelPicker, fsAccess) {
  return {
    fs: { readTextFile: fsAccess, writeTextFile: fsAccess },
    terminal: false,
    ...parameterizedModelPicker === true ? { _meta: { parameterizedModelPicker: true } } : {}
  };
}
function requestAcpInitialize(connection, {
  parameterizedModelPicker,
  fsAccess
}) {
  return connection.request({
    method: "initialize",
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientInfo: { name: "bb", version: "1.0.0" },
      clientCapabilities: acpClientCapabilities(
        parameterizedModelPicker,
        fsAccess
      )
    },
    resultSchema: acpInitializeResultSchema
  });
}

// ../provider-bridge-acp/src/bridge/cursor-mcp-approval.ts
import { execFile as execFile5 } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename as basename2, dirname, join as join2, resolve as resolve3 } from "node:path";

// ../provider-bridge-acp/src/bridge/tool-proxy-mcp.ts
import { createConnection } from "node:net";
import { createInterface as createInterface2 } from "node:readline";
import { z as z43 } from "zod";
var ACP_BRIDGE_MCP_SERVER_NAME = "bb-bridge";
var ENV_HOST = "BB_ACP_DYNAMIC_TOOL_HOST";
var ENV_PORT = "BB_ACP_DYNAMIC_TOOL_PORT";
var ENV_TOKEN = "BB_ACP_DYNAMIC_TOOL_TOKEN";
var ENV_THREAD_ID = "BB_ACP_DYNAMIC_TOOL_THREAD_ID";
var ENV_TOOLS = "BB_ACP_DYNAMIC_TOOLS";
var ENV_PROGRESS_INTERVAL_MS = "BB_ACP_DYNAMIC_TOOL_PROGRESS_INTERVAL_MS";
var dynamicToolBridgeRequestSchema = z43.discriminatedUnion("kind", [
  z43.object({
    kind: z43.literal("initialized"),
    threadId: z43.string().min(1),
    token: z43.string().min(1),
    toolCount: z43.number().int().nonnegative()
  }),
  z43.object({
    kind: z43.literal("toolCall"),
    arguments: z43.record(z43.string(), z43.unknown()).default({}),
    callId: z43.string().min(1),
    threadId: z43.string().min(1),
    token: z43.string().min(1),
    tool: z43.string().min(1)
  })
]);
var bridgeToolCallResponseSchema = z43.union([
  z43.object({
    ok: z43.literal(true),
    content: z43.string(),
    contentBlocks: z43.array(
      z43.discriminatedUnion("type", [
        z43.object({ type: z43.literal("text"), text: z43.string() }),
        z43.object({
          type: z43.literal("image"),
          data: z43.string(),
          mimeType: z43.string()
        })
      ])
    ).optional(),
    images: z43.array(z43.object({ data: z43.string(), mimeType: z43.string() })).default([]),
    isError: z43.boolean().optional()
  }),
  z43.object({ ok: z43.literal(false), error: z43.string() })
]);
var jsonRpcMessageSchema = z43.object({
  id: z43.union([z43.string(), z43.number().int()]).optional(),
  method: z43.string().optional(),
  params: z43.unknown().optional()
});
var nextMcpToolCallId = 0;
var TOOL_CALL_PROGRESS_INTERVAL_MS = 15e3;
function buildAcpMcpServerConfig(args) {
  return {
    name: ACP_BRIDGE_MCP_SERVER_NAME,
    command: args.command,
    args: args.bridgeArgs,
    env: [
      ...args.runtimeEnv,
      { name: ENV_HOST, value: args.host },
      { name: ENV_PORT, value: String(args.port) },
      { name: ENV_TOKEN, value: args.token },
      { name: ENV_THREAD_ID, value: args.threadId },
      { name: ENV_TOOLS, value: JSON.stringify(args.dynamicTools) }
    ]
  };
}
function readEnvironment() {
  const port = Number(process.env[ENV_PORT]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${ENV_PORT} must be a positive integer`);
  }
  const host = process.env[ENV_HOST];
  const token = process.env[ENV_TOKEN];
  const threadId = process.env[ENV_THREAD_ID];
  const toolsJson = process.env[ENV_TOOLS];
  if (!host || !token || !threadId || !toolsJson) {
    throw new Error("Missing ACP dynamic tool MCP server environment");
  }
  const parsedTools = JSON.parse(toolsJson);
  const tools = dynamicToolSchema.array().parse(parsedTools);
  const rawProgressInterval = process.env[ENV_PROGRESS_INTERVAL_MS];
  const progressIntervalMs = rawProgressInterval !== void 0 && Number(rawProgressInterval) > 0 ? Number(rawProgressInterval) : void 0;
  return {
    host,
    port,
    progressIntervalMs,
    threadId,
    token,
    tools
  };
}
function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}
`);
}
function writeResult(id, result) {
  writeJson({ jsonrpc: "2.0", id, result });
}
function writeError(id, code, message) {
  writeJson({ jsonrpc: "2.0", id, error: { code, message } });
}
function mcpToolCallId(toolName) {
  nextMcpToolCallId += 1;
  return `acp-mcp-${toolName}-${Date.now()}-${nextMcpToolCallId}`;
}
function callBridge(env, request, signal) {
  return new Promise((resolve5, reject) => {
    const socket = createConnection({ host: env.host, port: env.port });
    const abort = () => {
      socket.destroy();
      reject(new Error("ACP dynamic tool call cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal?.removeEventListener("abort", abort));
    if (signal?.aborted) abort();
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const payload = {
        ...request,
        threadId: env.threadId,
        token: env.token
      };
      socket.write(`${JSON.stringify(payload)}
`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      socket.end();
      try {
        resolve5(bridgeToolCallResponseSchema.parse(JSON.parse(line)));
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("end", () => {
      if (!buffer.includes("\n")) {
        reject(new Error("ACP dynamic tool bridge closed without a response"));
      }
    });
  });
}
function objectParams(params) {
  return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}
function readProgressToken(params) {
  const meta = objectParams(objectParams(params)._meta).progressToken;
  return typeof meta === "string" || typeof meta === "number" ? meta : null;
}
function startProgressHeartbeat(args) {
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    writeJson({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: args.progressToken, progress }
    });
  }, args.intervalMs ?? TOOL_CALL_PROGRESS_INTERVAL_MS);
  return () => clearInterval(timer);
}
async function handleRequest(env, message, pending) {
  if (message.method === PROVIDER_TOOL_CALL_CANCELLED_METHOD) {
    const cancellation = providerToolCallCancellationSchema.safeParse(
      message.params
    );
    if (cancellation.success) pending.get(cancellation.data.requestId)?.abort();
    return;
  }
  if (message.id === void 0 || message.method === void 0) {
    return;
  }
  switch (message.method) {
    case "initialize":
      writeResult(message.id, {
        protocolVersion: typeof objectParams(message.params).protocolVersion === "string" ? objectParams(message.params).protocolVersion : "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: ACP_BRIDGE_MCP_SERVER_NAME, version: "1.0.0" }
      });
      void callBridge(env, {
        kind: "initialized",
        toolCount: env.tools.length
      }).catch((error) => {
        process.stderr.write(
          `bb-bridge MCP: failed to report initialize: ${error instanceof Error ? error.message : String(error)}
`
        );
      });
      return;
    case "tools/list":
      writeResult(message.id, {
        tools: env.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      });
      return;
    case "tools/call": {
      if (pending.has(message.id)) return;
      const params = objectParams(message.params);
      const name = typeof params.name === "string" ? params.name : "";
      const tool = env.tools.find((candidate) => candidate.name === name);
      if (!tool) {
        writeError(message.id, -32602, `Unknown tool: ${name}`);
        return;
      }
      const rawArguments = params.arguments;
      const toolArguments = rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments) ? rawArguments : {};
      const controller = new AbortController();
      pending.set(message.id, controller);
      const progressToken = readProgressToken(message.params);
      const stopHeartbeat = progressToken === null ? () => {
      } : startProgressHeartbeat({
        intervalMs: env.progressIntervalMs,
        progressToken
      });
      controller.signal.addEventListener("abort", stopHeartbeat, {
        once: true
      });
      try {
        const result = await callBridge(
          env,
          {
            kind: "toolCall",
            arguments: toolArguments,
            callId: mcpToolCallId(tool.name),
            tool: tool.name
          },
          controller.signal
        );
        if (controller.signal.aborted) return;
        if (!result.ok) {
          writeResult(message.id, {
            content: [{ type: "text", text: result.error }],
            isError: true
          });
          return;
        }
        writeResult(message.id, {
          content: buildBridgeToolCallContent(result),
          ...result.isError ? { isError: true } : {}
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        writeResult(message.id, {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error)
            }
          ],
          isError: true
        });
      } finally {
        stopHeartbeat();
        controller.signal.removeEventListener("abort", stopHeartbeat);
        pending.delete(message.id);
      }
      return;
    }
    default:
      writeError(
        message.id,
        -32601,
        `Unsupported MCP method: ${message.method}`
      );
  }
}
function runAcpDynamicToolMcpServer() {
  const env = readEnvironment();
  const pending = /* @__PURE__ */ new Map();
  const rl = createInterface2({ input: process.stdin, terminal: false });
  rl.on("close", () => {
    for (const controller of pending.values()) controller.abort();
  });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message;
    try {
      message = jsonRpcMessageSchema.parse(JSON.parse(trimmed));
    } catch {
      return;
    }
    void handleRequest(env, message, pending);
  });
}

// ../provider-bridge-acp/src/bridge/cursor-mcp-approval.ts
var CURSOR_MCP_APPROVAL_FILE = "mcp-approvals.json";
var CURSOR_APPROVAL_LOCK_STALE_MS = 3e4;
var CURSOR_APPROVAL_LOCK_TIMEOUT_MS = 5e3;
function errorCode(error) {
  return error instanceof Error && "code" in error ? error.code : void 0;
}
function cursorAgentCommand(command) {
  return basename2(command).toLowerCase().replace(/\.(?:bat|cmd|exe)$/u, "") === "cursor-agent";
}
function cursorProjectSlug(projectRoot) {
  return projectRoot.replace(/[^a-zA-Z0-9]/gu, "-").replace(/-+/gu, "-").replace(/^-+|-+$/gu, "");
}
function cursorDataDirectory(env) {
  const configured = env.CURSOR_DATA_DIR?.trim();
  if (configured) {
    return configured;
  }
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return join2(home, ".cursor");
}
function cursorMcpServerConfig(config) {
  return {
    command: config.command,
    args: config.args,
    env: Object.fromEntries(config.env.map(({ name, value }) => [name, value]))
  };
}
function buildCursorMcpApprovalIdentifier(args) {
  const fingerprint = createHash("sha256").update(
    JSON.stringify({
      path: args.projectRoot,
      server: cursorMcpServerConfig(args.config)
    })
  ).digest("hex").slice(0, 16);
  return `${args.config.name}-${fingerprint}`;
}
async function resolveCursorProjectRoot(args) {
  return new Promise((resolveRoot) => {
    execFile5(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: args.cwd, env: args.env, windowsHide: true },
      (error, stdout) => {
        const root = stdout.trim();
        resolveRoot(error === null && root !== "" ? root : resolve3(args.cwd));
      }
    );
  });
}
async function readApprovals(path13) {
  let text;
  try {
    text = await readFile(path13, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
  const value = JSON.parse(text);
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Cursor MCP approval file is not a string array: ${path13}`);
  }
  return value;
}
async function writeApprovals(path13, approvals) {
  await mkdir(dirname(path13), { recursive: true });
  const tempPath = `${path13}.bb-${process.pid}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(approvals, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    await rename(tempPath, path13);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
async function acquireApprovalLock(path13) {
  const lockPath = `${path13}.bb-lock`;
  const deadline = Date.now() + CURSOR_APPROVAL_LOCK_TIMEOUT_MS;
  await mkdir(dirname(path13), { recursive: true });
  for (; ; ) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out updating Cursor MCP approvals: ${path13}`);
    }
    try {
      await mkdir(lockPath, { mode: 448 });
      return () => rm(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && !(process.platform === "win32" && errorCode(error) === "EPERM")) {
        throw error;
      }
    }
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs > CURSOR_APPROVAL_LOCK_STALE_MS) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        continue;
      }
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
}
async function mutateApprovals(path13, mutate) {
  const releaseLock = await acquireApprovalLock(path13);
  try {
    const approvals = await readApprovals(path13);
    const nextApprovals = mutate(approvals);
    if (approvals.length !== nextApprovals.length || approvals.some((approval, index) => approval !== nextApprovals[index])) {
      await writeApprovals(path13, nextApprovals);
    }
  } finally {
    await releaseLock();
  }
}
async function approveCursorSessionMcpServer(args) {
  if (!cursorAgentCommand(args.agentCommand) || args.config.name !== ACP_BRIDGE_MCP_SERVER_NAME) {
    return void 0;
  }
  const projectRoot = await resolveCursorProjectRoot({
    cwd: args.cwd,
    env: args.env
  });
  const path13 = join2(
    cursorDataDirectory(args.env),
    "projects",
    cursorProjectSlug(projectRoot),
    CURSOR_MCP_APPROVAL_FILE
  );
  const approval = buildCursorMcpApprovalIdentifier({
    config: args.config,
    projectRoot
  });
  let installedByBb = false;
  await mutateApprovals(path13, (approvals) => {
    if (approvals.includes(approval)) {
      return approvals;
    }
    installedByBb = true;
    return [...approvals, approval];
  });
  return { approval, installedByBb, path: path13 };
}
async function revokeCursorSessionMcpServer(approval) {
  if (!approval.installedByBb) {
    return;
  }
  await mutateApprovals(
    approval.path,
    (approvals) => approvals.filter((candidate) => candidate !== approval.approval)
  );
}

// ../provider-bridge-acp/src/bridge/bridge.ts
var sessionsByBbThreadId = /* @__PURE__ */ new Map();
var bbThreadIdByProviderThreadId = /* @__PURE__ */ new Map();
var pendingRuntimeRequests = /* @__PURE__ */ new Map();
var runtimeRequestIdCounter = 0;
var dynamicToolBridgePromise = null;
var THREAD_STOP_CANCEL_TIMEOUT_MS = 4e3;
var { send, sendResult, sendError } = createBridgeIo();
function sendNotification(method, params) {
  send({ jsonrpc: "2.0", method, params });
}
function sendRuntimeRequest(method, params, signal) {
  signal?.throwIfAborted();
  runtimeRequestIdCounter += 1;
  const requestId = runtimeRequestIdCounter;
  let abort;
  const responsePromise = new Promise(
    (resolveResponse, rejectResponse) => {
      abort = () => {
        pendingRuntimeRequests.delete(requestId);
        sendNotification(PROVIDER_TOOL_CALL_CANCELLED_METHOD, { requestId });
        rejectResponse(new Error("ACP dynamic tool call cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      pendingRuntimeRequests.set(requestId, (response) => {
        if ("error" in response) {
          rejectResponse(
            new Error(response.error.message ?? "Runtime request failed")
          );
          return;
        }
        resolveResponse(response.result);
      });
    }
  );
  send({
    jsonrpc: "2.0",
    id: requestId,
    method,
    params
  });
  return responsePromise.finally(
    () => signal?.removeEventListener("abort", abort)
  );
}
var configuredSkillRoots = null;
function sendThreadDeltas(threadId, deltas) {
  if (deltas.length === 0) {
    return;
  }
  sendNotification(THREAD_DELTA_NOTIFICATION_METHOD, {
    threadId,
    deltas: [...deltas]
  });
}
function rememberGrokContextWindow(session, models) {
  if (session.dialect.id !== "grok") {
    return;
  }
  const size = grokContextWindowSizeFromSessionModels(models);
  if (size !== void 0) {
    session.grokContextWindowSize = size;
  }
}
function emitGrokContextWindow(session, used) {
  if (session.dialect.id !== "grok" || session.grokContextWindowSize === void 0) {
    return;
  }
  sendThreadDeltas(session.bbThreadId, [
    {
      kind: "contextWindow",
      used,
      size: session.grokContextWindowSize,
      estimated: false,
      attach: "open"
    }
  ]);
}
function emitForSession(session, method, params) {
  sendThreadDeltas(
    session.bbThreadId,
    session.translator.translateAcpEvent(
      { jsonrpc: "2.0", method, params },
      { threadId: session.bbThreadId }
    )
  );
}
function emitSessionError(session, message) {
  for (const controller of session.pendingToolCalls) controller.abort();
  if (session.activePromptKind !== null) {
    emitForSession(session, "error", {
      threadId: session.bbThreadId,
      message
    });
  }
  sendNotification(BRIDGE_NOTIFICATION_METHODS.error, {
    threadId: session.bbThreadId,
    ...session.providerThreadId !== "" ? { providerThreadId: session.providerThreadId } : {},
    message
  });
}
function resolveBridgeProcessArgsForMcpServer() {
  return [...process.execArgv, fileURLToPath3(import.meta.url), "--mcp-stdio"];
}
function resolveBridgeProcessEnvForMcpServer() {
  const electronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  if (electronRunAsNode === void 0) {
    return [];
  }
  return [{ name: "ELECTRON_RUN_AS_NODE", value: electronRunAsNode }];
}
async function forwardDynamicToolCall(args, signal) {
  const session = sessionsByBbThreadId.get(args.threadId);
  if (!session || !session.providerThreadId || session.stopping || session.connection.exited) {
    return { ok: false, error: "No active ACP session for dynamic tool call." };
  }
  const controller = new AbortController();
  session.pendingToolCalls.add(controller);
  session.translator.noteInjectedToolCall(session.bbThreadId, args.tool);
  try {
    const result = await sendRuntimeRequest(
      "item/tool/call",
      {
        providerThreadId: session.providerThreadId,
        threadId: session.bbThreadId,
        turnId: null,
        callId: args.callId,
        tool: args.tool,
        arguments: args.arguments
      },
      AbortSignal.any([signal, controller.signal])
    );
    return { ok: true, ...decodeToolCallResponsePayload(result) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    session.pendingToolCalls.delete(controller);
  }
}
function handleDynamicToolBridgeSocket(bridge, socket) {
  const controller = new AbortController();
  socket.once("close", () => controller.abort());
  let handled = false;
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {
  });
  socket.on("data", (chunk) => {
    if (handled) return;
    buffer += chunk;
    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) {
      return;
    }
    handled = true;
    const line = buffer.slice(0, newlineIndex);
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      socket.end(`${JSON.stringify({ ok: false, error: "Invalid JSON" })}
`);
      return;
    }
    const request = dynamicToolBridgeRequestSchema.safeParse(parsed);
    if (!request.success || request.data.token !== bridge.token) {
      socket.end(
        `${JSON.stringify({ ok: false, error: "Invalid dynamic tool request" })}
`
      );
      return;
    }
    if (request.data.kind === "initialized") {
      process.stderr.write(
        `acp bridge: "${ACP_BRIDGE_MCP_SERVER_NAME}" answered initialize for thread "${request.data.threadId}" (${request.data.toolCount} tools)
`
      );
      socket.end(`${JSON.stringify({ ok: true, content: "" })}
`);
      return;
    }
    void forwardDynamicToolCall(request.data, controller.signal).then(
      (response) => {
        if (controller.signal.aborted) return;
        socket.end(`${JSON.stringify(response)}
`);
      }
    );
  });
}
async function ensureDynamicToolBridge() {
  if (dynamicToolBridgePromise) {
    return dynamicToolBridgePromise;
  }
  dynamicToolBridgePromise = new Promise((resolveBridge, rejectBridge) => {
    const host = "127.0.0.1";
    const server = createServer((socket) => {
      socket.on("error", () => {
      });
      void dynamicToolBridgePromise?.then((bridge) => {
        handleDynamicToolBridgeSocket(bridge, socket);
      });
    });
    server.once("error", rejectBridge);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectBridge(
          new Error("ACP dynamic tool bridge did not bind a TCP port")
        );
        return;
      }
      resolveBridge({
        host,
        port: address.port,
        server,
        token: randomBytes2(32).toString("hex")
      });
    });
  });
  return dynamicToolBridgePromise;
}
async function buildSessionMcpServers(params) {
  const dynamicTools = params.dynamicTools ?? [];
  if (dynamicTools.length === 0) {
    return [];
  }
  const bridge = await ensureDynamicToolBridge();
  const config = buildAcpMcpServerConfig({
    bridgeArgs: resolveBridgeProcessArgsForMcpServer(),
    command: process.execPath,
    dynamicTools,
    host: bridge.host,
    port: bridge.port,
    runtimeEnv: resolveBridgeProcessEnvForMcpServer(),
    threadId: params.threadId,
    token: bridge.token
  });
  process.stderr.write(
    `acp bridge: built "${config.name}" session MCP config for thread "${params.threadId}" (${dynamicTools.length} tools)
`
  );
  return [config];
}
var ACP_DEFAULT_MODEL = {
  id: ACP_DEFAULT_MODEL_ID,
  model: ACP_DEFAULT_MODEL_ID,
  displayName: "Agent default",
  description: "Model selection is managed by the connected ACP agent.",
  supportedReasoningEfforts: ACP_NATIVE_REASONING_EFFORTS,
  defaultReasoningEffort: "medium",
  isDefault: true
};
var MODEL_LIST_TIMEOUT_MS = 3e4;
var ACP_NATIVE_REASONING_DISCOVERY_TIMEOUT_MS = 5e3;
var AUTH_REQUIRED_MODEL_LIST_ERROR_MESSAGE = "ACP agent is not authenticated.";
function reasoningSupportFromCli(reasoningCli) {
  if (reasoningCli === void 0) {
    return void 0;
  }
  const supportedLevels = reasoningCli.supportedLevels;
  const defaultReasoningEffort = reasoningCli.defaultLevel !== void 0 && supportedLevels.includes(reasoningCli.defaultLevel) ? reasoningCli.defaultLevel : supportedLevels.includes("medium") ? "medium" : supportedLevels[0];
  return {
    supportedReasoningEfforts: reasoningEffortsForLevels(supportedLevels),
    defaultReasoningEffort
  };
}
function applyReasoningCliToModel(model, reasoningCli) {
  const reasoningSupport = reasoningSupportFromCli(reasoningCli);
  return reasoningSupport === void 0 ? model : {
    ...model,
    ...reasoningSupport
  };
}
function modelHasOnlyAgentManagedReasoning(model) {
  return model.supportedReasoningEfforts.length === 1 && model.supportedReasoningEfforts[0]?.reasoningEffort === "medium" && model.defaultReasoningEffort === "medium";
}
function applyNativeReasoningHintToModel(model, nativeReasoning) {
  const reasoningSupport = reasoningSupportFromCli(nativeReasoning);
  return reasoningSupport === void 0 || !modelHasOnlyAgentManagedReasoning(model) ? model : {
    ...model,
    ...reasoningSupport
  };
}
function applyConfiguredReasoningToModel(model, args) {
  return args.reasoningCli !== void 0 ? applyReasoningCliToModel(model, args.reasoningCli) : applyNativeReasoningHintToModel(model, args.nativeReasoning);
}
function applyConfiguredReasoningToModels(models, args) {
  return models.map((model) => applyConfiguredReasoningToModel(model, args));
}
function resolveHintReasoningValue(args) {
  const override = args.hint.levelValues?.[args.reasoningLevel];
  if (override !== void 0) {
    return override;
  }
  return args.hint.supportedLevels.includes(args.reasoningLevel) ? args.reasoningLevel : void 0;
}
function nativeReasoningToThoughtLevelOption(nativeReasoning) {
  if (nativeReasoning === void 0) {
    return void 0;
  }
  const options = nativeReasoning.supportedLevels.flatMap((level) => {
    const value = resolveHintReasoningValue({
      hint: nativeReasoning,
      reasoningLevel: level
    });
    return value === void 0 ? [] : [
      {
        value,
        name: value
      }
    ];
  });
  const currentValue = nativeReasoning.defaultLevel === void 0 ? void 0 : resolveHintReasoningValue({
    hint: nativeReasoning,
    reasoningLevel: nativeReasoning.defaultLevel
  });
  return {
    id: nativeReasoning.configId,
    category: "thought_level",
    type: "select",
    ...currentValue !== void 0 ? { currentValue } : {},
    options
  };
}
function permissionCliArgsForMode(permissionCli, permissionMode) {
  if (permissionCli === void 0) {
    return [];
  }
  switch (permissionMode) {
    case "full":
      return permissionCli.full ?? [];
    case "accept-edits":
      return permissionCli.workspaceWrite ?? [];
  }
}
function applyPermissionCliArgs(agentArgs, permissionCli, permissionMode) {
  const permissionArgs = permissionCliArgsForMode(
    permissionCli,
    permissionMode
  );
  if (permissionArgs.length === 0) {
    return [...agentArgs];
  }
  const insertAfterArgs = Math.min(
    permissionCli?.insertAfterArgs ?? 0,
    agentArgs.length
  );
  return [
    ...agentArgs.slice(0, insertAfterArgs),
    ...permissionArgs,
    ...agentArgs.slice(insertAfterArgs)
  ];
}
var cachedModelCatalog = null;
var SESSION_MODEL_DISCOVERY_TTL_MS = 6e4;
var cachedSessionDiscoveredModels = null;
function resolveAcpAuthMethodId(authMethods, env) {
  const methodIds = new Set((authMethods ?? []).map((method) => method.id));
  if (methodIds.size === 0) {
    return void 0;
  }
  if (env.XAI_API_KEY && methodIds.has("xai.api_key")) {
    return "xai.api_key";
  }
  if (methodIds.has("cached_token")) {
    return "cached_token";
  }
  return void 0;
}
async function authenticateAcpAgent(args) {
  const methodId = resolveAcpAuthMethodId(
    args.initializeResult.authMethods,
    args.env
  );
  if (methodId === void 0) {
    return;
  }
  try {
    await args.connection.request({
      method: "authenticate",
      params: { methodId, _meta: { headless: true } },
      resultSchema: z44.unknown()
    });
  } catch (error) {
    throw new AcpAuthRequiredError(
      error instanceof Error ? error.message : String(error)
    );
  }
}
async function loadAgentModelCatalog(listCommand) {
  const stdout = await execPortableFile(listCommand.command, listCommand.args, {
    cwd: listCommand.cwd ?? process.cwd(),
    env: {
      ...withoutBridgeRuntimeEnv(process.env),
      ...listCommand.envVars ?? {}
    },
    maxBuffer: 1024 * 1024,
    timeout: MODEL_LIST_TIMEOUT_MS
  }).then(
    ({ stdout: stdout2 }) => stdout2,
    (error) => {
      if (isMissingExecutableError(error)) throw error;
      const output = z44.object({ stdout: z44.string(), stderr: z44.string() }).safeParse(error);
      if (isAuthRequiredModelListError(
        error,
        output.success ? output.data.stdout : "",
        output.success ? output.data.stderr : ""
      )) {
        throw new AcpModelListAuthRequiredError();
      }
      return null;
    }
  );
  const key = JSON.stringify(listCommand);
  if (stdout === null) {
    process.stderr.write(
      `acp bridge: model list command "${listCommand.command}" failed
`
    );
    return cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : null;
  }
  const catalog = buildAgentModelCatalog(parseAgentModelLines(stdout));
  if (!catalog) {
    process.stderr.write(
      `acp bridge: model list command "${listCommand.command}" printed no models
`
    );
    return cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : null;
  }
  cachedModelCatalog = { key, catalog };
  return catalog;
}
async function loadSessionDiscoveredModels(agent, reasoningProbePriorityModelIds, parameterizedModelPicker) {
  const key = JSON.stringify({
    agent,
    reasoningProbePriorityModelIds,
    parameterizedModelPicker
  });
  if (cachedSessionDiscoveredModels?.key === key && Date.now() - cachedSessionDiscoveredModels.fetchedAt < SESSION_MODEL_DISCOVERY_TTL_MS) {
    return cachedSessionDiscoveredModels.models;
  }
  const childEnv = {
    ...withoutBridgeRuntimeEnv(process.env),
    ...agent.envVars ?? {}
  };
  const connection = createAcpAgentConnection({
    command: agent.command,
    args: agent.args,
    cwd: agent.cwd ?? process.cwd(),
    env: childEnv,
    recordThreadId: null,
    onNotification: () => {
    },
    onRequest: (_method, _params, responder) => {
      responder.error(-32601, "ACP model discovery does not support requests");
    },
    onExit: () => {
    }
  });
  let timeout;
  const timeoutReached = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      connection.kill();
      reject(
        new Error(
          `ACP-native model discovery timed out after ${MODEL_LIST_TIMEOUT_MS}ms`
        )
      );
    }, MODEL_LIST_TIMEOUT_MS);
  });
  try {
    const newSession = await Promise.race([
      (async () => {
        const initializeResult = await requestAcpInitialize(connection, {
          parameterizedModelPicker,
          fsAccess: false
        });
        await authenticateAcpAgent({
          connection,
          env: childEnv,
          initializeResult
        });
        return await connection.request({
          method: "session/new",
          params: { cwd: agent.cwd ?? process.cwd(), mcpServers: [] },
          resultSchema: acpSessionNewResultSchema
        });
      })(),
      timeoutReached
    ]);
    if (timeout !== void 0) {
      clearTimeout(timeout);
      timeout = void 0;
    }
    const modelOption = findAcpModelConfigOption(newSession.configOptions);
    const configOptionModels = buildModelCatalogFromConfigOptions(modelOption);
    const sessionModels = buildModelCatalogFromSessionModels(newSession.models);
    if (configOptionModels.length === 0 && sessionModels.length === 0) {
      return null;
    }
    if (configOptionModels.length === 0) {
      cachedSessionDiscoveredModels = {
        key,
        models: sessionModels,
        fetchedAt: Date.now()
      };
      return sessionModels;
    }
    const reasoningByModel = await discoverAcpNativeReasoningByModel({
      connection,
      sessionId: newSession.sessionId,
      modelOption,
      reasoningProbePriorityModelIds
    });
    const models = buildModelCatalogFromConfigOptions(
      modelOption,
      reasoningByModel
    );
    cachedSessionDiscoveredModels = {
      key,
      models,
      fetchedAt: Date.now()
    };
    return models;
  } catch (error) {
    process.stderr.write(
      `acp bridge: ACP-native model discovery for "${agent.command}" failed: ${error instanceof Error ? error.message : String(error)}
`
    );
    return null;
  } finally {
    if (timeout !== void 0) {
      clearTimeout(timeout);
    }
    await connection.kill();
  }
}
async function discoverAcpNativeReasoningByModel(args) {
  const modelOptions = args.modelOption?.options ?? [];
  if (!args.modelOption || modelOptions.length === 0) {
    return /* @__PURE__ */ new Map();
  }
  const modelOption = args.modelOption;
  const modelByValue = new Map(
    modelOptions.map((model) => [model.value, model])
  );
  const modelsToProbe = [];
  const addedModels = /* @__PURE__ */ new Set();
  for (const value of args.reasoningProbePriorityModelIds) {
    const model = modelByValue.get(value);
    if (model && !addedModels.has(model.value)) {
      modelsToProbe.push(model);
      addedModels.add(model.value);
    }
  }
  for (const model of modelOptions) {
    if (!addedModels.has(model.value)) {
      modelsToProbe.push(model);
    }
  }
  const supportByModel = /* @__PURE__ */ new Map();
  let timedOut = false;
  let timeout;
  const timeoutReached = new Promise((resolve5) => {
    timeout = setTimeout(() => {
      timedOut = true;
      args.connection.kill();
      resolve5(supportByModel);
    }, ACP_NATIVE_REASONING_DISCOVERY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        for (const model of modelsToProbe) {
          try {
            const configState = await args.connection.request({
              method: "session/set_config_option",
              params: {
                sessionId: args.sessionId,
                configId: modelOption.id,
                value: model.value
              },
              resultSchema: acpConfigStateResultSchema
            });
            supportByModel.set(
              model.value,
              buildAcpNativeReasoningSupport(
                findAcpThoughtLevelConfigOption(configState.configOptions)
              )
            );
          } catch (error) {
            if (timedOut) {
              break;
            }
            process.stderr.write(
              `acp bridge: ACP-native reasoning discovery for model "${model.value}" failed: ${error instanceof Error ? error.message : String(error)}
`
            );
          }
        }
        return supportByModel;
      })(),
      timeoutReached
    ]);
  } finally {
    if (timeout !== void 0) {
      clearTimeout(timeout);
    }
  }
}
function isMissingExecutableError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT" && "syscall" in error && typeof error.syscall === "string" && error.syscall.startsWith("spawn");
}
var AcpAuthRequiredError = class extends BridgeRecoveryError {
  constructor(message) {
    super({
      code: -32e3,
      message,
      recovery: { kind: "authRequired", message, retryable: false }
    });
    this.name = "AcpAuthRequiredError";
  }
};
var AcpModelListAuthRequiredError = class extends AcpAuthRequiredError {
  constructor() {
    super(AUTH_REQUIRED_MODEL_LIST_ERROR_MESSAGE);
    this.name = "AcpModelListAuthRequiredError";
  }
};
function isAcpAuthRequiredText(...texts) {
  const text = texts.join("\n");
  return text.includes("Authentication required") && (text.includes("agent login") || text.includes("CURSOR_API_KEY") || text.includes("CURSOR_AUTH_TOKEN") || text.includes("auth token") || text.includes("api key") || text.includes("login"));
}
function isAuthRequiredModelListError(error, stdout, stderr) {
  return isAcpAuthRequiredText(
    error instanceof Error ? error.message : String(error),
    stdout,
    stderr
  );
}
var ACP_AUTH_REQUIRED_ERROR_CODE = -32e3;
var ACP_AUTH_REQUIRED_ERROR_MESSAGE = "Authentication required";
function isAcpAuthRequiredResponse(error) {
  return error instanceof AcpAgentResponseError && error.code === ACP_AUTH_REQUIRED_ERROR_CODE && error.message.startsWith(ACP_AUTH_REQUIRED_ERROR_MESSAGE);
}
function withAcpAuthRequiredRecovery(error) {
  if (error instanceof AcpAuthRequiredError) return error;
  if (error instanceof Error && (isAcpAuthRequiredResponse(error) || isAcpAuthRequiredText(error.message))) {
    return new AcpAuthRequiredError(error.message);
  }
  return error;
}
async function resolveAgentLaunchArgs(params) {
  const selection = params.modelSelection;
  const agentArgs = applyPermissionCliArgs(
    params.agent.args,
    params.permissionCli,
    params.permissionMode
  );
  const prefixArgs = [];
  let warning;
  if (selection && "selectFlag" in selection) {
    let resolved;
    const variantReasoningLevel = params.reasoningCli === void 0 ? selection.reasoningLevel : void 0;
    if (variantReasoningLevel !== void 0 || selection.serviceTier === "fast") {
      const key = JSON.stringify(selection.listCommand);
      const catalog = cachedModelCatalog?.key === key ? cachedModelCatalog.catalog : await loadAgentModelCatalog(selection.listCommand);
      resolved = catalog?.resolveVariant({
        model: selection.model,
        reasoningLevel: variantReasoningLevel,
        serviceTier: selection.serviceTier
      });
      if (resolved === void 0 && variantReasoningLevel !== void 0) {
        warning = `Model "${selection.model}" has no ${variantReasoningLevel} reasoning variant; launching it at its default effort.`;
      }
    }
    prefixArgs.push(selection.selectFlag, resolved ?? selection.model);
  }
  if (params.reasoningCli !== void 0 && params.launchReasoningLevel !== void 0) {
    const reasoningValue = resolveHintReasoningValue({
      hint: params.reasoningCli,
      reasoningLevel: params.launchReasoningLevel
    });
    if (reasoningValue !== void 0) {
      prefixArgs.push(params.reasoningCli.flag, reasoningValue);
    } else if (warning === void 0) {
      warning = `Reasoning level "${params.launchReasoningLevel}" is not supported by this ACP agent's launch flag; launching it at its default effort.`;
    }
  }
  return {
    args: [...prefixArgs, ...agentArgs],
    warning
  };
}
async function selectAcpNativeModel(args) {
  const selection = args.modelSelection;
  if (!selection || !("modelId" in selection)) {
    return;
  }
  const { session } = args;
  const { configOptions, models } = session.nativeConfig;
  const modelOption = findAcpModelConfigOption(configOptions);
  const availableSessionModels = models?.availableModels ?? [];
  const sessionModelsIncludeSelection = availableSessionModels.some(
    (model) => model.modelId === selection.modelId
  );
  const shouldSetModel = modelOption && modelOption.currentValue !== selection.modelId || !modelOption && sessionModelsIncludeSelection && models?.currentModelId !== selection.modelId;
  if (shouldSetModel) {
    let configState = null;
    let setModel = true;
    if (modelOption) {
      try {
        configState = await session.connection.request({
          method: "session/set_config_option",
          params: {
            sessionId: args.sessionId,
            configId: modelOption.id,
            value: selection.modelId
          },
          resultSchema: z44.union([acpConfigStateResultSchema, z44.null()])
        });
        setModel = false;
      } catch {
        setModel = true;
      }
    }
    if (setModel) {
      configState = await session.connection.request({
        method: "session/set_model",
        params: { sessionId: args.sessionId, modelId: selection.modelId },
        resultSchema: z44.union([acpConfigStateResultSchema, z44.null()])
      });
    }
    const current = session.nativeConfig;
    session.nativeConfig = {
      configOptions: configState?.configOptions ?? withAcpConfigValue(
        current.configOptions,
        modelOption?.id,
        selection.modelId
      ),
      models: configState?.models ?? (current.models && {
        ...current.models,
        currentModelId: selection.modelId
      })
    };
  }
  await selectAcpNativeReasoning({
    session,
    sessionId: args.sessionId,
    modelSelection: selection,
    nativeReasoning: args.nativeReasoning
  });
  await selectAcpNativeServiceTier({
    session,
    sessionId: args.sessionId,
    modelSelection: selection
  });
}
function withAcpConfigValue(configOptions, configId, value) {
  return configOptions?.map(
    (option) => option.id === configId ? { ...option, currentValue: value } : option
  );
}
function recordAcpConfigValue(session, configState, configId, value) {
  session.nativeConfig = {
    ...session.nativeConfig,
    configOptions: configState?.configOptions ?? withAcpConfigValue(session.nativeConfig.configOptions, configId, value)
  };
}
function acpNativeModelDrifted(nativeConfig, modelSelection) {
  if (!modelSelection || !("modelId" in modelSelection)) {
    return false;
  }
  const currentModelId = findAcpModelConfigOption(nativeConfig.configOptions)?.currentValue ?? nativeConfig.models?.currentModelId;
  return currentModelId !== void 0 && currentModelId !== modelSelection.modelId;
}
async function selectAcpNativeReasoning(args) {
  const reasoningLevel = args.modelSelection.reasoningLevel;
  if (reasoningLevel === void 0) {
    return;
  }
  const thoughtLevelOption = findAcpThoughtLevelConfigOption(args.session.nativeConfig.configOptions) ?? nativeReasoningToThoughtLevelOption(args.nativeReasoning);
  if (!thoughtLevelOption) {
    return;
  }
  const value = acpNativeReasoningLevelToValue(
    reasoningLevel,
    thoughtLevelOption
  );
  if (value === void 0) {
    return;
  }
  let configState;
  try {
    configState = await args.session.connection.request({
      method: "session/set_config_option",
      params: {
        sessionId: args.sessionId,
        configId: thoughtLevelOption.id,
        value
      },
      resultSchema: z44.union([acpConfigStateResultSchema, z44.null()])
    });
  } catch {
    return;
  }
  recordAcpConfigValue(args.session, configState, thoughtLevelOption.id, value);
}
async function selectAcpNativeServiceTier(args) {
  const serviceTier = args.modelSelection.serviceTier;
  if (serviceTier === void 0) {
    return;
  }
  const fastOption = (args.session.nativeConfig.configOptions ?? []).find(
    (option) => option.id === "fast" && option.type === "select"
  );
  const value = serviceTier === "fast" ? "true" : "false";
  if (!fastOption?.options?.some((option) => option.value === value)) {
    return;
  }
  const configState = await args.session.connection.request({
    method: "session/set_config_option",
    params: {
      sessionId: args.sessionId,
      configId: fastOption.id,
      value
    },
    resultSchema: z44.union([acpConfigStateResultSchema, z44.null()])
  });
  recordAcpConfigValue(args.session, configState, fastOption.id, value);
}
function buildPromptContentBlocks(session, input) {
  const blocks = [];
  const instructions = session.pendingInstructions;
  if (instructions) {
    session.pendingInstructions = void 0;
    blocks.push({
      type: "text",
      text: `<system_instructions>
${instructions}
</system_instructions>`
    });
  }
  for (const item of input) {
    switch (item.type) {
      case "text":
        blocks.push({ type: "text", text: item.text });
        break;
      case "image":
        blocks.push({ type: "text", text: `[image attachment: ${item.url}]` });
        break;
      case "localImage": {
        if (!session.supportsImageInput) {
          blocks.push({
            type: "text",
            text: `[image attachment on disk: ${item.path}]`
          });
          break;
        }
        try {
          const data = readFileSync3(item.path).toString("base64");
          blocks.push({
            type: "image",
            data,
            mimeType: mimeTypeFromExtension(item.path)
          });
        } catch {
          blocks.push({
            type: "text",
            text: `[unreadable image attachment: ${item.path}]`
          });
        }
        break;
      }
      case "localFile":
        blocks.push({
          type: "resource_link",
          uri: `file://${item.path}`,
          name: item.name ?? basename3(item.path)
        });
        break;
    }
  }
  return blocks;
}
function findOptionIdByKinds(options, kinds) {
  for (const kind of kinds) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option) {
      return option.optionId;
    }
  }
  return void 0;
}
function pickPermissionOptionId(options, decision) {
  switch (decision) {
    case "allow_once":
      return findOptionIdByKinds(options, ["allow_once", "allow_always"]);
    case "allow_for_session":
      return findOptionIdByKinds(options, ["allow_always", "allow_once"]);
    case "deny":
      return findOptionIdByKinds(options, ["reject_once", "reject_always"]);
  }
}
function respondPermission(pending, decision) {
  if (decision === null) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  const optionId = pickPermissionOptionId(pending.options, decision);
  if (optionId === void 0) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  pending.responder.result({ outcome: { outcome: "selected", optionId } });
}
function cancelPendingPermissions(session) {
  for (const pending of session.pendingPermissions) {
    pending.responder.result({ outcome: { outcome: "cancelled" } });
  }
  session.pendingPermissions.clear();
}
function handlePermissionRequest(session, params, responder) {
  const parsed = acpRequestPermissionParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid session/request_permission params");
    return;
  }
  if (session.stopping || session.cancelRequested || session.activePromptKind !== "turn") {
    responder.result({ outcome: { outcome: "cancelled" } });
    return;
  }
  const toolCall = parsed.data.toolCall;
  const bound = toolCall?.toolCallId !== void 0 ? session.translator.notePermissionToolCall(session.bbThreadId, {
    toolCallId: toolCall.toolCallId,
    ...toolCall.title !== void 0 ? { title: toolCall.title } : {},
    ...toolCall.kind !== void 0 ? { kind: toolCall.kind } : {},
    ...toolCall.rawKind !== void 0 ? { rawKind: toolCall.rawKind } : {},
    ...toolCall.locations !== void 0 ? { locations: toolCall.locations } : {},
    ...toolCall.rawInput !== void 0 ? { rawInput: toolCall.rawInput } : {},
    ...toolCall.rawOutput !== void 0 ? { rawOutput: toolCall.rawOutput } : {}
  }) : void 0;
  const pending = {
    responder,
    options: parsed.data.options
  };
  if (session.policy.permissionMode === "full") {
    respondPermission(pending, "allow_once");
    return;
  }
  session.pendingPermissions.add(pending);
  const normalizedToolCall = toolCall?.toolCallId !== void 0 && bound !== void 0 ? {
    toolCallId: bound.toolCallId,
    ...toolCall.title !== void 0 ? { title: toolCall.title } : {},
    ...toolCall.kind !== void 0 ? { kind: toolCall.kind } : {},
    ...toolCall.rawKind !== void 0 ? { rawKind: toolCall.rawKind } : {},
    ...toolCall.content !== void 0 ? { content: toolCall.content } : {},
    ...toolCall.rawInput !== void 0 ? { rawInput: toolCall.rawInput } : {},
    ...toolCall.locations !== void 0 ? { locations: toolCall.locations } : {},
    startedToolCall: bound.event,
    injectedTool: session.translator.getInjectedToolBinding(
      session.bbThreadId,
      bound.toolCallId
    )
  } : void 0;
  const payload = buildAcpPermissionInteractionPayload({
    toolCall: normalizedToolCall,
    options: parsed.data.options,
    cwd: session.cwd,
    classifyToolCall: session.dialect.classifyToolCall
  });
  void sendRuntimeRequest(BRIDGE_INBOUND_REQUEST_METHODS.interactionRequest, {
    providerThreadId: session.providerThreadId,
    threadId: session.bbThreadId,
    turnId: null,
    payload
  }).then((result) => {
    if (!session.pendingPermissions.delete(pending)) {
      return;
    }
    const resolution = pendingInteractionResolutionSchema.safeParse(result);
    const response = resolution.success ? resolveAcpPermissionDecision({
      payload,
      resolution: resolution.data
    }) : null;
    respondPermission(pending, response?.decision ?? null);
  }).catch(() => {
    if (!session.pendingPermissions.delete(pending)) {
      return;
    }
    respondPermission(pending, null);
  });
}
function isPathInsideRoots(targetPath, roots) {
  const resolvedTarget = resolve4(targetPath);
  return roots.some((root) => {
    const relativePath = relative2(resolve4(root), resolvedTarget);
    return relativePath === "" || !relativePath.startsWith("..") && !isAbsolute2(relativePath);
  });
}
function sliceFileContent(content, line, limit) {
  if (line == null && limit == null) {
    return content;
  }
  const lines = content.split("\n");
  const startIndex = line == null ? 0 : Math.max(0, line - 1);
  const endIndex = limit == null ? lines.length : startIndex + limit;
  return lines.slice(startIndex, endIndex).join("\n");
}
async function handleFsReadTextFile(params, responder) {
  const parsed = acpReadTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid fs/read_text_file params");
    return;
  }
  try {
    const content = await fs4.readFile(parsed.data.path, "utf8");
    responder.result({
      content: sliceFileContent(content, parsed.data.line, parsed.data.limit)
    });
  } catch (error) {
    responder.error(
      -32603,
      error instanceof Error ? error.message : String(error)
    );
  }
}
async function handleFsWriteTextFile(session, params, responder) {
  const parsed = acpWriteTextFileParamsSchema.safeParse(params);
  if (!parsed.success) {
    responder.error(-32602, "Invalid fs/write_text_file params");
    return;
  }
  if (session.policy.permissionMode === "accept-edits" && !isPathInsideRoots(parsed.data.path, session.policy.workspaceWriteRoots)) {
    responder.error(
      -32e3,
      `File writes outside the workspace are denied by BB's accept-edits permission mode: ${parsed.data.path}`
    );
    return;
  }
  try {
    let oldText;
    try {
      oldText = await fs4.readFile(parsed.data.path, "utf8");
    } catch {
      oldText = void 0;
    }
    await fs4.mkdir(dirname2(parsed.data.path), { recursive: true });
    await fs4.writeFile(parsed.data.path, parsed.data.content, "utf8");
    emitForSession(session, ACP_FS_WRITE_METHOD, {
      threadId: session.bbThreadId,
      path: parsed.data.path,
      kind: oldText === void 0 ? "add" : "update",
      ...oldText === void 0 ? {} : { oldText },
      content: parsed.data.content
    });
    responder.result({});
  } catch (error) {
    responder.error(
      -32603,
      error instanceof Error ? error.message : String(error)
    );
  }
}
function liveSessionForThread(bbThreadId) {
  const session = sessionsByBbThreadId.get(bbThreadId);
  if (!session || session.stopping || session.providerThreadId === "") {
    return void 0;
  }
  return session;
}
function removeSession(session) {
  for (const controller of session.pendingToolCalls) controller.abort();
  if (sessionsByBbThreadId.get(session.bbThreadId) === session) {
    sessionsByBbThreadId.delete(session.bbThreadId);
  }
  if (bbThreadIdByProviderThreadId.get(session.providerThreadId) === session.bbThreadId) {
    bbThreadIdByProviderThreadId.delete(session.providerThreadId);
  }
}
async function releaseCursorMcpApproval(session) {
  const approval = session.cursorMcpApproval;
  session.cursorMcpApproval = void 0;
  if (!approval) {
    return;
  }
  try {
    await revokeCursorSessionMcpServer(approval);
  } catch (error) {
    process.stderr.write(
      `acp bridge: failed to remove Cursor session MCP approval for thread "${session.bbThreadId}": ${error instanceof Error ? error.message : String(error)}
`
    );
  }
}
function getSessionByProviderThreadId(providerThreadId) {
  const bbThreadId = bbThreadIdByProviderThreadId.get(providerThreadId);
  return bbThreadId ? sessionsByBbThreadId.get(bbThreadId) : void 0;
}
async function startAgentSession(request) {
  const params = request.params;
  const bbThreadId = params.threadId;
  const existing = sessionsByBbThreadId.get(bbThreadId);
  if (existing) {
    await stopSession(existing);
  }
  const dialect = resolveAcpDialect({
    ...params.dialectId === void 0 ? {} : { dialectId: params.dialectId },
    command: params.agent.command
  });
  const translator = createAcpDeltaTranslator({
    cwd: params.cwd,
    dialect
  });
  translator.configureInjectedTools(
    (params.dynamicTools ?? []).map((tool) => ({
      name: tool.name,
      ...tool.presentation === void 0 ? {} : { presentation: tool.presentation }
    }))
  );
  const deferredEmits = [];
  const emitStartNotification = (method, notificationParams, sessionId) => {
    deferredEmits.push({ method, params: notificationParams, sessionId });
  };
  const launch = await resolveAgentLaunchArgs(params);
  if (launch.warning) {
    emitStartNotification(ACP_WARNING_METHOD, {
      threadId: bbThreadId,
      summary: launch.warning
    });
  }
  const agentLabel = [params.agent.command, ...params.agent.args].join(" ");
  let session;
  const childEnv = {
    ...withoutBridgeRuntimeEnv(process.env),
    ...params.envVars,
    ...dialect.id === "opencode" ? { OPENCODE_CLIENT: "acp", OPENCODE_ENABLE_QUESTION_TOOL: "false" } : {}
  };
  const connection = createAcpAgentConnection({
    command: params.agent.command,
    args: launch.args,
    cwd: params.cwd,
    env: childEnv,
    recordThreadId: bbThreadId,
    onNotification: (method, notificationParams) => handleAgentNotification(session, method, notificationParams),
    onRequest: (method, requestParams, responder) => handleAgentRequest(session, method, requestParams, responder),
    onExit: (info) => {
      const wasCurrent = sessionsByBbThreadId.get(bbThreadId) === session;
      cancelPendingPermissions(session);
      if (!wasCurrent || session.stopping || session.providerThreadId === "") {
        removeSession(session);
        return;
      }
      void releaseCursorMcpApproval(session);
      emitSessionError(
        session,
        `ACP agent "${agentLabel}" exited unexpectedly${info.code !== null ? ` (code ${info.code})` : ""}${info.stderrTail ? `: ${info.stderrTail}` : ""}`
      );
      session.activePromptKind = null;
    }
  });
  session = {
    bbThreadId,
    construction: params,
    nativeConfig: { configOptions: void 0, models: void 0 },
    providerThreadId: "",
    cwd: params.cwd,
    dialect,
    translator,
    connection,
    supportsImageInput: false,
    supportsLoadSession: false,
    policy: {
      permissionMode: params.permissionMode,
      workspaceWriteRoots: params.workspaceWriteRoots
    },
    pendingInstructions: params.instructions,
    activePromptKind: null,
    compactionAgentMessage: "",
    queuedInputs: [],
    promptRequestPending: false,
    cancelRequested: false,
    restartAfterCancelError: false,
    loading: false,
    loadingSessionId: void 0,
    pendingLoadUsageUpdate: void 0,
    grokContextWindowSize: void 0,
    stopping: false,
    turnSettled: void 0,
    pendingPermissions: /* @__PURE__ */ new Set(),
    pendingToolCalls: /* @__PURE__ */ new Set(),
    cursorMcpApproval: void 0,
    deferStartEmit: emitStartNotification
  };
  sessionsByBbThreadId.set(bbThreadId, session);
  try {
    const initializeResult = await requestAcpInitialize(connection, {
      parameterizedModelPicker: params.parameterizedModelPicker,
      fsAccess: true
    });
    await authenticateAcpAgent({
      connection,
      env: childEnv,
      initializeResult
    });
    session.supportsImageInput = initializeResult.agentCapabilities?.promptCapabilities?.image ?? false;
    const supportsLoadSession = initializeResult.agentCapabilities?.loadSession ?? false;
    const supportsFork = initializeResult.agentCapabilities?.sessionCapabilities?.fork != null;
    if (request.kind === "fork" && !supportsFork) {
      throw new Error(
        `ACP agent "${agentLabel}" does not advertise session/fork support.`
      );
    }
    session.supportsLoadSession = supportsLoadSession;
    const mcpServers = await buildSessionMcpServers(params);
    const mcpServer = mcpServers[0];
    if (mcpServer) {
      session.cursorMcpApproval = await approveCursorSessionMcpServer({
        agentCommand: params.agent.command,
        config: mcpServer,
        cwd: params.cwd,
        env: childEnv
      });
      if (session.cursorMcpApproval?.installedByBb) {
        process.stderr.write(
          `acp bridge: installed Cursor session MCP approval for thread "${bbThreadId}"
`
        );
      }
    }
    let sessionId;
    let loadedConfigOptions;
    let loadedModels;
    let createdFreshSession = false;
    if (request.kind === "fork") {
      const forkedSession = await connection.request({
        method: "session/fork",
        params: {
          sessionId: request.sourceProviderThreadId,
          cwd: params.cwd,
          mcpServers
        },
        resultSchema: acpSessionForkResultSchema
      });
      if (forkedSession.sessionId === request.sourceProviderThreadId || getSessionByProviderThreadId(forkedSession.sessionId) !== void 0) {
        throw new Error(
          `ACP agent "${agentLabel}" returned an active session ID for session/fork.`
        );
      }
      sessionId = forkedSession.sessionId;
      loadedConfigOptions = forkedSession.configOptions;
      loadedModels = forkedSession.models;
      rememberGrokContextWindow(session, forkedSession.models);
    } else if (request.kind === "resume" && supportsLoadSession) {
      session.loading = true;
      session.loadingSessionId = request.resumeProviderThreadId;
      session.pendingLoadUsageUpdate = void 0;
      try {
        const configState = await connection.request({
          method: "session/load",
          params: {
            sessionId: request.resumeProviderThreadId,
            cwd: params.cwd,
            mcpServers
          },
          resultSchema: z44.union([acpConfigStateResultSchema, z44.null()])
        });
        loadedConfigOptions = configState?.configOptions;
        loadedModels = configState?.models;
        rememberGrokContextWindow(session, configState?.models);
        sessionId = request.resumeProviderThreadId;
      } catch {
        sessionId = void 0;
        session.loading = false;
        session.loadingSessionId = void 0;
        session.pendingLoadUsageUpdate = void 0;
      }
    }
    if (sessionId === void 0) {
      session.loading = false;
      session.loadingSessionId = void 0;
      session.pendingLoadUsageUpdate = void 0;
      const newSession = await connection.request({
        method: "session/new",
        params: { cwd: params.cwd, mcpServers },
        resultSchema: acpSessionNewResultSchema
      });
      sessionId = newSession.sessionId;
      createdFreshSession = true;
      rememberGrokContextWindow(session, newSession.models);
      session.nativeConfig = {
        configOptions: newSession.configOptions,
        models: newSession.models
      };
      await selectAcpNativeModel({
        session,
        sessionId,
        modelSelection: params.modelSelection,
        nativeReasoning: params.nativeReasoning
      });
      if (request.kind === "resume") {
        emitStartNotification(ACP_WARNING_METHOD, {
          threadId: bbThreadId,
          summary: `${agentLabel} could not restore the previous session; continuing in a fresh session without in-agent history.`
        });
      }
    } else {
      session.nativeConfig = {
        configOptions: loadedConfigOptions,
        models: loadedModels
      };
      await selectAcpNativeModel({
        session,
        sessionId,
        modelSelection: params.modelSelection,
        nativeReasoning: params.nativeReasoning
      });
      const loadUsageUpdate = session.pendingLoadUsageUpdate;
      session.loading = false;
      session.loadingSessionId = void 0;
      session.pendingLoadUsageUpdate = void 0;
      if (loadUsageUpdate) {
        emitStartNotification(ACP_UPDATE_METHOD, {
          threadId: session.bbThreadId,
          update: loadUsageUpdate
        });
      }
    }
    if (session.stopping) {
      throw new Error(
        `ACP session for thread "${bbThreadId}" was released during construction`
      );
    }
    session.providerThreadId = sessionId;
    bbThreadIdByProviderThreadId.set(sessionId, bbThreadId);
    sendNotification(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
      threadId: bbThreadId,
      providerThreadId: sessionId,
      sessionRestorable: session.supportsLoadSession
    });
    sendThreadDeltas(bbThreadId, [{ kind: "session.reset" }]);
    if (createdFreshSession) {
      emitGrokContextWindow(session, 0);
    }
    session.deferStartEmit = void 0;
    for (const deferred of deferredEmits) {
      if (deferred.sessionId !== void 0 && deferred.sessionId !== sessionId) {
        continue;
      }
      emitForSession(session, deferred.method, deferred.params);
    }
    deferredEmits.length = 0;
    return session;
  } catch (error) {
    session.stopping = true;
    session.deferStartEmit = void 0;
    await connection.kill();
    removeSession(session);
    await releaseCursorMcpApproval(session);
    throw error;
  }
}
async function stopSession(session) {
  if (session.stopping) {
    return;
  }
  session.stopping = true;
  dropQueuedTurnInputs(
    session,
    "ACP session stopped before the steer was sent"
  );
  cancelPendingPermissions(session);
  if (session.activePromptKind !== null && !session.connection.exited) {
    session.connection.notify("session/cancel", {
      sessionId: session.providerThreadId
    });
    if (session.turnSettled) {
      await Promise.race([
        session.turnSettled,
        new Promise(
          (resolveTimeout) => setTimeout(resolveTimeout, THREAD_STOP_CANCEL_TIMEOUT_MS)
        )
      ]);
    }
  }
  settleInterruptedPrompt(session);
  await session.connection.kill();
  removeSession(session);
  await releaseCursorMcpApproval(session);
}
function settleInterruptedPrompt(session) {
  switch (session.activePromptKind) {
    case "turn":
      finishTurn(session, "cancelled");
      return;
    case "compaction":
      finishCompaction(session, { status: "interrupted" });
      return;
    case null:
      return;
  }
}
async function releaseSession(session) {
  if (session.stopping) {
    return;
  }
  session.stopping = true;
  dropQueuedTurnInputs(
    session,
    "ACP session released before the steer was sent"
  );
  cancelPendingPermissions(session);
  await session.connection.kill();
  removeSession(session);
  await releaseCursorMcpApproval(session);
}
function requestSteerCancel(session) {
  if (session.stopping || session.cancelRequested || !session.promptRequestPending || session.connection.exited) {
    return;
  }
  session.cancelRequested = true;
  cancelPendingPermissions(session);
  session.connection.notify("session/cancel", {
    sessionId: session.providerThreadId
  });
}
function acceptTurnInput(session, pending) {
  sendThreadDeltas(session.bbThreadId, [
    { kind: "input.accepted", clientRequestId: pending.clientRequestId }
  ]);
  const requestId = takeTurnInputRequestId(pending);
  if (requestId !== null) {
    sendResult(requestId, { threadId: session.bbThreadId });
  }
}
function dropTurnInput(pending, reason) {
  const requestId = takeTurnInputRequestId(pending);
  if (requestId !== null) {
    sendError(requestId, -32e3, reason);
  }
}
function takeTurnInputRequestId(pending) {
  const requestId = pending.requestId;
  pending.requestId = null;
  return requestId;
}
function dropQueuedTurnInputs(session, reason) {
  for (const pending of session.queuedInputs.splice(0)) {
    dropTurnInput(pending, reason);
  }
}
function finishTurn(session, stopReason) {
  if (session.activePromptKind !== "turn") {
    return;
  }
  for (const controller of session.pendingToolCalls) controller.abort();
  session.activePromptKind = null;
  dropQueuedTurnInputs(session, "ACP turn ended before the steer was sent");
  session.promptRequestPending = false;
  session.cancelRequested = false;
  emitForSession(session, ACP_TURN_COMPLETED_METHOD, {
    threadId: session.bbThreadId,
    stopReason
  });
}
function runTurn(session, firstInput) {
  session.activePromptKind = "turn";
  emitForSession(session, ACP_TURN_STARTED_METHOD, {
    threadId: session.bbThreadId
  });
  session.turnSettled = (async () => {
    let pending = firstInput;
    for (; ; ) {
      if (session.stopping) {
        dropTurnInput(pending, "ACP session is stopping");
        finishTurn(session, "cancelled");
        return;
      }
      let stopReason;
      session.cancelRequested = false;
      try {
        const previousSession = session;
        const reconciled = reconcileExecutionSettings(session, pending.options);
        session = reconciled instanceof Promise ? await reconciled : reconciled;
        if (session.stopping) {
          dropTurnInput(pending, "ACP session is stopping");
          finishTurn(session, "cancelled");
          return;
        }
        session.activePromptKind = "turn";
        session.turnSettled = previousSession.turnSettled;
        if (session !== previousSession) {
          emitForSession(session, ACP_TURN_STARTED_METHOD, {
            threadId: session.bbThreadId
          });
        }
        session.promptRequestPending = true;
        const promptResult = session.connection.request({
          method: "session/prompt",
          params: {
            sessionId: session.providerThreadId,
            prompt: buildPromptContentBlocks(session, pending.input)
          },
          resultSchema: acpPromptResultSchema
        });
        acceptTurnInput(session, pending);
        if (session.queuedInputs.length > 0) {
          requestSteerCancel(session);
        }
        const result = await promptResult;
        stopReason = result.stopReason;
        const grokUsage = grokContextUsageFromPromptResult(result);
        if (grokUsage !== void 0) {
          emitGrokContextWindow(session, grokUsage.used);
        }
      } catch (error) {
        session.restartAfterCancelError = session.cancelRequested;
        session.promptRequestPending = false;
        dropTurnInput(pending, "ACP turn failed before the prompt was sent");
        dropQueuedTurnInputs(
          session,
          "ACP turn failed before the steer was sent"
        );
        session.cancelRequested = false;
        if (!session.stopping) {
          const message = error instanceof Error ? error.message : String(error);
          if (!session.connection.exited) {
            emitSessionError(session, message);
          } else if (session.activePromptKind === "turn") {
            emitForSession(session, "error", {
              threadId: session.bbThreadId,
              message
            });
          }
        }
        session.activePromptKind = null;
        return;
      }
      session.promptRequestPending = false;
      if (!session.stopping) {
        const next = session.queuedInputs.shift();
        if (next) {
          pending = next;
          continue;
        }
      }
      finishTurn(session, stopReason);
      return;
    }
  })();
}
function reconcileExecutionSettings(session, options) {
  if (options.permissionMode === "auto") {
    throw new Error('ACP does not support permission mode "auto".');
  }
  const launchSpec = decodeLaunchSpec(options.providerOptions);
  const envVars = Object.keys(options.envVars ?? {}).length > 0 ? {
    ...launchSpec?.env ?? {},
    ...options.envVars
  } : session.construction.envVars;
  const workspaceWriteRoots = options.providerOptions?.additionalWorkspaceWriteRoots !== void 0 ? [
    session.cwd,
    ...decodeAdditionalWorkspaceWriteRoots(options.providerOptions)
  ] : session.policy.workspaceWriteRoots;
  const modelParams = launchSpec === null ? session.construction : buildAcpModelSelectionParams(
    launchSpec,
    options,
    decodeAcpModelPickerOptions(options.providerOptions).parameterizedModelPicker,
    decodeDialectId(options.providerOptions)
  );
  const construction = {
    ...session.construction,
    modelSelection: modelParams.modelSelection,
    launchReasoningLevel: modelParams.launchReasoningLevel,
    envVars,
    permissionMode: options.permissionMode,
    workspaceWriteRoots
  };
  const launchArgsChanged = !isDeepStrictEqual(
    permissionCliArgsForMode(
      session.construction.permissionCli,
      session.construction.permissionMode
    ),
    permissionCliArgsForMode(
      construction.permissionCli,
      construction.permissionMode
    )
  ) || !isDeepStrictEqual(
    launchModelSelection(session.construction),
    launchModelSelection(construction)
  );
  const restart = session.connection.exited || session.restartAfterCancelError || launchArgsChanged || !isDeepStrictEqual(envVars ?? {}, session.construction.envVars ?? {});
  cancelPendingPermissions(session);
  session.policy = {
    permissionMode: options.permissionMode,
    workspaceWriteRoots
  };
  if (restart) {
    return rebuildAgentSession(session, construction);
  }
  if (isDeepStrictEqual(
    construction.modelSelection,
    session.construction.modelSelection
  ) && !acpNativeModelDrifted(session.nativeConfig, construction.modelSelection)) {
    session.construction = construction;
    return session;
  }
  return applyNativeModelSelection(session, construction);
}
function launchModelSelection(params) {
  return {
    modelSelection: params.modelSelection && "selectFlag" in params.modelSelection ? params.modelSelection : void 0,
    launchReasoningLevel: params.launchReasoningLevel
  };
}
async function applyNativeModelSelection(session, construction) {
  await selectAcpNativeModel({
    session,
    sessionId: session.providerThreadId,
    modelSelection: construction.modelSelection,
    nativeReasoning: construction.nativeReasoning
  });
  session.construction = construction;
  return session;
}
async function rebuildAgentSession(session, construction) {
  const previousProviderThreadId = session.providerThreadId;
  const reason = session.connection.exited ? "The ACP agent exited unexpectedly; its session was rebuilt before continuing." : session.restartAfterCancelError ? "The ACP agent failed during cancellation; its session was rebuilt before continuing." : "Execution settings changed; the ACP session was rebuilt to apply them.";
  const queuedInputs = session.queuedInputs.splice(0);
  const continuingTurn = session.activePromptKind === "turn";
  finishTurn(session, "cancelled");
  let replacement;
  try {
    replacement = await startAgentSession({
      kind: "resume",
      params: construction,
      resumeProviderThreadId: previousProviderThreadId
    });
  } catch (error) {
    if (continuingTurn) {
      emitSessionError(
        session,
        error instanceof Error ? error.message : String(error)
      );
    }
    throw error;
  }
  replacement.queuedInputs.push(...queuedInputs);
  sendNotification(BRIDGE_NOTIFICATION_METHODS.sessionReplaced, {
    threadId: session.bbThreadId,
    providerThreadId: replacement.providerThreadId,
    reason,
    contextLost: replacement.providerThreadId !== previousProviderThreadId
  });
  return replacement;
}
function startCompaction(session, pending) {
  session.activePromptKind = "compaction";
  session.compactionAgentMessage = "";
  emitForSession(session, ACP_COMPACTION_STARTED_METHOD, {
    threadId: session.bbThreadId
  });
  const finish = (outcome) => {
    finishCompaction(session, outcome);
  };
  const promptResult = session.connection.request({
    method: "session/prompt",
    params: {
      sessionId: session.providerThreadId,
      prompt: [{ type: "text", text: "/compact" }]
    },
    resultSchema: acpPromptResultSchema
  });
  acceptTurnInput(session, pending);
  session.turnSettled = promptResult.then((result) => {
    const grokUsage = grokContextUsageFromPromptResult(result);
    if (grokUsage !== void 0) {
      emitGrokContextWindow(session, grokUsage.used);
    }
    finish(
      result.stopReason === "end_turn" ? compactionOutcomeForEndTurn(
        session.dialect,
        session.compactionAgentMessage
      ) : result.stopReason === "cancelled" ? { status: "interrupted" } : {
        status: "failed",
        error: `Agent stopped compaction: ${result.stopReason}`
      }
    );
  }).catch((error) => {
    finish({
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    });
  });
}
function finishCompaction(session, outcome) {
  if (session.activePromptKind !== "compaction") {
    return;
  }
  emitForSession(session, ACP_COMPACTION_COMPLETED_METHOD, {
    threadId: session.bbThreadId,
    ...outcome
  });
  session.activePromptKind = null;
  session.turnSettled = void 0;
}
function handleAgentRequest(session, method, params, responder) {
  switch (method) {
    case "session/request_permission":
      handlePermissionRequest(session, params, responder);
      return;
    case "fs/read_text_file":
      void handleFsReadTextFile(params, responder);
      return;
    case "fs/write_text_file":
      void handleFsWriteTextFile(session, params, responder);
      return;
    default:
      handleDialectRequest(session, method, params, responder);
  }
}
function handleDialectRequest(session, method, params, responder) {
  const outcome = session.dialect.handleClientRequest?.(method, params);
  if (outcome === void 0) {
    responder.error(-32601, `Unsupported ACP client method "${method}"`);
    return;
  }
  if (outcome.delegation !== void 0) {
    sendThreadDeltas(
      session.bbThreadId,
      session.translator.noteDelegationReport(
        session.bbThreadId,
        outcome.delegation
      )
    );
  }
  responder.result(outcome.result);
}
function handleAgentNotification(session, method, params) {
  if (method !== "session/update") {
    return;
  }
  if (session.stopping) {
    return;
  }
  const parsed = acpSessionNotificationParamsSchema.safeParse(params);
  if (!parsed.success) {
    return;
  }
  if (session.loading) {
    if (parsed.data.sessionId === session.loadingSessionId && parsed.data.update.sessionUpdate === "usage_update") {
      const usageUpdate = acpUsageUpdateSchema.safeParse(parsed.data.update);
      if (usageUpdate.success) {
        session.pendingLoadUsageUpdate = usageUpdate.data;
      }
    }
    return;
  }
  const update = {
    threadId: session.bbThreadId,
    update: parsed.data.update
  };
  if (session.providerThreadId === "") {
    session.deferStartEmit?.(ACP_UPDATE_METHOD, update, parsed.data.sessionId);
    return;
  }
  if (parsed.data.sessionId !== session.providerThreadId) {
    return;
  }
  if (parsed.data.update.sessionUpdate === "config_option_update") {
    const configState = acpConfigStateResultSchema.safeParse(
      parsed.data.update
    );
    if (configState.success && configState.data.configOptions) {
      session.nativeConfig = {
        ...session.nativeConfig,
        configOptions: configState.data.configOptions
      };
    }
  }
  if (session.activePromptKind === "compaction") {
    const chunk = acpAgentMessageChunkUpdateSchema.safeParse(
      parsed.data.update
    );
    if (chunk.success) {
      session.compactionAgentMessage += extractAcpContentText(chunk.data.content) ?? "";
    }
  }
  emitForSession(session, ACP_UPDATE_METHOD, update);
}
function decodeAcpBridgeJsonRpcRequest(raw) {
  const envelope = bridgeRequestEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    return { kind: "ignored" };
  }
  const command = acpBridgeCommandSchema.safeParse({
    method: envelope.data.method,
    params: envelope.data.params ?? {}
  });
  if (command.success) {
    return {
      kind: "request",
      request: { ...command.data, id: envelope.data.id }
    };
  }
  if (!acpBridgeCommandMethodValues.includes(
    envelope.data.method
  )) {
    return {
      kind: "unknown-method",
      id: envelope.data.id,
      method: envelope.data.method
    };
  }
  return {
    kind: "invalid-params",
    id: envelope.data.id,
    method: envelope.data.method,
    issues: command.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
  };
}
async function handleModelList(id, params, dialectId) {
  function sendModels(models) {
    sendResult(
      id,
      splitPrimaryModels(
        applyConfiguredReasoningToModels(models, {
          reasoningCli: params.reasoningCli,
          nativeReasoning: params.nativeReasoning
        }),
        params.primaryModels
      )
    );
  }
  const catalog = params.listCommand ? await loadAgentModelCatalog(params.listCommand) : null;
  if (catalog) {
    sendModels(
      params.parameterizedModelPicker && dialectId === "cursor" ? buildCursorParameterizedModelCatalog(catalog.models) : catalog.models
    );
    return;
  }
  const sessionDiscoveredModels = params.listCommand === void 0 && params.agent ? await loadSessionDiscoveredModels(
    params.agent,
    params.reasoningProbePriorityModelIds,
    params.parameterizedModelPicker
  ) : null;
  if (sessionDiscoveredModels) {
    sendModels(sessionDiscoveredModels);
    return;
  }
  sendResult(id, {
    models: [
      applyConfiguredReasoningToModel(ACP_DEFAULT_MODEL, {
        reasoningCli: params.reasoningCli,
        nativeReasoning: params.nativeReasoning
      })
    ],
    selectedOnlyModels: []
  });
}
function decodeLaunchSpec(providerOptions) {
  const launchSpec = acpLaunchSpecSchema.safeParse(
    providerOptions?.["acpLaunchSpec"]
  );
  return launchSpec.success ? launchSpec.data : null;
}
var acpProviderOptionsSchema = z44.object({
  additionalWorkspaceWriteRoots: z44.array(z44.string()).optional(),
  acpDialect: z44.string().min(1).optional(),
  parameterizedModelPicker: z44.boolean().optional(),
  primaryModels: z44.array(z44.string().min(1)).optional(),
  reasoningProbePriorityModelIds: z44.array(z44.string().min(1)).optional()
}).passthrough();
function decodeAcpModelPickerOptions(providerOptions) {
  const parsed = acpProviderOptionsSchema.parse(providerOptions ?? {});
  return {
    parameterizedModelPicker: parsed.parameterizedModelPicker === true,
    ...parsed.primaryModels === void 0 ? {} : { primaryModels: [...parsed.primaryModels] },
    reasoningProbePriorityModelIds: [
      ...parsed.reasoningProbePriorityModelIds ?? []
    ]
  };
}
function decodeAdditionalWorkspaceWriteRoots(providerOptions) {
  return acpProviderOptionsSchema.parse(providerOptions ?? {}).additionalWorkspaceWriteRoots ?? [];
}
function decodeDialectId(providerOptions) {
  return acpProviderOptionsSchema.parse(providerOptions ?? {}).acpDialect;
}
function maintenanceTarget(providerOptions) {
  const launchSpec = decodeLaunchSpec(providerOptions);
  const dialect = resolveAcpDialect({
    dialectId: decodeDialectId(providerOptions),
    command: launchSpec?.command ?? ""
  });
  return {
    maintenance: dialect.maintenance,
    command: launchSpec?.command ?? null,
    dialectId: dialect.id,
    env: { ...process.env, ...launchSpec?.env }
  };
}
async function handleRequest2(request) {
  switch (request.method) {
    case "initialize":
      const result = {
        ok: true,
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: {
          sessionRestore: false,
          threadArchive: false,
          threadRename: false,
          threadGoalClear: false,
          fork: "tip",
          approvalEnforcedBy: "runtime",
          grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
          steerMode: "queue",
          skills: { configure: true }
        }
      };
      sendResult(request.id, result);
      return;
    case "model/list": {
      const modelPicker = decodeAcpModelPickerOptions(
        request.params.providerOptions
      );
      await handleModelList(
        request.id,
        buildAcpModelListParams(
          decodeLaunchSpec(request.params.providerOptions),
          modelPicker
        ),
        decodeDialectId(request.params.providerOptions)
      );
      return;
    }
    case "provider/health":
      sendResult(
        request.id,
        await getAcpProviderHealth(
          maintenanceTarget(request.params.providerOptions)
        )
      );
      return;
    case "provider/usage":
      sendResult(
        request.id,
        await getAcpProviderUsage(
          maintenanceTarget(request.params.providerOptions)
        )
      );
      return;
    case "provider/installation/status":
      sendResult(
        request.id,
        await getAcpProviderInstallationStatus(
          maintenanceTarget(request.params.providerOptions)
        )
      );
      return;
    case "provider/installation/run":
      sendResult(
        request.id,
        await getAcpProviderInstallationRun({
          ...maintenanceTarget(request.params.providerOptions),
          action: request.params.action
        })
      );
      return;
    case "thread/start":
    case "thread/resume":
    case "thread/fork": {
      if (request.method === "thread/fork" && request.params.sourceProviderCheckpointId !== void 0) {
        sendError(
          request.id,
          BRIDGE_JSON_RPC_ERRORS.FORK_CHECKPOINT_UNSUPPORTED,
          "ACP session/fork cannot fork at a checkpoint; only tip forks are supported"
        );
        return;
      }
      const params = request.params;
      const launchSpec = decodeLaunchSpec(params.options.providerOptions);
      if (launchSpec === null) {
        sendError(
          request.id,
          BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
          `Invalid params for "${request.method}": options.providerOptions.acpLaunchSpec is required by the ACP bridge`
        );
        return;
      }
      const modelPicker = decodeAcpModelPickerOptions(
        params.options.providerOptions
      );
      const sessionParams = buildAcpSessionParams({
        additionalWorkspaceWriteRoots: decodeAdditionalWorkspaceWriteRoots(
          params.options.providerOptions
        ),
        dialectId: decodeDialectId(params.options.providerOptions),
        cwd: params.cwd,
        dynamicTools: params.dynamicTools,
        options: {
          ...params.options,
          skillRoots: configuredSkillRoots ?? void 0
        },
        parameterizedModelPicker: modelPicker.parameterizedModelPicker,
        launchSpec,
        providerLabel: launchSpec.displayName,
        threadId: params.threadId
      });
      const session = await startAgentSession(
        request.method === "thread/resume" ? {
          kind: "resume",
          params: sessionParams,
          resumeProviderThreadId: request.params.providerThreadId
        } : request.method === "thread/fork" ? {
          kind: "fork",
          params: sessionParams,
          sourceProviderThreadId: request.params.sourceProviderThreadId
        } : { kind: "start", params: sessionParams }
      );
      sendResult(request.id, {
        providerThreadId: session.providerThreadId,
        sessionRestorable: session.supportsLoadSession
      });
      return;
    }
    case "turn/start": {
      const params = request.params;
      let session = liveSessionForThread(params.threadId);
      if (session === void 0) {
        sendError(request.id, -32e3, "No active ACP session");
        return;
      }
      if (session.activePromptKind !== null) {
        sendError(request.id, -32e3, "A turn is already active");
        return;
      }
      const reconciled = reconcileExecutionSettings(session, params.options);
      session = reconciled instanceof Promise ? await reconciled : reconciled;
      const pending = {
        clientRequestId: params.clientRequestId,
        input: params.input,
        requestId: request.id,
        options: params.options
      };
      if (isStandaloneBuiltinCompactCommand(params.input)) {
        startCompaction(session, pending);
      } else {
        runTurn(session, pending);
      }
      return;
    }
    case "turn/steer": {
      const params = request.params;
      const session = liveSessionForThread(params.threadId);
      if (session === void 0) {
        sendError(request.id, -32e3, "No active ACP session");
        return;
      }
      if (session.activePromptKind !== "turn") {
        const message = "No active turn to steer";
        sendError(request.id, BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN, message, {
          recovery: { kind: "staleTurn", message, retryable: false }
        });
        return;
      }
      session.queuedInputs.push({
        clientRequestId: params.clientRequestId,
        input: params.input,
        requestId: null,
        options: params.options
      });
      requestSteerCancel(session);
      sendResult(request.id, { threadId: params.threadId });
      return;
    }
    case "thread/stop": {
      const session = sessionsByBbThreadId.get(request.params.threadId);
      if (session) {
        if (request.params.intent === "release") {
          await releaseSession(session);
        } else {
          await stopSession(session);
        }
      }
      sendResult(request.id, { ok: true });
      return;
    }
    case "thread/discard":
      sendResult(request.id, { ok: true });
      return;
    case "skills/configure":
      configuredSkillRoots = request.params.roots.map((root) => ({
        id: root.id,
        skillDirectoryRootPath: root.path,
        skills: root.skills.map((skill) => ({
          name: skill.name,
          description: skill.description
        }))
      }));
      sendResult(request.id, { ok: true });
      return;
  }
}
function handleParsedMessage(parsed) {
  const response = decodeBridgeJsonRpcResponse(parsed);
  if (response && typeof response.id === "number") {
    const pending = pendingRuntimeRequests.get(response.id);
    if (pending) {
      pendingRuntimeRequests.delete(response.id);
      pending(response);
      return;
    }
  }
  const decoded = decodeAcpBridgeJsonRpcRequest(parsed);
  if (decoded.kind === "ignored") {
    return;
  }
  if (decoded.kind === "unknown-method") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND,
      `Unknown method "${decoded.method}"`
    );
    return;
  }
  if (decoded.kind === "invalid-params") {
    sendError(
      decoded.id,
      BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS,
      `Invalid params for "${decoded.method}": ${decoded.issues}`
    );
    return;
  }
  runBridgeRequest({
    request: decoded.request,
    handleRequest: (request) => handleRequest2(request).catch((error) => {
      throw withAcpAuthRequiredRecovery(error);
    }),
    sendError
  });
}
var handleLine = createBridgeLineHandler({ handleParsedMessage });
async function stopAllSessions() {
  await Promise.all(
    Array.from(sessionsByBbThreadId.values()).map(
      (session) => stopSession(session)
    )
  );
  const dynamicToolBridge = dynamicToolBridgePromise ? await dynamicToolBridgePromise.catch(() => null) : null;
  await new Promise((resolveClose) => {
    if (!dynamicToolBridge) {
      resolveClose();
      return;
    }
    dynamicToolBridge.server.close(() => resolveClose());
  });
}
if (process.argv.includes("--mcp-stdio")) {
  runAcpDynamicToolMcpServer();
}
var experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  onClose: () => {
    void stopAllSessions().finally(() => {
      process.exit(0);
    });
  }
});

// ../provider-bridge-acp/src/probe.ts
import { z as z45 } from "zod";
var PROBE_TIMEOUT_MS = 1e4;
function describe(error) {
  if (error instanceof AcpAgentExitedError) {
    return `the agent exited before it answered initialize: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
async function probeAcpAgent(request) {
  const timeoutMs = request.timeoutMs ?? PROBE_TIMEOUT_MS;
  let connection;
  try {
    connection = createAcpAgentConnection({
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      env: withoutBridgeRuntimeEnv({ ...process.env, ...request.env ?? {} }),
      recordThreadId: null,
      onNotification: () => {
      },
      onRequest: (_method, _params, responder) => {
        responder.error(-32601, "bb is probing this agent's capabilities");
      },
      onExit: () => {
      }
    });
  } catch (error) {
    return { reachable: false, reason: describe(error) };
  }
  const connected = connection;
  const timeout = new Promise((_resolve, reject) => {
    setTimeout(
      () => reject(
        new Error(
          `the agent did not answer initialize within ${timeoutMs}ms`
        )
      ),
      timeoutMs
    ).unref?.();
  });
  try {
    const result = await Promise.race([
      requestAcpInitialize(connected, {
        parameterizedModelPicker: false,
        fsAccess: true
      }),
      timeout
    ]);
    return {
      reachable: true,
      fork: result.agentCapabilities?.sessionCapabilities?.fork != null
    };
  } catch (error) {
    return { reachable: false, reason: describe(error) };
  } finally {
    connected.kill();
  }
}
var acpAgentProbeSchema = z45.union([
  z45.object({ reachable: z45.literal(true), fork: z45.boolean() }),
  z45.object({ reachable: z45.literal(false), reason: z45.string() })
]);
export {
  acpAgentProbeSchema as experimental_acpAgentProbeSchema,
  acpLaunchSpecSchema as experimental_acpLaunchSpecSchema,
  experimental_providerBridge as experimental_acpProviderBridge,
  probeAcpAgent as experimental_probeAcpAgent
};
