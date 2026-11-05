const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const DEFAULT_APP_ID = "dev.bb.desktop";

function stableDesignatedRequirement(appId = DEFAULT_APP_ID) {
  return `designated => identifier "${appId}"`;
}

function isAdhocSignature(output) {
  return (
    /(?:^|\n)Signature=adhoc(?:\n|$)/u.test(output) ||
    output.includes("code object is not signed")
  );
}

async function codesignOutput(appPath) {
  try {
    const result = await execFileAsync("codesign", [
      "-dv",
      "--verbose=4",
      appPath,
    ]);
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  }
}

async function designatedRequirementOutput(appPath) {
  try {
    const result = await execFileAsync("codesign", ["-dr", "-", appPath]);
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  } catch (error) {
    return `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`;
  }
}

async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);
  const signature = await codesignOutput(appPath);

  if (!isAdhocSignature(signature)) return;

  const appId = context.packager.appInfo.id || DEFAULT_APP_ID;
  const requirement = stableDesignatedRequirement(appId);
  await execFileAsync("codesign", [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--identifier",
    appId,
    `-r=${requirement}`,
    appPath,
  ]);

  const verified = await designatedRequirementOutput(appPath);
  if (!verified.includes(requirement)) {
    throw new Error(
      `Stable macOS signing requirement was not applied to ${appPath}`,
    );
  }
}

module.exports = afterSign;
module.exports.stableDesignatedRequirement = stableDesignatedRequirement;
module.exports.isAdhocSignature = isAdhocSignature;
