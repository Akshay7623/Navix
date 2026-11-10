"use strict";
// The ID Chromium gives an unpacked extension loaded from `extPath`.
//
// The tests must pick this extension's service worker by ID. Matching on the
// file name alone is not enough: Edge 157 ships a built-in extension whose
// worker is also called background.js and is often listed first.
//
// Chromium hashes the absolute path (UTF-16LE on Windows, with an upper-case
// drive letter) with SHA-256, keeps the first 16 bytes and spells each hex
// digit as a letter from a to p.
const crypto = require("crypto");

module.exports = function extensionIdForPath(extPath) {
  const isWin = process.platform === "win32";
  const normalized = isWin ? extPath.replace(/^[a-z]:/, (d) => d.toUpperCase()) : extPath;
  const bytes = Buffer.from(normalized, isWin ? "utf16le" : "utf8");
  return crypto
    .createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 32)
    .replace(/./g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
};
