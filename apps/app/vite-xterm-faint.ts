import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

const replacements = {
  "xterm.js": {
    version: "6.1.0-beta.292",
    search: "const n=this._getContrastCache(s);let a;",
    replacement:
      "if(s.isDim()){const n=l.color.blend(t,l.color.multiplyOpacity(o??i,.5)),a=l.color.ensureContrastRatio(t,n,4.5)??n;return this._addStyle(e,`color:${a.css}`),!0}const n=this._getContrastCache(s);let a;",
  },
  "xterm.mjs": {
    version: "6.1.0-beta.292",
    search: "let a=this._getContrastCache(r),l;",
    replacement:
      "if(r.isDim()){let a=k.blend(e,k.multiplyOpacity(o??t,.5)),l=k.ensureContrastRatio(e,a,4.5)??a;return this._addStyle(i,`color:${l.css}`),!0}let a=this._getContrastCache(r),l;",
  },
  "addon-webgl.js": {
    version: "0.20.0-beta.291",
    search:
      "Q=o.rgba.ensureContrastRatio(c,_,this._config.minimumContrastRatio/(L?2:1))",
    replacement:
      "Q=L?(o.rgba.ensureContrastRatio(c,o.rgba.blend(c,16777215<<8&_|128),4.5)??o.rgba.blend(c,16777215<<8&_|128)):o.rgba.ensureContrastRatio(c,_,this._config.minimumContrastRatio)",
  },
  "addon-webgl.mjs": {
    version: "0.20.0-beta.291",
    search:
      "u=d0.ensureContrastRatio(p,c,this._config.minimumContrastRatio/(T?2:1))",
    replacement:
      "u=T?(d0.ensureContrastRatio(p,d0.blend(p,16777215<<8&c|128),4.5)??d0.blend(p,16777215<<8&c|128)):d0.ensureContrastRatio(p,c,this._config.minimumContrastRatio)",
  },
};

export function rewriteXtermFaint(
  source: string,
  file: keyof typeof replacements,
  version: string,
): string {
  const rule = replacements[file];
  const matches = source.split(rule.search).length - 1;
  if (version !== rule.version || matches !== 1) {
    throw new Error(
      `xterm faint rewrite must be re-derived or dropped: ${file} version=${version} expected=${rule.version}, matches=${matches}`,
    );
  }
  return source.replace(rule.search, rule.replacement);
}

export function xtermFaintContrast(): Plugin {
  return {
    name: "bb:xterm-faint-contrast",
    enforce: "pre",
    config: () => ({
      optimizeDeps: { exclude: ["@xterm/xterm", "@xterm/addon-webgl"] },
    }),
    transform(source, id) {
      const match = id.match(
        /\/node_modules\/@xterm\/(xterm|addon-webgl)\/lib\/(xterm|addon-webgl)\.(js|mjs)$/,
      );
      if (!match || match[1] !== match[2]) return;
      const file = `${match[2]}.${match[3]}` as keyof typeof replacements;
      const manifest: unknown = JSON.parse(
        readFileSync(resolve(id, "../../package.json"), "utf8"),
      );
      if (
        !manifest ||
        typeof manifest !== "object" ||
        !("version" in manifest) ||
        typeof manifest.version !== "string"
      ) {
        throw new Error(
          "xterm faint rewrite must be re-derived or dropped: missing version",
        );
      }
      return {
        code: rewriteXtermFaint(source, file, manifest.version),
        map: null,
      };
    },
  };
}
