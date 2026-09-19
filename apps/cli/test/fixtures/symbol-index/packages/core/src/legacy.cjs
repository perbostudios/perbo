const { join } = require("node:path");
const missing = require("./not-here.js");

function describe(shape) {
  return join("shapes", shape.kind, String(missing));
}

module.exports = { describe, VERSION: "0" };
exports.legacyOnly = true;
